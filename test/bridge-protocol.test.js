import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PaperPilotBridge } from '../src/paperpilot-bridge.js';

test('standalone bridge HTTP protocol preserves scope, encoding, approval errors and cancellation', async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    requests.push({ method: request.method, url: request.url, data });
    response.setHeader('Content-Type', 'application/json');
    if (request.url.endsWith('/apply') && !data.accepted) {
      response.writeHead(400);
      response.end(JSON.stringify({ detail: { code: 'acceptance_required', message: 'User approval required' } }));
    } else response.end(JSON.stringify({ ok: true, method: request.method, data: data || null }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  assert.throws(() => new PaperPilotBridge({ baseUrl }), { code: 'project_required' });
  const bridge = new PaperPilotBridge({ baseUrl, projectId: 'project/中文', conversationId: 'conversation&one' });
  for (const kind of ['workspace', 'research', 'memories', 'conversations', 'actions']) assert.equal((await bridge.read(kind)).ok, true);
  assert.equal(requests[0].url, '/api/projects/project%2F%E4%B8%AD%E6%96%87/agent/workspace');
  assert.ok(requests[4].url.endsWith('actions?conversation_id=conversation%26one'));
  assert.throws(() => bridge.read('../outside'), { code: 'invalid_operation' });
  const proposal = await bridge.propose({ operation: 'outline', request_id: 'one', conversation_id: 'override', run_id: 'override' });
  assert.equal(proposal.data.conversation_id, 'conversation&one');
  assert.equal(proposal.data.run_id, '');
  await bridge.preview('candidate/one?x', { selection: 'selected' });
  assert.ok(requests.at(-1).url.endsWith('actions/candidate%2Fone%3Fx/preview'));
  await assert.rejects(bridge.apply('one', { accepted: false }), { code: 'acceptance_required', knownOutcome: true });
  assert.equal((await bridge.apply('one', { accepted: true, expected_version: 1, action_fingerprint: 'hash' })).ok, true);
  assert.equal((await bridge.reject('one')).ok, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(bridge.read('workspace', controller.signal), { name: 'AbortError' });
});
