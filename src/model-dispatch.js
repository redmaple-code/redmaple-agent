import { AgentBaseError } from './shared.js';
import { executionScope } from './session-controls.js';

const dispatchers = new WeakMap();

// One dispatcher per native model runtime. Child sessions share transports and accounting.
export function attachModelDispatcher(runtime, owner, streamFn) {
  let entry = dispatchers.get(runtime);
  if (!entry) {
    entry = { owners: new Set(), originals: new Map() };
    for (const name of ['streamSimple', 'stream', 'streamDeferred', 'generateImages', 'classify']) {
      if (typeof runtime[name] !== 'function') continue;
      const original = runtime[name];
      entry.originals.set(name, original);
      runtime[name] = (model, context, options) => {
        const scope = executionScope.getStore();
        if (scope?.transport) return original.call(runtime, model, context, options);
        const selected = scope?.owner || (entry.owners.size === 1 ? [...entry.owners][0] : undefined);
        const control = scope?.controls || selected?.current;
        if (!control) throw new AgentBaseError('run_required', '模型调用需要红枫运行上下文');
        const raw = (chosen, transcript, request) => executionScope.run({ ...scope, transport: true },
          () => (['streamSimple', 'stream'].includes(name) && selected?.streamFn ? selected.streamFn : original)
            .call(runtime, chosen, transcript, request));
        return ['generateImages', 'classify'].includes(name)
          ? control.modelOperation(name, model, context, options, raw)
          : control.stream(model, context, options, raw);
      };
    }
    dispatchers.set(runtime, entry);
  }
  owner.streamFn = streamFn;
  entry.owners.add(owner);
  return () => {
    entry.owners.delete(owner);
    if (entry.owners.size) return;
    for (const [name, original] of entry.originals) runtime[name] = original;
    dispatchers.delete(runtime);
  };
}
