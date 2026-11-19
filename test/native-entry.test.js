import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRedMapleRuntime } from '../src/full-runtime.js';

async function server(t, rejectOnce = false) {
  const requests = [];
  const http = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    requests.push(JSON.parse(Buffer.concat(parts).toString()));
    if (rejectOnce && requests.length === 1) {
      response.writeHead(429, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'rate limit, retry later', type: 'rate_limit_error' } })); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1,
      model: 'local-http', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
    send({ role: 'assistant', content: 'Red Maple HTTP verified' });
    send({}, 'stop', { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
    response.end('data: [DONE]\n\n');
  });
  await new Promise(done => http.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => http.close(done)));
  return { requests, url: `http://127.0.0.1:${http.address().port}/v1` };
}

async function child(args, input = '') {
  const process = spawn(globalThis.process.execPath, [resolve('src/redmaple-cli.js'), ...args], { windowsHide: true,
    env: { ...globalThis.process.env, PI_OFFLINE: '1' } });
  let stdout = '', stderr = '';
  process.stdout.on('data', data => { stdout += data; });
  process.stderr.on('data', data => { stderr += data; });
  process.stdin.end(input);
  const code = await new Promise((done, reject) => { process.on('error', reject); process.on('close', done); });
  return { code, stdout, stderr };
}

test('redmaple CLI streams native JSON and exports an actual native session', async t => {
  const local = await server(t);
  const cwd = await mkdtemp(join(tmpdir(), 'redmaple-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const config = join(cwd, 'config.json');
  const extension = join(cwd, 'configured-extension.js');
  await writeFile(extension, `export default pi => pi.registerTool({
    name: 'configured_tool', label: 'Configured tool', description: 'A configured extension tool',
    parameters: {type: 'object', properties: {}},
    async execute() { return {content: [{type: 'text', text: 'configured'}]}; }
  });`);
  await writeFile(config, JSON.stringify({ cwd, agentDir: join(cwd, 'agent'), sessionDir: join(cwd, 'sessions'), policy: { profile: 'read-only' },
    resources: { additionalExtensionPaths: [extension] },
    model: { id: 'local-http', baseUrl: local.url, maxTokens: 1024, contextWindow: 100000 } }));
  const run = await child(['--config', config, '--mode', 'json', 'hello']);
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const events = run.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.ok(events.some(event => event.type === 'message_end' && JSON.stringify(event).includes('Red Maple HTTP verified')),
    JSON.stringify(events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant')));
  const header = events.find(event => event.type === 'session');
  assert.ok(header);
  assert.ok(local.requests[0].tools.some(tool => tool.function.name === 'configured_tool'));
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const sessions = await SessionManager.list(cwd, join(cwd, 'sessions'));
  const session = sessions.find(session => session.id === header.id);
  assert.ok(session);
  const output = join(cwd, 'conversation.html');
  const exported = await child(['--config', config, '--export', session.path, output]);
  assert.equal(exported.code, 0, exported.stderr);
  const html = await readFile(output, 'utf8');
  assert.ok(html.includes(Buffer.from('Red Maple HTTP verified').toString('base64').slice(0, 12))
    || [...html.matchAll(/[A-Za-z0-9+/=]{100,}/g)].some(match => Buffer.from(match[0], 'base64').toString('utf8').includes('Red Maple HTTP verified')),
  'Native export should contain the base64-encoded session transcript');
  assert.equal(local.requests.length, 1);
});

test('native retry after an explicit HTTP 429 records both sends in one run', async t => {
  const local = await server(t, true);
  const cwd = await mkdtemp(join(tmpdir(), 'redmaple-retry-'));
  const runtime = await createRedMapleRuntime({ cwd, agentDir: join(cwd, 'agent'), inMemory: true,
    model: { id: 'local-http', baseUrl: local.url, maxTokens: 1024, contextWindow: 100000 },
    settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 5 } } });
  t.after(async () => { await runtime.dispose(); await rm(cwd, { recursive: true, force: true }); });
  await runtime.session.prompt('retry a known refusal');
  assert.equal(local.requests.length, 2, JSON.stringify({ model: runtime.session.model, messages: runtime.session.messages.filter(message => message.role === 'assistant') }));
  const calls = Object.values(runtime.redmaple.controls.ledger.snapshot().calls);
  assert.deepEqual(calls.map(call => call.status), ['failed', 'succeeded']);
  assert.equal(new Set(calls.map(call => call.runId)).size, 1);
});

test('redmaple RPC uses the native protocol and releases storage after stdin closes', { timeout: 60000 }, async t => {
  const local = await server(t);
  const cwd = await mkdtemp(join(tmpdir(), 'redmaple-native-rpc-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const config = join(cwd, 'config.json');
  await writeFile(config, JSON.stringify({ cwd, agentDir: join(cwd, 'agent'), sessionDir: join(cwd, 'sessions'),
    model: { id: 'local-http', baseUrl: local.url, maxTokens: 1024, contextWindow: 100000 } }));
  const process = spawn(globalThis.process.execPath, [resolve('src/redmaple-cli.js'), '--config', config, '--mode', 'rpc'],
    { windowsHide: true, env: { ...globalThis.process.env, PI_OFFLINE: '1', REDMAPLE_TRACE_FILE: join(cwd, 'rpc-trace.jsonl') } });
  let stderr = '', buffer = '';
  const events = [];
  process.stderr.on('data', data => { stderr += data; });
  process.stdout.on('data', data => {
    buffer += data;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      const event = JSON.parse(line); events.push(event);
      if (event.type === 'agent_end') process.stdin.write(`${JSON.stringify({ type: 'get_state', id: 'state' })}\n`);
      if (event.type === 'response' && event.id === 'state') process.stdin.end();
    }
  });
  process.stdin.write(`${JSON.stringify({ type: 'prompt', id: 'prompt', message: 'hello RPC' })}\n`);
  const timer = setTimeout(() => process.kill(), 45000);
  const code = await new Promise((done, reject) => { process.on('error', reject); process.on('close', done); });
  clearTimeout(timer);
  assert.equal(code, 0, stderr);
  assert.ok(events.some(event => event.id === 'state' && event.success && event.data.messageCount >= 2));
  assert.ok(events.some(event => event.type === 'message_end' && JSON.stringify(event).includes('Red Maple HTTP verified')));
  assert.equal(local.requests.length, 1);
  const traceText = await readFile(join(cwd, 'rpc-trace.jsonl'), 'utf8');
  const stages = traceText.trim().split(/\r?\n/).map(line => JSON.parse(line).stage);
  for (const stage of ['main', 'sdk_loaded', 'runtime_ready', 'agent_end', 'stdin_end', 'dispose_end']) assert.ok(stages.includes(stage), stage);
  assert.ok(!traceText.includes('hello RPC'));
});
