import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createAgentBase, createOpenAIModel, createOpenAITransport } from '../src/index.js';
import { tool } from './fixtures.js';

async function server(t, respond) {
  const requests = [];
  const http = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({
      id: 'local-response', object: 'chat.completion.chunk', created: 1, model: 'local-http',
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    })}\n\n`);
    await respond(body, requests.length, send);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(done => http.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => http.close(done)));
  return { url: `http://127.0.0.1:${http.address().port}/v1`, requests };
}

function child(command, args, options) {
  return new Promise((resolveResult, reject) => {
    const process = spawn(command, args, { ...options, windowsHide: true });
    let stdout = '';
    let stderr = '';
    process.stdout.on('data', part => { stdout += part; });
    process.stderr.on('data', part => { stderr += part; });
    process.on('error', reject);
    process.on('close', code => resolveResult({ code, stdout, stderr }));
  });
}

test('actual Pi OpenAI adapter streams from a local HTTP endpoint', async t => {
  const local = await server(t, async (_, count, send) => {
    send({ role: 'assistant', content: 'Hello ' });
    send({ content: 'from HTTP' });
    send({}, 'stop', { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
  });
  const model = createOpenAIModel({ id: 'local-http', baseUrl: local.url });
  const base = await createAgentBase({ model, streamFn: createOpenAITransport({ apiKey: 'fixture-only' }) });
  t.after(() => base.close());
  const chunks = [];
  base.subscribe(event => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') chunks.push(event.assistantMessageEvent.delta);
  });
  const result = await base.prompt('greet');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.text, 'Hello from HTTP');
  assert.equal(chunks.join(''), result.text);
  assert.equal(result.usage.tokens, 20);
  assert.equal(local.requests.length, 1);
  assert.equal(local.requests[0].stream, true);
});

test('malformed streamed JSON cannot invoke an empty-parameter tool', async t => {
  let effects = 0;
  const local = await server(t, async (_, count, send) => {
    if (count === 1) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'malformed', type: 'function',
        function: { name: 'effect', arguments: '{invalid' } }] });
      send({}, 'tool_calls');
    } else { send({ role: 'assistant', content: 'Invalid arguments rejected' }); send({}, 'stop'); }
  });
  const base = await createAgentBase({ model: createOpenAIModel({ id: 'local-http', baseUrl: local.url }),
    streamFn: createOpenAITransport({ apiKey: 'fixture' }), tools: [tool('effect', async () => {
      effects += 1; return { content: [{ type: 'text', text: 'unexpected' }] };
    })] });
  t.after(() => base.close());
  assert.equal((await base.prompt('test invalid arguments')).status, 'succeeded');
  assert.equal(effects, 0);
  assert.equal(local.requests.length, 2);
});

test('CLI uses actual streamed tool calls and keeps credentials out of session state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-base-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'note.txt'), 'Local evidence');
  const local = await server(t, async (body, count, send) => {
    if (count === 1) {
      assert.ok(body.tools.some(tool => tool.function.name === 'read'));
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'read-http', type: 'function',
        function: { name: 'read', arguments: '{"path":"note.txt"}' } }] });
      send({}, 'tool_calls');
    } else {
      assert.ok(body.messages.some(message => message.role === 'tool' && message.content.includes('Local evidence')));
      send({ role: 'assistant', content: 'File verified' });
      send({}, 'stop');
    }
  });
  const config = join(root, 'config.json');
  await writeFile(config, '\uFEFF' + JSON.stringify({ model: { id: 'local-http', baseUrl: local.url }, apiKeyEnv: 'AGENT_BASE_TEST_KEY' }));
  const result = await child(process.execPath, [resolve('src/cli.js'), '--config', config, '--workspace', root,
    '--session', 'integration', '--request-id', 'cli-request', '--prompt', 'Read the note', '--json'],
  { cwd: resolve('.'), env: { ...process.env, AGENT_BASE_TEST_KEY: 'fixture-private-key' } });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const events = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(events.at(-1).result.status, 'succeeded');
  assert.equal(events.at(-1).result.text, 'File verified');
  assert.ok(events.some(item => item.event?.type === 'tool_execution_end'));
  const state = await readFile(join(root, '.agent-base', 'integration.json'), 'utf8');
  assert.ok(!state.includes('fixture-private-key'));
  assert.equal(local.requests.length, 2);
});

test('JSONL RPC exposes prompt and snapshot through the normal CLI entry point', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-base-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = await server(t, async (_, count, send) => { send({ role: 'assistant', content: 'RPC complete' }); send({}, 'stop'); });
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ model: { id: 'local-http', baseUrl: local.url }, workspaceTools: false }));
  const proc = spawn(process.execPath, [resolve('src/cli.js'), '--config', config, '--workspace', root, '--rpc'],
    { cwd: resolve('.'), windowsHide: true, env: { ...process.env, OPENAI_API_KEY: 'fixture-rpc' } });
  let output = '';
  let errors = '';
  proc.stdout.on('data', part => { output += part; });
  proc.stderr.on('data', part => { errors += part; });
  const closed = new Promise((done, reject) => { proc.on('close', done); proc.on('error', reject); });
  proc.stdin.end(`${JSON.stringify({ id: 'rpc-task', method: 'prompt', params: { input: 'task' } })}\n`);
  assert.equal(await closed, 0, errors);
  const messages = output.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(messages.find(message => message.id === 'rpc-task').result.text, 'RPC complete');
});
