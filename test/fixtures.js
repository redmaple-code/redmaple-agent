import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

export const model = { id: 'local-test', name: 'local-test', api: 'openai-completions', provider: 'openai',
  baseUrl: 'http://127.0.0.1', contextWindow: 100000, maxTokens: 2048,
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

export function assistant(content, stopReason = 'stop') {
  return { role: 'assistant', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason,
    usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 70,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

export const call = (id, name, args = {}) => ({ type: 'toolCall', id, name, arguments: args });

export function scripted(replies) {
  const requests = [];
  const streamFn = (chosen, context, options) => {
    const stream = createAssistantMessageEventStream();
    requests.push(structuredClone(context));
    const reply = replies[requests.length - 1];
    queueMicrotask(async () => {
      try {
        if (!reply) throw new Error('Unexpected model call');
        const message = typeof reply === 'function' ? await reply(context, options) : reply;
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        for (const [index, item] of message.content.entries()) {
          if (item.type === 'text') {
            stream.push({ type: 'text_start', contentIndex: index, partial: message });
            stream.push({ type: 'text_delta', contentIndex: index, delta: item.text, partial: message });
            stream.push({ type: 'text_end', contentIndex: index, content: item.text, partial: message });
          }
        }
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end();
      } catch (error) {
        const failure = { ...assistant([], 'error'), errorMessage: error.message };
        stream.push({ type: 'error', reason: 'error', error: failure });
        stream.end();
      }
    });
    return stream;
  };
  return { requests, streamFn };
}

export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

export const tool = (name, execute, extra = {}) => ({ name, label: name, description: `Test tool ${name}`,
  version: '1', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute, ...extra });
