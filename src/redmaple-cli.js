#!/usr/bin/env node
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRedMapleRuntime } from './full-runtime.js';
import { upstreamModule } from './upstream.js';
import { themePaths } from './branding.js';
import { runtimeTrace } from './runtime-trace.js';

export async function main(argv = process.argv.slice(2)) {
  runtimeTrace('main');
  const args = [...argv];
  const configIndex = args.indexOf('--config');
  let config = {};
  if (configIndex >= 0) {
    if (!args[configIndex + 1]) throw new Error('--config 需要配置文件路径');
    const configPath = resolve(args[configIndex + 1]);
    config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
    if (config.evolution?.evaluatorModule) {
      const module = await import(pathToFileURL(resolve(dirname(configPath), config.evolution.evaluatorModule)).href);
      if (typeof module.evaluate !== 'function') throw new Error('evaluatorModule 需要导出 evaluate 函数');
      config.evolution = { ...config.evolution, evaluate: module.evaluate,
        evaluatorId: config.evolution.evaluatorId || module.evaluatorId,
        datasetVersion: config.evolution.datasetVersion || module.datasetVersion };
    }
    args.splice(configIndex, 2);
  }
  const agentDir = resolve(config.agentDir || process.env.REDMAPLE_AGENT_DIR || join(homedir(), '.redmaple', 'agent'));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sdk = await import('@earendil-works/pi-coding-agent');
  runtimeTrace('sdk_loaded');
  await mkdir(join(agentDir, 'themes'), { recursive: true });
  for (const theme of themePaths) await copyFile(theme, join(agentDir, 'themes', theme.split(/[\\/]/).at(-1)));
  // Native administrative commands retain Pi's package, account and help behavior.
  if (['install', 'remove', 'update', 'list', 'config', 'auth', 'mcp'].includes(args[0]) || args.includes('--help') || args.includes('-h')) {
    if (args.includes('--help') || args.includes('-h')) process.stdout.write('红枫 Red Maple\n--config <JSON> 配置通用基座、权限、预算与角色\n');
    return sdk.main(args);
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write('Red Maple 0.2.0 · Pi 1.5.0\n'); return;
  }
  const parsed = sdk.parseArgs(args);
  if (parsed.offline) process.env.PI_OFFLINE = '1';
  for (const diagnostic of parsed.diagnostics) {
    if (diagnostic.type === 'error') throw new Error(diagnostic.message);
    process.stderr.write(`${diagnostic.message}\n`);
  }
  if (parsed.export) {
    const { exportFromFile } = await upstreamModule('core/export-html/index.js');
    process.stdout.write(`${await exportFromFile(parsed.export, { outputPath: parsed.messages[0],
      themeName: parsed.useTheme || config.settings?.theme || 'redmaple' })}\n`);
    return;
  }
  const cwd = resolve(config.cwd || process.cwd());
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), allowModelNetwork: false });
  for (const [name, provider] of Object.entries(config.providers || {})) modelRuntime.registerProvider(name, provider);
  if (parsed.listModels !== undefined) {
    const query = typeof parsed.listModels === 'string' ? parsed.listModels.toLowerCase() : '';
    for (const model of modelRuntime.getAllModels().filter(model => `${model.provider}/${model.id}`.toLowerCase().includes(query))) {
      process.stdout.write(`${model.provider}/${model.id}\n`);
    }
    return;
  }
  let model = config.model;
  let thinkingLevel = parsed.thinking || config.thinkingLevel;
  if (parsed.provider || parsed.model) {
    const selected = sdk.resolveCliModel({ cliProvider: parsed.provider, cliModel: parsed.model,
      cliThinking: parsed.thinking, inlineApiKey: Boolean(parsed.apiKey), modelRuntime });
    if (selected.error) throw new Error(selected.error);
    model = selected.model; thinkingLevel = selected.thinkingLevel || thinkingLevel;
    if (selected.warning) process.stderr.write(`${selected.warning}\n`);
  }
  const { createSessionManager } = await upstreamModule('main.js');
  const sessionManager = await createSessionManager(parsed, cwd, parsed.sessionDir || config.sessionDir, settingsManager);
  const mode = parsed.mode === 'rpc' ? 'rpc' : parsed.print || parsed.mode || !process.stdin.isTTY ? 'print' : 'tui';
  const scope = parsed.models ? sdk.resolveModelScopeWithDiagnostics(parsed.models, modelRuntime) : undefined;
  const runtime = await createRedMapleRuntime({ ...config, cwd, agentDir, settingsManager, modelRuntime, model,
    thinkingLevel, apiKey: parsed.apiKey || config.apiKey, sessionManager, mode,
    tools: parsed.tools || config.tools, excludeTools: parsed.excludeTools || config.excludeTools,
    noTools: parsed.noTools ? 'all' : parsed.noBuiltinTools ? 'builtin' : config.noTools,
    scopedModels: scope ? (await scope).scopedModels : undefined, extensionFlagValues: parsed.unknownFlags,
    resources: { ...config.resources, noExtensions: parsed.noExtensions ?? config.resources?.noExtensions,
      noSkills: parsed.noSkills ?? config.resources?.noSkills,
      noPromptTemplates: parsed.noPromptTemplates ?? config.resources?.noPromptTemplates,
      noThemes: parsed.noThemes ?? config.resources?.noThemes,
      noContextFiles: parsed.noContextFiles ?? config.resources?.noContextFiles,
      additionalExtensionPaths: parsed.extensions?.map(path => resolve(path)) ?? config.resources?.additionalExtensionPaths,
      additionalSkillPaths: parsed.skills?.map(path => resolve(path)) ?? config.resources?.additionalSkillPaths,
      additionalPromptTemplatePaths: parsed.promptTemplates?.map(path => resolve(path)) ?? config.resources?.additionalPromptTemplatePaths,
      additionalThemePaths: parsed.themes?.map(path => resolve(path)) ?? config.resources?.additionalThemePaths,
      systemPrompt: parsed.systemPrompt || config.resources?.systemPrompt,
      appendSystemPrompt: [...(config.resources?.appendSystemPrompt || []), ...(parsed.appendSystemPrompt || [])] },
    settings: { ...config.settings, ...(parsed.useTheme ? { theme: parsed.useTheme } : {}),
      ...(parsed.projectTrustOverride !== undefined ? { defaultProjectTrust: parsed.projectTrustOverride ? 'always' : 'never' } : {}) },
    noMcp: parsed.noMcp ?? config.noMcp, projectTrusted: parsed.projectTrustOverride ?? config.projectTrusted,
  });
  runtimeTrace('runtime_ready', { sessionId: runtime.session.sessionId });
  const traceInputEnd = () => runtimeTrace('stdin_end');
  process.stdin.on('end', traceInputEnd);
  const unsubscribeTrace = runtime.session.subscribe(event => {
    if (['agent_start', 'agent_end', 'message_end', 'tool_execution_end'].includes(event.type)) runtimeTrace(event.type);
  });
  const disposeRuntime = runtime.dispose.bind(runtime);
  runtime.dispose = async () => {
    runtimeTrace('dispose_start');
    try { await disposeRuntime(); }
    finally { runtimeTrace('dispose_end'); }
  };
  const abort = () => { void runtime.session.abort(); };
  process.on('SIGINT', abort);
  try {
    if (parsed.name) runtime.session.setSessionName(parsed.name);
    const { processFileArguments } = await upstreamModule('cli/file-processor.js');
    const files = await processFileArguments(parsed.fileArgs);
    const messages = [...parsed.messages];
    let initialMessage = [files.text, messages.shift()].filter(Boolean).join('\n');
    if (!process.stdin.isTTY && mode !== 'rpc') {
      let piped = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) piped += chunk;
      initialMessage = [piped, initialMessage].filter(Boolean).join('\n');
    }
    if (mode === 'rpc') return await sdk.runRpcMode(runtime);
    if (mode === 'print') {
      const ledger = runtime.redmaple.controls.ledger;
      process.exitCode = await sdk.runPrintMode(runtime, { mode: parsed.mode === 'json' ? 'json' : 'text',
        initialMessage, initialImages: files.images, messages });
      const lastRun = Object.values(ledger.snapshot().runs).at(-1);
      if (lastRun && lastRun.status !== 'succeeded') process.exitCode = 1;
    } else {
      await new sdk.InteractiveMode(runtime, { initialMessage, initialImages: files.images, initialMessages: messages,
        verbose: parsed.verbose, tuiMode: parsed.tuiMode, initialThemeSetting: parsed.useTheme || settingsManager.getThemeSetting() || 'redmaple' }).run();
    }
  } finally {
    process.stdin.off('end', traceInputEnd);
    unsubscribeTrace();
    process.off('SIGINT', abort);
    await runtime.dispose();
    const { stopThemeWatcher } = await upstreamModule('modes/interactive/theme/theme.js');
    stopThemeWatcher();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.code || 'redmaple_error'} ${error.message}\n`); process.exitCode = 1; });
}
