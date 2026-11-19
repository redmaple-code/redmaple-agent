import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { calculateCost, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentBase } from './agent.js';
import { AgentBaseError, fingerprint, estimateTokens, clone } from './shared.js';
import { authorizeTool, executeSandbox, sandboxTimeout } from './permissions.js';
import { compactNativeSession } from './native-compaction.js';

export const executionScope = new AsyncLocalStorage();
const wrapped = Symbol('redmapleWrapped');
const controllerModel = { id: 'runtime', name: 'runtime', api: 'host', provider: 'redmaple', baseUrl: '',
  contextWindow: 1000000, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const priceFields = ['input', 'output', 'cacheRead', 'cacheWrite'];

function requiresReconciliation(call) {
  // Chat generation and compaction do not execute tools. Keep their unknown
  // provider outcome and reserved usage in the ledger while allowing a new turn.
  return call.status === 'unknown'
    && (call.kind !== 'model' || !['response', 'compaction'].includes(call.purpose));
}

function normalizePricing(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const tiers = value.tiers ?? [];
  if (!Array.isArray(tiers)) return null;
  const rates = [value, ...tiers];
  const invalidRates = rates.some(rate => !rate
    || ['input', 'output'].some(key => !Number.isFinite(rate[key]) || rate[key] < 0)
    || priceFields.some(key => rate[key] !== undefined && (!Number.isFinite(rate[key]) || rate[key] < 0)));
  if (invalidRates || tiers.some(tier => !Number.isFinite(tier.inputTokensAbove) || tier.inputTokensAbove < 0)
    || value.request !== undefined && (!Number.isFinite(value.request) || value.request < 0)) return null;
  const [base, ...normalizedTiers] = rates.map(rate => ({ ...rate,
    cacheRead: rate.cacheRead ?? rate.input, cacheWrite: rate.cacheWrite ?? rate.input }));
  return { ...base, tiers: normalizedTiers };
}

function withResponseStatus(options, recordStatus, defaultFetch) {
  return { ...options, maxRetries: 0,
    fetch: async (...args) => {
      const response = await (defaultFetch || options.fetch || globalThis.fetch)(...args);
      recordStatus(response.status);
      return response;
    },
    onResponse: async (response, ...args) => {
      recordStatus(response.status);
      await options.onResponse?.(response, ...args);
    } };
}

export class SessionControls {
  static async create(session, store, options) {
    if (options.money && (!Number.isFinite(options.money.amount) || options.money.amount <= 0)) {
      throw new AgentBaseError('invalid_money', '金额上限必须为正数');
    }
    if (options.money?.currency && options.money.currency !== 'USD') {
      throw new AgentBaseError('invalid_currency', '原生模型费率使用 USD');
    }
    const self = new SessionControls(session, options);
    self.ledger = await createAgentBase({ model: controllerModel, store, context: false,
      nativeContextRecovery: true,
      profileVersion: 'redmaple-full/1', maxOutputTokens: options.maxOutputTokens ?? 4096,
      limits: options.limits, estimateTokens: options.estimateTokens,
      streamFn: async () => { throw new Error('A runtime transport must be bound'); },
      classifyModelFailure: message => Number.isInteger(message.providerStatus)
        && message.providerStatus >= 400 && message.providerStatus < 600 ? 'failed' : 'unknown',
      beforeModelCall: (request, signal) => self.authorizeModel(request, signal),
    });
    self.ledger.agent = session.agent;
    return self;
  }

  constructor(session, options) {
    this.session = session;
    this.options = options;
    this.originalOperations = new Map();
    this.shellControllers = new Set();
    this.taskAbortControllers = new Set();
  }

  async authorizeModel({ model, context, call }, signal) {
    const snapshot = this.ledger.snapshot();
    if (Object.values(snapshot.calls).some(item => item.key !== call.key && requiresReconciliation(item))) {
      throw new AgentBaseError('result_unknown', '存在执行结果未知的操作，请用 /calls 核对后继续', { knownOutcome: true });
    }
    const money = this.options.money;
    if (money) {
      const override = this.options.pricing?.[`${model.provider}/${model.id}`];
      const cost = normalizePricing(override || model.cost);
      const known = cost && (override || cost.request > 0
        || [cost, ...cost.tiers].some(rate => priceFields.some(key => rate[key] > 0)));
      if (!known) throw new AgentBaseError('pricing_required', '金额硬上限需要明确的模型费率', { knownOutcome: true });
      const inputBound = Buffer.byteLength(JSON.stringify(context), 'utf8');
      const applicable = [cost, ...cost.tiers.filter(tier => inputBound > tier.inputTokensAbove)];
      const inputRate = Math.max(...applicable.flatMap(rate => [rate.input, rate.cacheRead, rate.cacheWrite,
        model.promptCache?.long >= 3600 ? rate.input * 2 : 0]));
      const outputRate = Math.max(...applicable.map(rate => rate.output));
      const estimated = (inputBound * inputRate + (call.maxOutputTokens ?? this.ledger.maxOutputTokens) * outputRate) / 1000000 + (cost.request || 0);
      await this.ledger.store.update(state => {
        const run = state.runs[call.runId];
        const reserved = Object.values(state.calls).filter(item => item.runId === call.runId && item.status === 'pending')
          .reduce((sum, item) => sum + (item.reservedCost || 0), 0);
        if (run.usage.cost + reserved + estimated > money.amount) {
          throw new AgentBaseError('money_exhausted', '本轮金额上限不足，调用尚未发送', { knownOutcome: true });
        }
        state.calls[call.key].reservedCost = estimated;
        state.calls[call.key].pricing = clone(cost);
      });
    }
    await this.options.beforeModelCall?.({ model, context, call }, signal);
  }

  stream(model, context, options, raw) {
    const output = createAssistantMessageEventStream();
    const controls = executionScope.getStore()?.controls || this;
    if (!controls.ledger.active) {
      const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), usage: { totalTokens: 0 }, stopReason: 'error', errorMessage: 'A managed run is required' };
      output.push({ type: 'error', reason: 'error', error: message }); output.end(); return output;
    }
    const transport = async (chosen, transcript, requestOptions) => {
      const forwarded = createAssistantMessageEventStream();
      let status;
      const source = raw(chosen, transcript, withResponseStatus(requestOptions, value => { status = value; }, controls.options.fetch));
      (async () => {
        const stream = await source;
        if (requestOptions.signal?.aborted) { forwarded.end(); return; }
        for await (const event of stream) {
          if (event.type === 'error' && status) event.error.providerStatus = status;
          if (event.type === 'done') controls.priceResult(chosen, event.message,
            controls.ledger.snapshot().calls[requestOptions.hostContext?.callKey]);
          forwarded.push(event);
        }
        forwarded.end();
      })().catch(error => {
        forwarded.push({ type: 'error', reason: 'error', error: {
          role: 'assistant', content: [], stopReason: 'error', errorMessage: error.message,
          code: error.code, knownOutcome: error.knownOutcome === true, providerStatus: status,
          api: chosen.api, provider: chosen.provider, model: chosen.id, timestamp: Date.now(), usage: { totalTokens: 0 },
        } });
        forwarded.end();
      });
      return forwarded;
    };
    return controls.ledger.modelStream(model, context, options,
      controls.session.isCompacting || options?.sessionId?.includes('compact') ? 'compaction' : 'response', transport);
  }

  priceResult(model, result, call) {
    let reservation = call;
    if (this.options.money && !reservation?.pricing) {
      const calls = this.ledger.snapshot().calls;
      reservation = call?.key ? calls[call.key] || call : Object.values(calls).filter(item => item.status === 'pending' && item.kind === 'model').at(-1);
    }
    const price = normalizePricing(reservation?.pricing || this.options.pricing?.[`${model.provider}/${model.id}`]);
    const usage = result.usage;
    if (usage?.cost?.totalFromProvider === true && Number.isFinite(usage.cost.total) && usage.cost.total >= 0) {
      delete usage.costEstimated;
      return;
    }
    const measuredUsage = usage && priceFields.every(key => Number.isFinite(usage[key]) && usage[key] >= 0)
      && priceFields.some(key => usage[key] > 0)
      && (usage.cacheWrite1h === undefined || Number.isFinite(usage.cacheWrite1h)
        && usage.cacheWrite1h >= 0 && usage.cacheWrite1h <= usage.cacheWrite);
    if (price && measuredUsage) {
      usage.cost = { ...usage.cost };
      calculateCost({ cost: price }, usage);
      usage.cost.total += price.request || 0;
      delete usage.costEstimated;
    }
    if (this.options.money && (!Number.isFinite(result.usage?.cost?.total)
      || price && !measuredUsage)) {
      result.usage = { ...usage, cost: { ...usage?.cost, total: reservation?.reservedCost || 0, totalFromProvider: false }, costEstimated: true };
    }
  }

  async modelOperation(purpose, model, context, options = {}, raw) {
    return this.withRun(purpose, async () => {
      const active = this.ledger.active;
      let returned;
      let failure;
      let dispatched = false;
      const transport = async (chosen, request, requestOptions) => {
        const { hostContext, ...forwarded } = requestOptions;
        if (options.maxTokens === undefined) delete forwarded.maxTokens;
        let status;
        try {
          dispatched = true;
          returned = await raw(chosen, request, withResponseStatus(forwarded, value => { status = value; }, this.options.fetch));
          const failed = ['error', 'aborted'].includes(returned.stopReason) || returned.error;
          if (failed && status !== undefined) returned.providerStatus = status;
          if (!failed) this.priceResult(chosen, returned, this.ledger.snapshot().calls[hostContext.callKey]);
          const stream = createAssistantMessageEventStream();
          stream.push(failed ? { type: 'error', reason: 'error', error: returned }
            : { type: 'done', reason: returned.stopReason || 'stop', message: returned });
          stream.end();
          return stream;
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      const result = await this.ledger.modelStream(model, context, options, purpose, transport).result();
      if (failure) throw failure;
      if (result !== returned) {
        throw new AgentBaseError(active.reason || 'model_error', result.errorMessage || 'Model operation did not complete', { knownOutcome: !dispatched });
      }
      return result;
    });
  }

  instrumentTools() {
    for (const metadata of this.session.getAllTools()) {
      const definition = this.session.getToolDefinition(metadata.name);
      if (!definition || definition[wrapped]) continue;
      const original = definition.execute;
      const self = this;
      const version = fingerprint({ name: definition.name, source: metadata.sourceInfo, parameters: definition.parameters });
      definition.execute = async (id, args, signal, update, context) => {
        const controls = executionScope.getStore()?.controls || self;
        return controls.withRun(`tool:${definition.name}`, async () => {
          await controls.options.authorizeTool?.({ definition, args, context, signal,
            workflow: executionScope.getStore()?.workflow, sessionId: self.session.sessionId });
          const readRoots = definition.name === 'read'
            ? self.session.resourceLoader.getSkills().skills.map(skill => skill.baseDir) : [];
          await authorizeTool(controls.options.policy, self.session.sessionManager.getCwd(), definition, args, context, { readRoots });
          const execute = controls.options.policy?.profile === 'sandbox' && ['bash', 'powershell'].includes(definition.name)
            ? () => executeSandbox({ workspace: self.session.sessionManager.getCwd(), command: args.command,
              timeout: sandboxTimeout(args.timeout, controls.ledger.active.run.limits.seconds * 1000
                - (controls.ledger.active.run.elapsedMs + performance.now() - controls.ledger.active.started)),
              image: controls.options.policy.dockerImage, shell: definition.name === 'powershell' ? 'powershell' : 'sh', signal, onUpdate: update })
            : async () => {
              try { return await original(id, args, signal, update, context); }
              catch (error) {
                if (['read', 'grep', 'find', 'ls'].includes(definition.name)
                  || ['ENOENT', 'EACCES', 'EISDIR'].includes(error.code)
                  || (definition.name === 'edit' && /exact text|not found|multiple|ambiguous/i.test(error.message))) {
                  error.knownOutcome = true;
                }
                throw error;
              }
            };
          return controls.ledger.executeTool({ name: definition.name, version, parameters: definition.parameters,
            replay: ['read', 'grep', 'find', 'ls'].includes(definition.name) || definition.annotations?.readOnlyHint ? 'safe' : 'never',
            execute }, `${self.session.sessionId}/${id}`, args, signal, update, executionScope.getStore()?.workflow);
        });
      };
      definition[wrapped] = true;
    }
  }

  bind() {
    this.instrumentTools();
    // The pinned Pi adapter preserves its lifecycle, user extension overrides and session format.
    if (typeof this.session._runDefaultCompaction !== 'function') throw new AgentBaseError('unsupported_upstream', 'Pi compaction adapter requires the pinned SDK');
    this.session._runDefaultCompaction = (...args) => compactNativeSession(executionScope.getStore()?.controls || this, ...args);
    const prepare = this.session.agent.prepareRequest;
    this.session.agent.prepareRequest = async (...args) => {
      const result = await prepare?.(...args);
      this.instrumentTools();
      return result;
    };
    for (const name of ['prompt', 'compact', 'navigateTree', 'executeBash', 'sendUserMessage', 'sendCustomMessage']) {
      if (typeof this.session[name] !== 'function') continue;
      const operation = this.session[name].bind(this.session);
      this.originalOperations.set(name, operation);
      this.session[name] = (...args) => this.withRun(name, () => operation(...args));
    }
    const abort = this.session.abort.bind(this.session);
    this.session.abort = async (...args) => {
      if (executionScope.getStore()?.internalAbort) return abort(...args);
      for (const controller of this.shellControllers) controller.abort();
      for (const controller of this.taskAbortControllers) controller.abort();
      if (this.ledger.active && !this.ledger.active.reason) {
        this.ledger.active.reason = 'cancelled';
        this.ledger.active.controller?.abort();
        const id = this.ledger.active.id;
        await this.ledger.store.update(state => { if (state.runs[id]) state.runs[id].cancelRequested = true; });
      }
      this.ledger.active?.controller?.abort();
      return abort(...args);
    };
    for (const name of ['compact', 'navigateTree']) {
      const operation = this.originalOperations.get(name);
      this.session[name] = async (...args) => {
        if (this.ledger.active && executionScope.getStore()?.controls !== this) {
          const pending = this.ledger.active.promise;
          await this.session.abort();
          await pending?.catch(() => {});
        } else if (this.ledger.active && this.session.isStreaming) {
          throw new AgentBaseError('run_busy', '请在当前工具轮结束后切换上下文', { knownOutcome: true });
        }
        return this.withRun(name, () => executionScope.run({ ...executionScope.getStore(), internalAbort: true },
          () => operation(...args)));
      };
    }
    const abortBash = this.session.abortBash.bind(this.session);
    this.session.abortBash = () => { for (const controller of this.shellControllers) controller.abort(); return abortBash(); };
    const bash = this.originalOperations.get('executeBash');
    this.session.executeBash = (command, onChunk, options) => this.withRun('user-shell', async () => {
      await authorizeTool(this.options.policy, this.session.sessionManager.getCwd(), { name: 'bash' }, { command }, this.options.owner?.context);
      const result = await this.ledger.executeTool({ name: 'user-shell', version: '1', replay: 'never', execute: async () => {
        if (this.options.policy?.profile === 'sandbox') {
          const controller = new AbortController();
          this.shellControllers.add(controller);
          try {
            const response = await executeSandbox({ workspace: this.session.sessionManager.getCwd(), command,
              timeout: sandboxTimeout(options?.timeout, this.ledger.active.run.limits.seconds * 1000
                - (this.ledger.active.run.elapsedMs + performance.now() - this.ledger.active.started)),
              image: this.options.policy.dockerImage, signal: controller.signal, onUpdate: update => onChunk?.(update.content[0].text) });
            return { ...response, details: { output: response.content[0].text, ...response.details } };
          } finally { this.shellControllers.delete(controller); }
        }
        const response = await bash(command, onChunk, options);
        return { content: [{ type: 'text', text: response.output }], details: response };
      } }, randomUUID(), { command });
      if (this.options.policy?.profile === 'sandbox') this.session.recordBashResult(command, result.details, options);
      return result.details;
    });
  }

  async reconcile(callKey, verifiedResult) {
    const call = this.ledger.snapshot().calls[callKey];
    const result = verifiedResult && typeof verifiedResult === 'object' ? clone(verifiedResult) : verifiedResult;
    if (call?.kind === 'model' && this.options.money && result && typeof result === 'object' && !Number.isFinite(result.usage?.cost?.total)) {
      if (call.pricing) this.priceResult(call.model, result, call);
      else result.usage = { ...result.usage, cost: { total: call.reservedCost || call.accountedCost || 0 } };
    }
    // The native SessionManager owns the transcript. Ledger reconciliation must never replace it.
    await this.ledger.reconcile(callKey, result, { restoreTranscript: false });
    await this.session.sendCustomMessage({ customType: 'redmaple-reconciliation', display: true,
      content: `已核对调用 ${callKey}\n${JSON.stringify(result)}` });
  }

  runInBudget(runId, action) {
    const scope = executionScope.getStore();
    if (scope?.controls?.ledger.active?.id === runId) return action();
    if (this.ledger.active?.id === runId) return executionScope.run({ controls: this, owner: this.options.owner, depth: scope?.depth || 0 }, action);
    const controls = new SessionControls(this.session, this.options);
    controls.ledger = Object.assign(Object.create(Object.getPrototypeOf(this.ledger)), this.ledger, { active: null });
    return controls.withRun('workflow-resume', action, { runId, isolated: true }).catch(error => {
      if (controls.persistenceError) this.persistenceError = controls.persistenceError;
      throw error;
    });
  }

  async withRun(purpose, action, { runId, isolated = false } = {}) {
    const inherited = executionScope.getStore();
    if (this.persistenceError || inherited?.controls?.persistenceError) {
      throw new AgentBaseError('persistence_failed', '运行状态写入失败，请恢复存储并重新打开会话');
    }
    if (!isolated && inherited?.controls?.ledger.active) return action();
    if (this.ledger.active) return executionScope.run({ controls: this, owner: this.options.owner, depth: 0 }, action);
    const unknown = Object.values(this.ledger.snapshot().calls)
      .some(call => call.status === 'pending' || requiresReconciliation(call));
    if (unknown) throw new AgentBaseError('result_unknown', '存在尚未完成或执行结果未知的操作，请用 /calls 核对后继续');
    const id = runId || randomUUID();
    if (runId && !this.ledger.snapshot().runs[runId]) throw new AgentBaseError('run_missing', '共享预算记录不存在');
    const run = runId ? clone(this.ledger.snapshot().runs[runId]) : { requestId: id, purpose, inputHash: fingerprint(purpose), status: 'running',
      limits: clone(this.ledger.limits), usage: { modelCalls: 0, toolCalls: 0, tokens: 0, cost: 0, costKnown: false },
      nextModel: 0, elapsedMs: 0 };
    run.status = 'running';
    const active = { id, run, started: performance.now(), reason: '', promise: null, controller: new AbortController() };
    this.ledger.active = active;
    const persist = async change => {
      try { await this.ledger.store.update(change); }
      catch (error) { this.persistenceError = error; throw error; }
    };
    const task = executionScope.run({ controls: this, owner: this.options.owner, depth: 0 }, async () => {
      try {
        await persist(state => { state.runs[id] = clone(run); });
        const timer = setTimeout(() => {
          active.reason = 'time_exhausted';
          active.controller.abort();
          void this.session.abort().catch(error => { this.persistenceError = error; this.session.agent.abort(); });
        },
          Math.max(0, run.limits.seconds * 1000 - (run.elapsedMs || 0)));
        let failure;
        try { return await action(); }
        catch (error) { failure = error; throw error; }
        finally {
          clearTimeout(timer);
          const finalModel = Object.values(this.ledger.snapshot().calls).filter(call => call.runId === id && call.kind === 'model').at(-1);
          const modelFailure = finalModel?.status === 'failed' || finalModel?.result?.stopReason === 'error';
          let reason = active.reason || failure?.code || (failure ? 'runtime_error' : '');
          if (!reason && modelFailure) reason = 'model_error';
          if (!reason && finalModel?.result?.stopReason === 'length') reason = 'output_truncated';
          let status = 'succeeded';
          if (reason === 'cancelled') status = 'cancelled';
          else if (reason === 'output_truncated') status = 'truncated';
          else if (reason) status = 'blocked';
          await persist(state => {
            Object.assign(state.runs[id], { status,
              errorCode: reason, elapsedMs: run.elapsedMs + performance.now() - active.started });
          });
        }
      } finally { this.ledger.active = null; }
    });
    active.promise = task;
    return task;
  }

  async close() { await this.ledger.close(); }
}
