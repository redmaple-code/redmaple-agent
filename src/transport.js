export function createOpenAIModel({ id, baseUrl = 'https://api.openai.com/v1',
  contextWindow = 32768, maxTokens = 2048, compat = {}, cost, reasoning = false, input = ['text'] }) {
  if (!id || !Number.isInteger(contextWindow) || contextWindow < 1 || !Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new TypeError('Provide a model id and positive context/output token limits');
  }
  if (maxTokens >= contextWindow) throw new TypeError('Output token limit must be smaller than context capacity');
  if (cost && (['input', 'output', 'cacheRead', 'cacheWrite'].some(key => !Number.isFinite(cost[key]) || cost[key] < 0)
    || Object.keys(cost).some(key => !['input', 'output', 'cacheRead', 'cacheWrite'].includes(key)))) {
    throw new TypeError('Model cost needs four nonnegative per-million token rates');
  }
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Invalid model base URL');
  return { id, name: id, api: 'openai-completions', provider: 'openai', baseUrl, contextWindow, maxTokens,
    input, reasoning, cost: cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat };
}

export function createOpenAITransport({ apiKey, getApiKey } = {}) {
  return async (model, context, options) => {
    // Keep provider implementation imports out of the base's default import path.
    const { streamSimple } = await import('@earendil-works/pi-ai/api/openai-completions');
    const key = getApiKey ? await getApiKey() : apiKey;
    return streamSimple(model, context, { ...options, apiKey: key, maxRetries: 0 });
  };
}
