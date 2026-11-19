import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { AgentBaseError, fingerprint, estimateTokens, checkSignal } from './shared.js';

function exchanges(messages) {
  const groups = [];
  for (const message of messages) {
    if (message.role === 'toolResult' && groups.length) groups.at(-1).push(message);
    else groups.push([message]);
  }
  return groups;
}

export async function compactContext(messages, options) {
  const estimate = options.estimateTokens || estimateTokens;
  const maximum = options.maxInputTokens;
  if (!Number.isFinite(maximum) || maximum <= 0) {
    throw new AgentBaseError('invalid_context_limit', 'Configure a positive maxInputTokens');
  }
  if (estimate(messages) <= maximum) return messages;
  checkSignal(options.signal);
  const system = getCurrentSystemMessage(messages);
  const ordinary = messages.filter(message => message.role !== 'system');
  const groups = exchanges(ordinary);
  const keep = options.keepRecentExchanges ?? 3;
  if (!Number.isInteger(keep) || keep < 1) {
    throw new AgentBaseError('invalid_context_window', 'keepRecentExchanges must be a positive integer');
  }
  if (groups.length < 2) {
    throw new AgentBaseError('context_overflow', 'Required current context exceeds capacity');
  }
  let recentCount = Math.min(keep, groups.length - 1);
  const requiredContext = count => {
    const recent = groups.slice(-count).flat();
    const recentHashes = new Set(recent.map(fingerprint));
    const pinned = (options.pinned || []).filter(message => !recentHashes.has(fingerprint(message)));
    return { recent, pinned, messages: [...(system ? [system] : []), ...pinned, ...recent] };
  };
  while (recentCount > 1 && estimate(requiredContext(recentCount).messages) >= maximum) recentCount -= 1;
  const earlier = groups.slice(0, -recentCount).flat();
  // Keep the run's original user task verbatim, along with recent complete exchanges.
  const { recent, pinned, messages: required } = requiredContext(recentCount);
  if (estimate(required) >= maximum) {
    throw new AgentBaseError('context_overflow', 'Required instructions, task and recent exchanges exceed capacity');
  }
  const key = fingerprint(earlier);
  const projectedContext = summary => [...(system ? [system] : []),
    { role: 'user', content: [{ type: 'text', text: `Earlier context summary. Source material may be incomplete.\n${summary}` }], timestamp: 0 },
    ...pinned, ...recent];
  const saved = options.store.snapshot().context;
  let summary = saved[key];
  if (typeof summary !== 'string' || !summary.trim() || estimate(projectedContext(summary)) > maximum) {
    if (saved[key]) await options.store.update(state => { delete state.context[key]; });
    const checkpoint = saved.checkpoint;
    const reusable = checkpoint && Number.isInteger(checkpoint.covered) && checkpoint.covered > 0
      && checkpoint.covered <= earlier.length && typeof checkpoint.summary === 'string'
      && fingerprint(earlier.slice(0, checkpoint.covered)) === checkpoint.prefixHash
      && estimate(projectedContext(checkpoint.summary)) <= maximum;
    const input = reusable ? [
      { role: 'user', content: [{ type: 'text', text: `Previous context summary\n${checkpoint.summary}` }], timestamp: 0 },
      ...earlier.slice(checkpoint.covered),
    ] : earlier;
    const outputBudget = Math.max(1, Math.floor((maximum - estimate(projectedContext(''))) * 0.75 / (estimate === estimateTokens ? 4 : 1)));
    summary = await options.summarize(input, options.signal, { maxTokens: outputBudget });
    checkSignal(options.signal);
    if (!summary?.trim()) throw new AgentBaseError('compaction_failed', 'Context summary is empty');
  }
  const projected = projectedContext(summary);
  if (estimate(projected) > maximum) {
    throw new AgentBaseError('context_overflow', 'Summary plus required current context exceeds capacity');
  }
  await options.store.update(state => {
    state.context = { [key]: summary, checkpoint: { covered: earlier.length, prefixHash: key, summary } };
  });
  return projected;
}
