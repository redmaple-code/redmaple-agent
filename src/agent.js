import { Agent, runToolCall } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from './store.js';
import { AgentBaseError, clone, fingerprint, estimateTokens, textResult, checkSignal } from './shared.js';
import { compactContext } from './context.js';
import { isContextOverflow, summarizeHistory } from './compaction.js';

const DEFAULT_LIMITS = { modelCalls: 16, toolCalls: 64, tokens: 120000, seconds: 300 };
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function userMessage(input) {
  if (typeof input === 'string' && input.trim()) {
    return { role: 'user', content: [{ type: 'text', text: input }], timestamp: Date.now() };
  }
  if (input?.role === 'user' && Array.isArray(input.content) && input.content.length) return clone(input);
  throw new AgentBaseError('invalid_input', 'Provide a nonempty string or a Pi user message');
}

function failedMessage(model, error, aborted = false) {
  return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: clone(ZERO_USAGE), stopReason: aborted ? 'aborted' : 'error',
    errorMessage: error.message || String(error), timestamp: Date.now() };
}

function callResultMessage(call, result) {
  return { role: 'toolResult', toolCallId: call.id, toolName: call.name,
    content: result.content || [], details: result.details, isError: result.isError === true,
    timestamp: Date.now() };
}

function tokenUsage(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : fallback;
}

