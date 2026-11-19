import { createHash } from 'node:crypto';

export class AgentBaseError extends Error {
  constructor(code, message, { knownOutcome = false } = {}) {
    super(message);
    this.name = 'AgentBaseError';
    this.code = code;
    this.knownOutcome = knownOutcome;
  }
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value, (_, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
    }
    return item;
  })).digest('hex');
}

export function textResult(text, details = {}) {
  return { content: [{ type: 'text', text }], details };
}

export function estimateTokens(value) {
  // A conservative text estimate. Hosts can supply their own multimodal estimator.
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function checkSignal(signal) {
  if (signal?.aborted) throw new AgentBaseError('cancelled', 'Operation cancelled');
}

export function emptyState() {
  return { schemaVersion: 1, identity: '', messages: [], runs: {}, calls: {},
    queues: { steering: [], followUp: [] }, context: {} };
}
