// Private stdio worker. Credentials, authorization and domain writes stay in the host.
import { createInterface } from 'node:readline';
import { AgentBase, MemoryStore, AgentBaseError, textResult } from './index.js';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Map();
let sequence = 0;
function request(kind, payload) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.stdout.write(JSON.stringify({ id, kind, payload }) + '\n');
  });
}
function text(content) {
  return typeof content === 'string' ? content : (content || []).filter(i => i.type === 'text').map(i => i.text).join('\n');
}
function wireMessages(context) {
  const result = [{ role: 'system', content: context.messages.filter(m => m.role === 'system').map(m => text(m.content)).filter(Boolean).join('\n') }];
  for (const message of context.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'toolResult') {
      result.push({ role: 'tool', tool_call_id: message.toolCallId, name: message.toolName, content: text(message.content) });
    } else {
      const calls = (message.content || []).filter?.(i => i.type === 'toolCall') || [];
      result.push({ role: message.role, content: text(message.content), ...(calls.length ? {
        tool_calls: calls.map(i => ({ id: i.id, type: 'function', function: { name: i.name, arguments: JSON.stringify(i.arguments) } })),
      } : {}) });
    }
  }
  return result;
}
function wireTools(context) {
  const active = new Map();
  for (const message of context.messages.filter(m => m.role === 'system')) {
    for (const name of message.toolsRemoved || []) active.delete(typeof name === 'string' ? name : name.name);
    for (const tool of message.toolsAdded || []) active.set(tool.name, tool);
  }
  return [...active.values()].map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}
function historyMessage(message) {
  if (message.role === 'tool') return { role: 'toolResult', toolCallId: message.tool_call_id, toolName: message.name,
    content: [{ type: 'text', text: message.content || '' }], timestamp: 0 };
  return { role: message.role, content: [{ type: 'text', text: message.content || '' }, ...(message.tool_calls || []).map(i => ({
    type: 'toolCall', id: i.id, name: i.function.name, arguments: JSON.parse(i.function.arguments || '{}'),
  }))], timestamp: 0 };
}

async function run(config) {
  class HostStore extends MemoryStore {
    async persist(state) { await request('checkpoint', { state }); }
  }
  const store = new HostStore(config.snapshot || undefined);
  if (!config.snapshot) store.state.messages = config.history.filter(m => m.role !== 'system').map(historyMessage);
  const model = { id: config.model, name: config.model, api: 'openai-completions', provider: 'paperpilot',
    contextWindow: 128000, maxTokens: 2000, reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const streamFn = (_, context, options) => {
    const stream = createAssistantMessageEventStream();
    (async () => {
      try {
        const response = await request('model', { key: options.hostContext.callKey, messages: wireMessages(context),
          tools: wireTools(context) });
        if (!response.ok) throw new AgentBaseError(response.error_code || 'provider_failed', response.error || '模型调用失败');
        const content = response.content ? [{ type: 'text', text: response.content }] : [];
        for (const call of response.tool_calls || []) content.push({ type: 'toolCall', id: call.id,
          name: call.function.name, arguments: typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments });
        const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: response.usage?.total_tokens || 1,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: response.tool_calls?.length ? 'toolUse' : response.finish_reason === 'length' ? 'length' : 'stop', timestamp: Date.now() };
        stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
      } catch (error) {
        stream.push({ type: 'error', reason: 'error', error: { role: 'assistant', content: [], api: model.api,
          provider: model.provider, model: model.id, usage: { totalTokens: 0, cost: { total: 0 } },
          stopReason: 'error', errorMessage: error.message, timestamp: Date.now() } }); stream.end();
      }
    })();
    return stream;
  };
  const base = await AgentBase.create({ model, streamFn, store, context: false, systemPrompt: config.system,
    classifyModelFailure: () => 'failed',
    limits: config.limits, maxTools: config.maxTools, toolExecution: 'sequential',
    tools: config.tools.map(tool => ({ ...tool, label: tool.name, replay: 'never', executionMode: 'sequential',
      async execute(id, args) {
        const result = await request('tool', { id, name: tool.host_dispatch ? args.name : tool.name, args: tool.host_dispatch ? args.arguments : args });
        return { ...textResult(JSON.stringify(result), result), isError: result.ok === false };
      } })),
    finishTurn: async () => {
      const result = await request('steering', {});
      for (const item of result.items || []) {
        if (!store.snapshot().queues.steering.some(entry => entry.id === item.id)) {
          const message = { role: 'user', content: [{ type: 'text', text: item.text }], queueId: item.id, timestamp: Date.now() };
          await store.update(state => { state.queues.steering.push({ id: item.id, message }); });
          base.agent.steer(message);
        }
      }
      if (result.items?.length) await request('steering_ack', { ids: result.items.map(item => item.id) });
    },
  });
  for (const [key, result] of Object.entries(config.reconciliations || {})) {
    if (base.snapshot().calls[key]?.status === 'unknown') await base.reconcile(key, result);
  }
  if (!config.snapshot && config.activeTools?.length) await base.setActiveTools(config.activeTools);
  try {
    const completed=base.snapshot().runs[config.requestId];
    const result = completed?.status === 'succeeded' ? completed : config.snapshot ? await base.resume(config.requestId) : await base.prompt(config.instruction, { requestId: config.requestId });
    await request('complete', result);
  } finally { await base.close(); }
}

let started = false;
process.stdout.write(JSON.stringify({ kind: 'ready' }) + '\n');
lines.on('line', line => {
  const value = JSON.parse(line);
  if (!started) {
    started = true;
    run(value).then(() => {
      started=false;
      process.stdout.write(JSON.stringify({ kind: 'ready' }) + '\n');
    }).catch(error => {
      process.stdout.write(JSON.stringify({ kind: 'fatal', payload: { code: error.code || 'runtime_error', message: error.message } }) + '\n');
      process.exit(1);
    });
    return;
  }
  const waiting = pending.get(value.id);
  if (waiting) {
    pending.delete(value.id);
    if (value.error) waiting.reject(new AgentBaseError(value.error.code, value.error.message));
    else waiting.resolve(value.result);
  }
});
lines.on('close', () => process.exit(1));