function costUsage(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export class AgentBase {
  static async create(options) {
    if (!options?.model || typeof options.streamFn !== 'function') {
      throw new AgentBaseError('configuration_required', 'Provide a model and streamFn');
    }
    const base = new AgentBase(options);
    try { await base.initialize(); }
    catch (error) { await base.close(); throw error; }
    return base;
  }

  constructor(options) {
    this.options = options;
    this.store = options.store || new MemoryStore();
    this.plugins = options.plugins || [];
    this.listeners = new Set();
    this.active = null;
    this.closed = false;
    this.registry = new Map();
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!(key in DEFAULT_LIMITS) || !Number.isFinite(value) || value <= 0) {
        throw new AgentBaseError('invalid_limits', `Invalid run limit ${key}`);
      }
      if (key !== 'seconds' && !Number.isInteger(value)) throw new AgentBaseError('invalid_limits', `${key} must be an integer`);
      if (key === 'seconds' && value * 1000 > 2147483647) throw new AgentBaseError('invalid_limits', 'Time budget exceeds the supported timer range');
    }
    this.maxOutputTokens = options.maxOutputTokens ?? Math.min(options.model.maxTokens || 2048, 2048);
    if (!Number.isInteger(this.maxOutputTokens) || this.maxOutputTokens <= 0
      || (options.model.maxTokens && this.maxOutputTokens > options.model.maxTokens)) {
      throw new AgentBaseError('invalid_output_limit', 'Output reservation exceeds the configured model capacity');
    }
    this.contextPolicy = options.context === false ? null : {
      maxInputTokens: Math.floor(((options.model.contextWindow || 32768) - this.maxOutputTokens) * 0.75),
      keepRecentExchanges: 3, ...options.context,
    };
    this.maxTools = options.maxTools ?? 8;
    if (!Number.isInteger(this.maxTools) || this.maxTools < 1) {
      throw new AgentBaseError('invalid_tool_limit', 'maxTools must be a positive integer');
    }
    for (const tool of [...(options.tools || []), ...this.plugins.flatMap(plugin => plugin.tools || [])]) {
      if (!tool.name || this.registry.has(tool.name) || typeof tool.execute !== 'function' || !tool.parameters) {
        throw new AgentBaseError('invalid_tool', `Missing, duplicate or invalid tool ${tool.name}`);
      }
      this.registry.set(tool.name, tool);
    }
    this.discovery = this.registry.size > this.maxTools;
    if (this.discovery && (options.discoverTools === false || this.maxTools < 3)) {
      throw new AgentBaseError('tool_capacity', 'Enable discovery with at least three tool slots, or select fewer tools');
    }
    if (this.discovery) {
      for (const tool of this.discoveryTools()) {
        if (this.registry.has(tool.name)) throw new AgentBaseError('duplicate_tool', tool.name);
        this.registry.set(tool.name, tool);
      }
    }
    this.wrappedTools = new Map([...this.registry].map(([name, tool]) => [name, {
      ...tool, execute: (id, args, signal, update) => this.executeTool(tool, id, args, signal, update),
    }]));
  }

  async initialize() {
    const prompt = [this.options.systemPrompt || 'Complete the user task using available tools. Report failures accurately.',
      ...this.plugins.map(plugin => plugin.systemPrompt || '')].filter(Boolean).join('\n\n');
    const identity = fingerprint({ version: 1, model: { id: this.options.model.id,
      provider: this.options.model.provider, baseUrl: this.options.model.baseUrl }, prompt,
      profileVersion: this.options.profileVersion || '1',
      plugins: this.plugins.map(plugin => ({ id: plugin.id, version: plugin.version || '1' })),
      tools: [...this.registry.values()].map(tool => ({ name: tool.name, version: tool.version || '1',
        description: tool.sessionIdentity?.description || tool.description,
        parameters: tool.sessionIdentity?.parameters || tool.parameters, replay: tool.replay || 'never',
        executionMode: tool.executionMode || 'parallel' })) });
    await this.store.update(state => {
      if (state.identity && state.identity !== identity) {
        throw new AgentBaseError('session_incompatible', 'Model, prompt or tool versions changed. Start a new session');
      }
      state.identity = identity;
      for (const call of Object.values(state.calls)) {
        if (call.status === 'pending') call.status = 'unknown';
      }
      for (const run of Object.values(state.runs)) {
        if (run.status === 'running') run.status = run.cancelRequested ? 'cancelled' : 'interrupted';
      }
    });
    const saved = this.store.snapshot();
    const activeNames = saved.activeTools || (this.discovery ? ['search_tools', 'load_tools'] : [...this.registry.keys()]);
    this.agent = new Agent({
      initialState: { model: this.options.model, systemPrompt: prompt, messages: saved.messages,
        tools: this.toolsFor(activeNames), thinkingLevel: this.options.thinkingLevel || 'off' },
      streamFn: (model, context, options) => this.modelStream(model, context, options),
      toolExecution: this.options.toolExecution || 'parallel',
      steeringMode: this.options.steeringMode || 'one-at-a-time',
      followUpMode: this.options.followUpMode || 'one-at-a-time',
      convertToLlm: this.options.convertToLlm,
      transformContext: async (messages, signal) => {
        let projected = messages;
        if (this.contextPolicy) {
          projected = await compactContext(messages, {
            ...this.contextPolicy, store: this.store, signal,
            estimateTokens: this.options.estimateTokens || estimateTokens,
            pinned: this.active?.run.input ? [this.active.run.input] : [],
            summarize: (earlier, cancellation, limits) => this.summarize(earlier, cancellation, limits),
          });
        }
        return this.options.transformContext ? this.options.transformContext(projected, signal) : projected;
      },
      prepareRequest: async (request, signal) => {
        this.checkRun(signal);
        return this.options.prepareRequest?.(request, signal);
      },
      prepareNextTurnWithContext: async (turn, signal) => {
        const update = await this.options.prepareNextTurn?.(turn, signal);
        return { ...update, context: update?.context || {
          messages: this.agent.state.messages.slice(), tools: this.agent.state.tools.slice(),
        } };
      },
      beforeToolCall: async (context, signal) => {
        this.checkRun(signal);
        return this.options.beforeToolCall?.(context, signal);
      },
      afterToolCall: this.options.afterToolCall,
      finishTurn: async (turn, signal) => {
        if (this.active?.reason) return { action: 'end' };
        if (turn.message.stopReason === 'length') return { action: 'end' };
        return this.options.finishTurn?.(turn, signal);
      },
    });
    this.agent.subscribe(event => this.onEvent(event));
    for (const plugin of this.plugins) await plugin.attach?.(this);
  }

  toolsFor(names) {
    const selected = [...new Set(names)];
    if (this.discovery) {
      for (const name of ['search_tools', 'load_tools']) if (!selected.includes(name)) selected.unshift(name);
    }
    if (selected.length > this.maxTools) throw new AgentBaseError('tool_capacity', 'Active tools exceed provider capacity');
    return selected.map(name => {
      if (!this.wrappedTools.has(name)) throw new AgentBaseError('unknown_tool', name);
      return this.wrappedTools.get(name);
    });
  }

  async setActiveTools(names) {
    const tools = this.toolsFor(names);
    await this.store.update(state => { state.activeTools = tools.map(tool => tool.name); });
    this.agent.state.tools = tools;
  }

  discoveryTools() {
    return [{ name: 'search_tools', label: 'Search tools', version: '1',
      description: 'Find available tools by name or description before loading a tool set.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      execute: async (_, { query }) => {
        const matches = [...this.registry.values()]
          .filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase()))
          .map(tool => ({ name: tool.name, description: tool.description }));
        return textResult(JSON.stringify({ tools: matches.slice(0, 20), total: matches.length, truncated: matches.length > 20 }));
      } },
    { name: 'load_tools', label: 'Load tools', version: '1', executionMode: 'sequential',
      description: `Select tools for the next turn. Discovery stays available. Select at most ${this.maxTools - 2} additional tools.`,
      parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, maxItems: this.maxTools - 2 } },
        required: ['names'], additionalProperties: false },
      execute: async (_, { names }) => {
        await this.setActiveTools(names);
        return textResult('Active tools updated', { names });
      } }];
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async onEvent(event) {
    if (event.type === 'message_end') {
      await this.store.update(state => {
        state.messages = clone(this.agent.state.messages);
        if (event.message.queueId) {
          for (const kind of ['steering', 'followUp']) {
            state.queues[kind] = state.queues[kind].filter(item => item.id !== event.message.queueId);
          }
        }
      });
    }
    for (const listener of this.listeners) await listener(event);
  }

  checkRun(signal) {
    checkSignal(signal);
    if (!this.active) throw new AgentBaseError('no_active_run', 'No active run');
    if (this.active.reason) throw new AgentBaseError(this.active.reason, 'Run has stopped');
    const elapsed = this.active.run.elapsedMs + performance.now() - this.active.started;
    if (elapsed >= this.active.run.limits.seconds * 1000) {
      this.active.reason = 'time_exhausted';
      throw new AgentBaseError('time_exhausted', 'Run time budget exceeded');
    }
  }

  async reserve(kind, key, input, signal, extra = {}) {
    this.checkRun(signal);
    return this.store.update(state => {
      const run = state.runs[this.active.id];
      const hash = fingerprint(input);
      const previous = state.calls[key];
      if (previous) {
        if (previous.inputHash !== hash) {
          this.active.reason = 'call_input_changed';
          throw new AgentBaseError('call_input_changed', 'Call identifier reused with different input');
        }
        if (['unknown', 'pending'].includes(previous.status)) throw new AgentBaseError('result_unknown', 'Reconcile the previous call before resuming');
        return clone(previous);
      }
      const countKey = kind === 'model' ? 'modelCalls' : 'toolCalls';
      const reservedTokens = kind === 'model' ? (this.options.estimateTokens || estimateTokens)(input)
        + (extra.maxOutputTokens ?? this.maxOutputTokens) : 0;
      if (run.usage[countKey] >= run.limits[countKey] || run.usage.tokens + reservedTokens > run.limits.tokens) {
        this.active.reason = 'budget_exhausted';
        throw new AgentBaseError('budget_exhausted', 'Run call or token budget exceeded');
      }
      run.usage[countKey] += 1;
      run.usage.tokens += reservedTokens;
      run.elapsedMs = this.active.run.elapsedMs + performance.now() - this.active.started;
      const call = { key, runId: this.active.id, kind, inputHash: hash, status: 'pending',
        reservedTokens, startedAt: Date.now(), ...extra };
      state.calls[key] = call;
      return clone(call);
    });
  }

  async settleCall(call, result, status, active = this.active) {
    await this.store.update(state => {
      const saved = state.calls[call.key];
      if (saved.status !== 'pending') return;
      saved.status = status;
      saved.result = clone(result);
      saved.finishedAt = Date.now();
      if (active?.id === call.runId) state.runs[call.runId].elapsedMs = active.run.elapsedMs + performance.now() - active.started;
      if (call.kind === 'model') {
        const usage = result.usage || {};
        const actual = status === 'failed' ? 0 : tokenUsage(usage.totalTokens, call.reservedTokens);
        const reservedCost = costUsage(saved.reservedCost);
        const reportedCost = costUsage(usage.cost?.total, status === 'succeeded' ? reservedCost : 0);
        const cost = status === 'unknown' ? Math.max(reportedCost, reservedCost) : reportedCost;
        state.runs[call.runId].usage.tokens += actual - call.reservedTokens;
        state.runs[call.runId].usage.cost += cost;
        saved.accountedTokens = actual;
        saved.accountedCost = cost;
      }
    });
  }

  modelStream(model, context, options = {}, purpose = 'response', transport = this.options.streamFn) {
    const output = createAssistantMessageEventStream();
    const active = this.active;
    const signals = [options.signal, active?.controller?.signal].filter(Boolean);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    let call;
    let dispatched = false;
    let finished = false;
    const waitFor = value => new Promise((resolve, reject) => {
      const cancel = () => { cleanup(); resolve(null); };
      const cleanup = () => signal?.removeEventListener('abort', cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      Promise.resolve(value).then(result => { cleanup(); resolve(result); }, error => { cleanup(); reject(error); });
      if (signal?.aborted) cancel();
    });
    const finish = event => {
      if (finished) return;
      finished = true;
      if (event) output.push(event);
      output.end();
    };
    const abort = () => {
      if (active && !active.reason) active.reason = 'cancelled';
      const failure = failedMessage(model, new Error('Operation cancelled'), true);
      if (call) {
        // A cancelled client request does not establish the external outcome.
        this.settleCall(call, failure, dispatched ? 'unknown' : 'failed', active).catch(error => {
          if (active) { active.reason = 'persistence_failed'; active.errorMessage = error.message; }
        });
      }
      finish({ type: 'error', reason: 'aborted', error: failure });
    };
    signal?.addEventListener('abort', abort, { once: true });
    const pump = async () => {
      try {
        this.checkRun(signal);
        const estimate = (this.options.estimateTokens || estimateTokens)(context);
        if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0)) {
          throw new AgentBaseError('invalid_output_limit', 'maxTokens must be a positive integer', { knownOutcome: true });
        }
        const outputTokens = Math.min(this.maxOutputTokens, options.maxTokens ?? Infinity, model.maxTokens || Infinity);
        if (model.contextWindow && estimate + outputTokens > model.contextWindow) {
          throw new AgentBaseError('context_overflow', 'Model context capacity exceeded', { knownOutcome: true });
        }
        const sequence = await this.store.update(state => ++state.runs[this.active.id].nextModel);
        const target = { id: model.id, provider: model.provider, api: model.api, endpointHash: fingerprint(model.baseUrl || '') };
        call = await this.reserve('model', `${active.id}:model:${sequence}`, { target, context }, signal,
          { purpose, model: target, maxOutputTokens: outputTokens, messageIndex: this.agent.state.messages.length });
        this.checkRun(signal);
        await waitFor(this.options.beforeModelCall?.({ model, context, call }, signal));
        this.checkRun(signal);
        dispatched = true;
        const pending = Promise.resolve(transport(model, context, { ...options, signal, maxTokens: outputTokens,
          hostContext: { runId: call.runId, callKey: call.key, purpose } }));
        const stream = await waitFor(pending);
        if (signal?.aborted) return;
        const iterator = stream[Symbol.asyncIterator]();
        while (true) {
          const next = await waitFor(iterator.next());
          if (signal?.aborted || finished) {
            Promise.resolve(iterator.return?.()).catch(() => {});
            return;
          }
          if (next.done) break;
          const event = next.value;
          if (event.type === 'done' || event.type === 'error') {
            const final = event.type === 'done' ? event.message : event.error;
            const capacityError = isContextOverflow(final) && !(final.providerStatus >= 500);
            let status = 'succeeded';
            if (event.type === 'error' || ['error', 'aborted'].includes(final.stopReason)) {
              status = capacityError || final.knownOutcome === true ? 'failed' : this.options.classifyModelFailure?.(final) || 'unknown';
            }
            await this.settleCall(call, final, status, active);
            if (status === 'unknown' && !active.reason) active.reason = 'result_unknown';
            if (capacityError && purpose !== 'compaction' && !this.options.nativeContextRecovery && !active.reason) active.reason = 'context_overflow';
            if (!signal?.aborted && !finished) output.push(event);
            finish();
            return;
          } else output.push(event);
        }
        throw new AgentBaseError('stream_incomplete', 'Model stream ended without a final response');
      } catch (error) {
        const failure = failedMessage(model, error, signal?.aborted);
        if (call && this.store.snapshot().calls[call.key].status === 'pending') {
          await this.settleCall(call, failure, !dispatched || error.knownOutcome === true ? 'failed' : 'unknown', active);
        }
        const recoverableCapacity = isContextOverflow(error) && (purpose === 'compaction' || this.options.nativeContextRecovery);
        if (active && !active.reason && !recoverableCapacity) {
          const unknown = call && this.store.snapshot().calls[call.key].status === 'unknown';
          active.reason = unknown ? 'result_unknown' : error.code || 'model_error';
        }
        finish({ type: 'error', reason: failure.stopReason, error: failure });
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    };
    // Stream failures are protocol events. A persistence failure must still release consumers.
    pump().catch(error => {
      finish({ type: 'error', reason: 'error', error: failedMessage(model, error) });
    });
    if (signal?.aborted) abort();
    return output;
  }

  async executeTool(tool, id, args, signal, update, association = {}) {
    const key = `${this.active.id}:tool:${id}`;
    const input = { name: tool.name, version: tool.version || '1', arguments: args };
    const call = await this.reserve('tool', key, input, signal, { name: tool.name, toolCallId: id, ...association });
    if (call.status !== 'pending') {
      if (call.status === 'failed') throw new AgentBaseError('tool_failed', call.error || 'Recorded tool failure');
      return clone(call.result);
    }
    try {
      const result = await tool.execute(id, args, signal, update);
      if (!Array.isArray(result?.content)) throw new AgentBaseError('invalid_tool_result', 'Tools must return content[]');
      await this.settleCall(call, result, 'succeeded');
      checkSignal(signal);
      return result;
    } catch (error) {
      if (this.store.snapshot().calls[key].status === 'pending') {
        await this.store.update(state => {
          const safe = tool.replay === 'safe' || error.knownOutcome === true;
          Object.assign(state.calls[key], { status: safe ? 'failed' : 'unknown',
            result: { ...textResult(error.message), isError: true }, error: error.message, finishedAt: Date.now() });
          if (!safe && !this.active.reason) this.active.reason = 'result_unknown';
        });
      }
      throw error;
    }
  }

  async summarize(messages, signal, { maxTokens = this.maxOutputTokens } = {}) {
    const result = await summarizeHistory(messages, {
      model: this.agent.state.model, signal, maxTokens: Math.min(maxTokens, this.maxOutputTokens),
      estimate: this.options.estimateTokens || estimateTokens,
      complete: (context, options) => this.modelStream(this.agent.state.model, context, options, 'compaction').result(),
    });
    return result.text;
  }

  prompt(input, { requestId = randomUUID() } = {}) {
    const message = userMessage(input);
    const inputHash = fingerprint(message.content);
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(requestId)) {
      return Promise.reject(new AgentBaseError('invalid_request_id', 'Provide a valid request identifier'));
    }
    if (this.closed) return Promise.reject(new AgentBaseError('closed', 'Agent is closed'));
    if (this.active) {
      if (this.active.id === requestId && this.active.run.inputHash === inputHash) return this.active.promise;
      return Promise.reject(new AgentBaseError('run_busy', 'Use steer() or followUp() while a run is active'));
    }
    const previous = this.store.snapshot().runs[requestId];
    if (previous) {
      if (previous.inputHash !== inputHash) return Promise.reject(new AgentBaseError('idempotency_conflict', 'Request identifier has different input'));
      return Promise.resolve(clone(previous));
    }
    if (Object.values(this.store.snapshot().calls).some(call => ['unknown', 'pending'].includes(call.status))) {
      return Promise.reject(new AgentBaseError('result_unknown', 'Reconcile unknown calls before starting more work'));
    }
    const interrupted = Object.values(this.store.snapshot().runs).find(run => ['running', 'interrupted'].includes(run.status));
    if (interrupted) return Promise.reject(new AgentBaseError('recovery_required', 'Resume or finish the previous interrupted run first'));
    const run = { requestId, inputHash, input: message, status: 'running', limits: clone(this.limits),
      usage: { modelCalls: 0, toolCalls: 0, tokens: 0, cost: 0, costKnown: Boolean(this.options.pricingKnown) },
      messageStart: this.agent.state.messages.length, nextModel: 0, elapsedMs: 0 };
    return this.startExecution(run, false);
  }

  resume(requestId) {
    if (this.closed) return Promise.reject(new AgentBaseError('closed', 'Agent is closed'));
    if (this.active) return Promise.reject(new AgentBaseError('run_busy', 'A run is already active'));
    const saved = this.store.snapshot();
    const run = saved.runs[requestId];
    if (!run || !['interrupted', 'blocked', 'failed'].includes(run.status)) {
      return Promise.reject(new AgentBaseError('not_resumable', 'Run is not resumable'));
    }
    if (Object.values(saved.calls).some(call => call.runId === requestId && ['unknown', 'pending'].includes(call.status))) {
      return Promise.reject(new AgentBaseError('result_unknown', 'Reconcile unknown external calls before resuming'));
    }
    if (run.usage.modelCalls >= run.limits.modelCalls || run.usage.toolCalls >= run.limits.toolCalls
      || run.usage.tokens >= run.limits.tokens || run.elapsedMs >= run.limits.seconds * 1000) {
      return this.store.update(state => {
        Object.assign(state.runs[requestId], { status: 'blocked', errorCode: 'budget_exhausted' });
      }).then(() => { throw new AgentBaseError('budget_exhausted', 'Start a new bounded task after inspecting existing results'); });
    }
    return this.startExecution(clone(run), true);
  }

  startExecution(run, continuing) {
    this.active = { id: run.requestId, run, started: performance.now(), reason: '', promise: null, controller: new AbortController() };
    const execution = this.executeRun(run, continuing);
    this.active.promise = execution;
    return execution;
  }

  async executeRun(run, continuing) {
    let timer;
    try {
      await this.store.update(state => { state.runs[run.requestId] = { ...clone(run), status: 'running' }; });
      const remaining = run.limits.seconds * 1000 - run.elapsedMs;
      timer = setTimeout(() => { this.active.reason = 'time_exhausted'; this.active.controller.abort(); this.agent.abort(); }, Math.max(1, remaining));
      for (const entry of this.store.snapshot().queues.steering) this.agent.steer(entry.message);
      for (const entry of this.store.snapshot().queues.followUp) this.agent.followUp(entry.message);
      if (continuing) {
        await this.recoverTranscript(run.requestId);
        const last = this.agent.state.messages.at(-1);
        const queued = this.store.snapshot().queues;
        if (last?.role !== 'assistant' || last.content?.some(item => item.type === 'toolCall')
          || queued.steering.length || queued.followUp.length) await this.agent.continue();
      } else await this.agent.prompt(run.input);
    } catch (error) {
      this.active.reason ||= error.code || 'runtime_error';
      this.active.errorMessage = error.message;
    } finally {
      clearTimeout(timer);
    }
    const last = this.agent.state.messages.slice(run.messageStart).reverse().find(message => message.role === 'assistant');
    let status = 'succeeded';
    let errorCode = this.active.reason;
    if (last?.stopReason === 'length') { status = 'truncated'; errorCode ||= 'output_truncated'; }
    if (last?.stopReason === 'error') { status = 'failed'; errorCode ||= 'model_error'; }
    if (last?.stopReason === 'aborted' || this.active.reason === 'cancelled') { status = 'cancelled'; errorCode ||= 'cancelled'; }
    if (['time_exhausted', 'budget_exhausted', 'context_overflow', 'result_unknown'].includes(this.active.reason)) status = 'blocked';
    if (this.active.reason && status === 'succeeded') status = 'failed';
    const elapsed = run.elapsedMs + performance.now() - this.active.started;
    try {
      await this.store.update(state => {
        Object.assign(state.runs[run.requestId], { status, errorCode, elapsedMs: elapsed,
          errorMessage: this.active.errorMessage || last?.errorMessage || '',
          text: status === 'cancelled' ? '' : (last?.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n') });
        state.messages = clone(this.agent.state.messages);
      });
      return clone(this.store.snapshot().runs[run.requestId]);
    } finally {
      this.agent.clearAllQueues();
      this.active = null;
    }
  }

  async recoverTranscript(runId) {
    const saved = this.store.snapshot();
    const messages = [...this.agent.state.messages];
    const modelCalls = Object.values(saved.calls).filter(call => call.runId === runId && call.kind === 'model'
      && call.purpose === 'response' && call.status === 'succeeded').sort((a, b) => a.startedAt - b.startedAt);
    for (const call of modelCalls) {
      if (messages.length === call.messageIndex) messages.push(call.result);
      else if (['error', 'aborted'].includes(messages[call.messageIndex]?.stopReason)) messages[call.messageIndex] = call.result;
    }
    this.agent.state.messages = messages;
    const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
    const calls = lastAssistant?.content?.filter(item => item.type === 'toolCall') || [];
    const answered = new Set(messages.filter(message => message.role === 'toolResult').map(message => message.toolCallId));
    for (const call of calls) {
      if (answered.has(call.id)) continue;
      const outcome = await runToolCall(call, { tools: this.agent.state.tools, assistantMessage: lastAssistant,
        context: { messages: this.agent.state.messages, tools: this.agent.state.tools },
        beforeToolCall: this.agent.beforeToolCall, afterToolCall: this.agent.afterToolCall });
      this.agent.state.messages.push(callResultMessage(call, { ...outcome.result, isError: outcome.isError }));
      await this.onEvent({ type: 'message_end', message: this.agent.state.messages.at(-1) });
    }
  }

  async reconcile(callKey, result, { restoreTranscript = true } = {}) {
    if (this.active) throw new AgentBaseError('run_busy', 'Reconcile after the run has stopped');
    await this.store.update(state => {
      const call = state.calls[callKey];
      if (!call || call.status !== 'unknown') throw new AgentBaseError('not_unknown', 'Only unknown calls can be reconciled');
      const chatResult = result?.role === 'assistant' && Array.isArray(result.content);
      const imageResult = call.purpose === 'generateImages' && Array.isArray(result?.output);
      const classifierResult = call.purpose === 'classify' && result?.answers
        && typeof result.answers === 'object' && !Array.isArray(result.answers);
      const validResult = call.kind === 'model' ? chatResult || imageResult || classifierResult : Array.isArray(result?.content);
      if (!validResult) {
        throw new AgentBaseError('invalid_result', 'Provide the verified Pi result');
      }
      Object.assign(call, { result: clone(result), status: 'succeeded', reconciledAt: Date.now() });
      if (call.kind === 'model') {
        const tokens = tokenUsage(result.usage?.totalTokens, call.reservedTokens);
        const reservedCost = Math.max(costUsage(call.reservedCost), costUsage(call.accountedCost));
        const cost = costUsage(result.usage?.cost?.total, reservedCost);
        state.runs[call.runId].usage.tokens += tokens - (call.accountedTokens ?? call.reservedTokens);
        state.runs[call.runId].usage.cost += cost - (call.accountedCost || 0);
        call.accountedTokens = tokens;
        call.accountedCost = cost;
      } else {
        state.messages = state.messages.map(message => message.role === 'toolResult' && message.toolCallId === call.toolCallId
          ? callResultMessage({ id: call.toolCallId, name: call.name }, result) : message);
      }
    });
    if (restoreTranscript) this.agent.state.messages = this.store.snapshot().messages;
  }

  async queue(kind, input) {
    if (!this.active) throw new AgentBaseError('not_running', 'Queue input while a run is active');
    const message = { ...userMessage(input), queueId: randomUUID() };
    await this.store.update(state => { state.queues[kind].push({ id: message.queueId, message }); });
    if (this.active) {
      if (kind === 'steering') this.agent.steer(message);
      else this.agent.followUp(message);
    }
    return message.queueId;
  }

  steer(input) { return this.queue('steering', input); }
  followUp(input) { return this.queue('followUp', input); }

  async abort() {
    if (!this.active) return;
    const runId = this.active.id;
    this.active.reason = 'cancelled';
    this.active.controller?.abort();
    this.agent.abort();
    await this.store.update(state => {
      const run = state.runs[runId];
      if (run) run.cancelRequested = true;
    });
  }

  snapshot() { return this.store.snapshot(); }

  async close() {
    if (this.closed) return;
    const running = this.active?.promise;
    await this.abort();
    if (running) await running;
    const errors = [];
    for (const plugin of [...this.plugins].reverse()) {
      try { await plugin.dispose?.(); } catch (error) { errors.push(error); }
    }
    try { await this.store.close(); } catch (error) { errors.push(error); }
    this.closed = true;
    if (errors.length) throw new AggregateError(errors, 'Agent cleanup failed');
  }
}

export const createAgentBase = options => AgentBase.create(options);
