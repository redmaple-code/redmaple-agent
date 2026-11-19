#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { createAgentBase, FileStore, createWorkspaceTools, createResourcesPlugin,
  createOpenAIModel, createOpenAITransport } from './index.js';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, workspace: { type: 'string' }, session: { type: 'string', default: 'default' },
  prompt: { type: 'string' }, resume: { type: 'string' }, 'request-id': { type: 'string' },
  rpc: { type: 'boolean' }, json: { type: 'boolean' }, 'recover-lock': { type: 'boolean' }, help: { type: 'boolean' },
} });

const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);

async function rpc(base) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set();
  for await (const line of input) {
    let command;
    try { command = JSON.parse(line); }
    catch { send({ ok: false, error: { code: 'invalid_json', message: 'Expected one JSON command per line' } }); continue; }
    const handle = async () => {
      const { id, method, params = {} } = command;
      try {
        let result;
        switch (method) {
          case 'prompt': result = await base.prompt(params.input, { requestId: params.requestId || id }); break;
          case 'resume': result = await base.resume(params.requestId); break;
          case 'steer': result = await base.steer(params.input); break;
          case 'followUp': result = await base.followUp(params.input); break;
          case 'cancel': await base.abort(); result = { accepted: true }; break;
          case 'snapshot': result = base.snapshot(); break;
          case 'reconcile': await base.reconcile(params.callKey, params.result); result = { accepted: true }; break;
          default: throw Object.assign(new Error('Unknown method'), { code: 'unknown_method' });
        }
        send({ id, ok: true, result });
      } catch (error) { send({ id, ok: false, error: { code: error.code || 'error', message: error.message } }); }
    };
    const task = handle();
    pending.add(task);
    task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
}

async function main() {
  if (values.help) {
    process.stdout.write('agent-base --config config.json --prompt "task" [--session name] [--json]\n');
    process.stdout.write('agent-base --config config.json --rpc\n');
    return;
  }
  const config = values.config ? JSON.parse((await readFile(resolve(values.config), 'utf8')).replace(/^\uFEFF/, '')) : {};
  const workspace = resolve(values.workspace || config.workspace || process.cwd());
  const id = config.model?.id || process.env.AGENT_BASE_MODEL;
  const baseUrl = config.model?.baseUrl || process.env.AGENT_BASE_URL || 'https://api.openai.com/v1';
  const keyName = config.apiKeyEnv || 'OPENAI_API_KEY';
  const key = process.env[keyName];
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname);
  if (!key && !local) throw new Error(`Set ${keyName} in the process environment`);
  const model = createOpenAIModel({ ...config.model, id, baseUrl });
  const resources = await createResourcesPlugin({ workspace, cwd: workspace, skillDirectories: config.skillDirectories });
  const tools = config.workspaceTools === false ? [] : await createWorkspaceTools({ workspace });
  const store = await FileStore.open(config.sessionsDirectory || join(workspace, '.agent-base'), values.session,
    { recoverLock: values['recover-lock'] });
  const base = await createAgentBase({ model, streamFn: createOpenAITransport({ getApiKey: () => process.env[keyName] || 'local' }),
    systemPrompt: config.systemPrompt, tools, plugins: [resources], store, limits: config.limits,
    maxTools: config.maxTools, maxOutputTokens: model.maxTokens, context: config.context, pricingKnown: Boolean(config.model?.cost) });
  const interrupt = () => { base.abort().catch(error => process.stderr.write(`${error.message}\n`)); };
  process.on('SIGINT', interrupt);
  base.subscribe(event => {
    if (values.rpc || values.json) send({ type: 'event', event });
    else if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });
  try {
    if (values.rpc) await rpc(base);
    else {
      let task = values.prompt;
      if (!task && !values.resume && !process.stdin.isTTY) {
        const parts = [];
        for await (const part of process.stdin) parts.push(part);
        task = Buffer.concat(parts.map(part => Buffer.from(part))).toString('utf8');
      }
      if (!task && !values.resume) throw new Error('Provide --prompt, --resume or a task on stdin');
      const result = values.resume ? await base.resume(values.resume) : await base.prompt(task, { requestId: values['request-id'] });
      if (values.json) send({ type: 'result', result });
      else {
        process.stdout.write(`\n[${result.status}] ${result.requestId}\n`);
        if (result.errorMessage) process.stderr.write(`${result.errorCode} ${result.errorMessage}\n`);
      }
      if (result.status !== 'succeeded') process.exitCode = 1;
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    await base.close();
  }
}

main().catch(error => {
  if (values.rpc || values.json) send({ type: 'error', error: { code: error.code || 'configuration_error', message: error.message } });
  else process.stderr.write(`${error.code || 'error'} ${error.message}\n`);
  process.exitCode = 1;
});
