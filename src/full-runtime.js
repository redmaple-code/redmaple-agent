import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { SqliteStore } from './sqlite-store.js';
import { SessionControls, executionScope } from './session-controls.js';
import { brandingExtension, themePaths } from './branding.js';
import { AgentBaseError } from './shared.js';
import { createNativeExtensions } from './upstream.js';
import { attachModelDispatcher } from './model-dispatch.js';
import { createPlatformExtension } from './platform-extension.js';
import { paperpilotExtension } from './paperpilot-bridge.js';
import { createOpenAIModel } from './transport.js';
import { estimateTokens } from './shared.js';

export async function createRedMapleRuntime(options = {}) {
  if (options.policy?.profile && !['trusted', 'read-only', 'workspace', 'ask', 'sandbox'].includes(options.policy.profile)) {
    throw new AgentBaseError('invalid_policy', '权限配置需要有效的 profile');
  }
  const sdk = await import('@earendil-works/pi-coding-agent');
  const estimateRequest = value => {
    const request = value.context || value;
    if (request.messages) return request.messages.reduce((total, message) => total + sdk.estimateTokens(message), 0)
      + estimateTokens(request.tools || []);
    if (request.input) return sdk.estimateTokens({ role: 'user', content: request.input });
    const { images = [], ...text } = request;
    return sdk.estimateTokens({ role: 'user', content: [{ type: 'text', text: JSON.stringify(text) }, ...images] });
  };
  const cwd = resolve(options.cwd || process.cwd());
  const agentDir = resolve(options.agentDir || join(homedir(), '.redmaple', 'agent'));
  await mkdir(agentDir, { recursive: true });
  const controllers = new Map();
  const pendingClosures = [];
  const settingsBindings = new Map();
  const modelRuntime = options.modelRuntime || await sdk.ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), allowModelNetwork: false,
  });
  if (options.providers) {
    for (const [name, provider] of Object.entries(options.providers)) modelRuntime.registerProvider(name, provider);
  }
  let selected = options.model;
  if (selected?.id && !selected.api && selected.baseUrl) {
    const provider = selected.provider || 'redmaple-custom';
    selected = { ...createOpenAIModel(selected), ...selected, provider };
    modelRuntime.registerProvider(provider, { baseUrl: selected.baseUrl, api: 'openai-completions',
      models: [{ ...selected, name: selected.name || selected.id, api: 'openai-completions' }] });
    const key = options.apiKey || (options.apiKeyEnv && process.env[options.apiKeyEnv]);
    if (key) await modelRuntime.setRuntimeApiKey(provider, key);
    selected = modelRuntime.getModel(provider, selected.id);
  } else if (typeof selected === 'string') {
    const slash = selected.indexOf('/');
    if (slash < 1) throw new AgentBaseError('model_provider_required', '模型使用 provider/model 格式');
    selected = modelRuntime.getModel(selected.slice(0, slash), selected.slice(slash + 1));
    if (!selected) throw new AgentBaseError('model_missing', '所选模型尚未登记');
  }
  if (selected?.api && !modelRuntime.getModel(selected.provider, selected.id)) {
    modelRuntime.registerProvider(selected.provider, { api: selected.api, baseUrl: selected.baseUrl,
      models: [{ ...selected, name: selected.name || selected.id }] });
  }
  if (selected?.provider) {
    let key = options.apiKey || (options.apiKeyEnv && process.env[options.apiKeyEnv]);
    if (!key && !modelRuntime.hasConfiguredAuth(selected.provider) && selected.baseUrl
      && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(selected.baseUrl).hostname)) key = 'local';
    if (key) await modelRuntime.setRuntimeApiKey(selected.provider, key);
  }
  const bound = { current: null };
  const detach = attachModelDispatcher(modelRuntime, bound, options.streamFn);
  let runtime;

  const factory = async target => {
    await Promise.all(pendingClosures.splice(0));
    const settingsManager = options.settingsManager || sdk.SettingsManager.create(target.cwd, agentDir);
    if (!settingsBindings.has(settingsManager)) {
      const original = settingsManager.reload;
      const reload = async (...args) => {
        const result = await original.apply(settingsManager, args);
        if (options.settings) settingsManager.applyOverrides(options.settings);
        if (!settingsManager.getThemeSetting()) settingsManager.applyOverrides({ theme: 'redmaple' });
        return result;
      };
      settingsManager.reload = reload;
      settingsBindings.set(settingsManager, { original, reload });
    }
    if (options.projectTrusted !== undefined) settingsManager.setProjectTrusted(options.projectTrusted);
    if (options.settings) settingsManager.applyOverrides(options.settings);
    if (!settingsManager.getThemeSetting()) settingsManager.applyOverrides({ theme: 'redmaple' });
    if (!settingsManager.getDefaultTools()) settingsManager.applyOverrides({ defaultTools: ['+codemode', '+tool_search'] });
    const nativeExtensions = await createNativeExtensions(sdk, agentDir, options);
    const services = await sdk.createAgentSessionServices({ cwd: target.cwd, agentDir, modelRuntime, settingsManager,
      resourceLoaderOptions: {
        ...options.resources,
        systemPromptOverride: options.resources?.systemPromptOverride || (prompt => prompt ||
          'You are Red Maple, a general-purpose task agent. Work in the user’s language. Inspect relevant context, use available tools, verify results, and report evidence and unresolved work accurately. Follow project instructions and respect approval boundaries.'),
        additionalThemePaths: [...themePaths, ...(options.resources?.additionalThemePaths || [])],
        extensionFactories: [...nativeExtensions, brandingExtension,
          createPlatformExtension({ agentDir, options, bound, getRuntime: () => runtime }),
          ...(options.paperpilot ? [paperpilotExtension(options.paperpilot)] : []),
          ...(options.extensionFactories || [])],
      },
      extensionFlagValues: options.extensionFlagValues,
      resourceLoaderReloadOptions: options.resourceLoaderReloadOptions,
    });
    if (options.settings) settingsManager.applyOverrides(options.settings);
    if (!settingsManager.getThemeSetting()) settingsManager.applyOverrides({ theme: 'redmaple' });
    const created = await sdk.createAgentSessionFromServices({ services, sessionManager: target.sessionManager,
      sessionStartEvent: target.sessionStartEvent, model: selected, thinkingLevel: options.thinkingLevel,
      tools: options.tools || settingsManager.getDefaultTools() || ['+codemode', '+tool_search'],
      customTools: options.customTools, excludeTools: options.excludeTools,
      noTools: options.noTools, scopedModels: options.scopedModels,
    });
    const session = created.session;
    let store;
    try { store = await SqliteStore.open(join(agentDir, 'redmaple.sqlite'), session.sessionId,
      { recoverLock: options.recoverLock }); }
    catch (error) { session.dispose(); throw error; }
    let controls;
    try { controls = await SessionControls.create(session, store, { ...options, owner: bound,
      estimateTokens: options.estimateTokens || estimateRequest }); }
    catch (error) { session.dispose(); await store.close(); throw error; }
    controllers.set(session.sessionId, controls);
    bound.current = controls;
    controls.bind();
    const dispose = session.dispose.bind(session);
    session.dispose = () => {
      try { dispose(); }
      finally {
        const closing = controls.close().finally(() => { if (controllers.get(session.sessionId) === controls) controllers.delete(session.sessionId); });
        closing.catch(() => {});
        pendingClosures.push(closing);
      }
    };
    await session.bindExtensions({ mode: options.mode || 'print', onError: event => options.onError?.(event) });
    controls.instrumentTools();
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const sessionManager = options.sessionManager || (options.sessionFile
    ? sdk.SessionManager.open(resolve(options.sessionFile))
    : options.continueSession ? sdk.SessionManager.continueRecent(cwd, options.sessionDir)
      : options.inMemory ? sdk.SessionManager.inMemory(cwd) : sdk.SessionManager.create(cwd, options.sessionDir));
  try { runtime = await sdk.createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager }); }
  catch (error) {
    await Promise.allSettled([...controllers.values()].map(control => control.close()));
    for (const [manager, binding] of settingsBindings) if (manager.reload === binding.reload) manager.reload = binding.original;
    detach();
    throw error;
  }
  const dispose = runtime.dispose.bind(runtime);
  runtime.dispose = async () => {
    try { await dispose(); }
    finally {
      const closed = await Promise.allSettled(pendingClosures.splice(0));
      for (const [manager, binding] of settingsBindings) if (manager.reload === binding.reload) manager.reload = binding.original;
      detach();
      const failures = closed.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Red Maple cleanup failed');
    }
  };
  runtime.redmaple = { agentDir, controllers, options, modelRuntime,
    openPlatform: () => bound.openPlatform({ cwd: runtime.session.sessionManager.getCwd() }),
    openWorkflowRunner: () => bound.openWorkflowRunner({ cwd: runtime.session.sessionManager.getCwd() }),
    get controls() { return controllers.get(runtime.session.sessionId); } };
  return runtime;
}
