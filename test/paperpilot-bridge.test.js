import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PaperPilotBridge } from '../src/paperpilot-bridge.js';

const hostRoot = process.env.REDMAPLE_PAPERPILOT_ROOT
  ? resolve(process.env.REDMAPLE_PAPERPILOT_ROOT) : fileURLToPath(new URL('../../', import.meta.url));
const hostServer = join(hostRoot, 'tests', 'ui_scholar_server.py');
const hostAvailable = existsSync(hostServer);

test('PaperPilot bridge uses actual isolated API, versioned candidates and native scholar state', {
  timeout: 90000, skip: !hostAvailable && !process.env.REDMAPLE_PAPERPILOT_ROOT,
}, async t => {
  assert.ok(hostAvailable, 'REDMAPLE_PAPERPILOT_ROOT must contain tests/ui_scholar_server.py');
  const storage = await mkdtemp(join(tmpdir(), 'redmaple-host-'));
  const listener = createServer();
  await new Promise(done => listener.listen(0, '127.0.0.1', done));
  const port = listener.address().port;
  await new Promise(done => listener.close(done));
  const root = hostRoot;
  const server = spawn('python', [join(root, 'tests', 'ui_scholar_server.py'), '--storage', storage, '--port', String(port)],
    { cwd: root, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', data => { log += data; });
  server.stderr.on('data', data => { log += data; });
  let processError;
  server.on('error', error => { processError = error; });
  const closed = new Promise(done => server.on('close', done));
  t.after(async () => { server.kill(); await closed; await rm(storage, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45000;
  let ready = false;
  while (Date.now() < deadline) {
    if (processError) throw processError;
    if (server.exitCode !== null) throw new Error(log);
    try { if ((await fetch(`${url}/api/projects`)).ok) { ready = true; break; } } catch {}
    await new Promise(done => setTimeout(done, 250));
  }
  assert.ok(ready, log);
  const response = await fetch(`${url}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Red Maple isolated integration', domain: '材料', style: '严谨' }) });
  assert.equal(response.status, 200, await response.clone().text());
  const pid = (await response.json()).project.id;
  const bridge = new PaperPilotBridge({ baseUrl: url, projectId: pid });
  assert.ok(await bridge.read('workspace'));
  const research = await bridge.read('research');
  assert.equal(research.revision, 0);
  assert.equal(research.skill.available, true);
  const outline = await (await fetch(`${url}/api/projects/${pid}/outline/structured`)).json();
  const proposal = await bridge.propose({ operation: 'outline', request_id: randomUUID(), base_version: outline.version,
    payload: { operations: [{ op: 'add_node', node: { id: 'maple-node', title: 'Red Maple candidate' } }] }, source_refs: [] });
  const preview = await bridge.preview(proposal.id);
  await assert.rejects(bridge.apply(proposal.id, { request_id: randomUUID(), accepted: false,
    expected_version: preview.base_version, action_fingerprint: preview.action_fingerprint }), { code: 'acceptance_required' });
  const data = { request_id: randomUUID(), accepted: true, expected_version: preview.base_version, action_fingerprint: preview.action_fingerprint };
  assert.equal((await bridge.apply(proposal.id, data)).status, 'applied');
  assert.equal((await bridge.apply(proposal.id, data)).idempotent_replay, true);
  const changed = await (await fetch(`${url}/api/projects/${pid}/outline/structured`)).json();
  assert.ok(changed.nodes.some(node => node.id === 'maple-node'));
  assert.equal((await bridge.read('actions')).cards[0].status, 'applied');
});
