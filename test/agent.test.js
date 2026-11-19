import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentBase, FileStore, MemoryStore, textResult } from '../src/index.js';
import { AgentBaseError } from '../src/shared.js';
import { model, scripted, assistant, call, deferred, tool } from './fixtures.js';

test('real Pi loop continues after complete-looking tool results with one system prompt', async t => {
  const script = scripted([
    assistant([call('one', 'first')], 'toolUse'),
    assistant([call('two', 'second')], 'toolUse'),
    assistant('All steps complete'),
  ]);
  const events = [];
  const base = await createAgentBase({ model, ...script, tools: [
    tool('first', async (_, args, signal, update) => { update(textResult('working')); return textResult('partial', { complete: true }); }),
    tool('second', async () => textResult('second result')),
  ] });
  t.after(() => base.close());
  base.subscribe(event => events.push(event.type));
  const result = await base.prompt('Do both tasks', { requestId: 'multi' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.text, 'All steps complete');
  assert.equal(result.usage.modelCalls, 3);
  assert.equal(result.usage.toolCalls, 2);
  assert.deepEqual(script.requests.map(request => request.messages.filter(message => message.role === 'system').length), [1, 1, 1]);
  assert.ok(events.includes('tool_execution_update'));
  assert.ok(events.includes('message_update'));
  assert.equal(base.snapshot().messages.filter(message => message.role === 'assistant').length, 3);
});

test('concurrent duplicate requests share one run and changed input is rejected', async t => {
  const release = deferred();
  const script = scripted([async () => { await release.promise; return assistant('done'); }]);
  const base = await createAgentBase({ model, ...script });
  t.after(() => base.close());
  const first = base.prompt('task', { requestId: 'same' });
  const duplicate = base.prompt('task', { requestId: 'same' });
  assert.equal(first, duplicate);
  release.resolve();
  assert.equal((await first).status, 'succeeded');
  assert.equal((await base.prompt('task', { requestId: 'same' })).status, 'succeeded');
  await assert.rejects(base.prompt('different', { requestId: 'same' }), { code: 'idempotency_conflict' });
  assert.equal(script.requests.length, 1);
});

test('a tool observes the durably persisted assistant request before execution', async t => {
  const store = new MemoryStore();
  const script = scripted([assistant([call('read', 'read')], 'toolUse'), assistant('done')]);
  const base = await createAgentBase({ model, ...script, store, tools: [tool('read', async () => {
    assert.equal(store.snapshot().messages.at(-1).content[0].id, 'read');
    assert.equal(Object.values(store.snapshot().calls).at(-1).status, 'pending');
    return textResult('read');
  })] });
  t.after(() => base.close());
  assert.equal((await base.prompt('task')).status, 'succeeded');
});

test('budgets block the next provider request and truncation remains visible', async t => {
  const reply = assistant([call('read', 'read')], 'toolUse');
  reply.usage.totalTokens = -10;
  const script = scripted([reply]);
  const base = await createAgentBase({ model, ...script, limits: { modelCalls: 1 },
    tools: [tool('read', async () => textResult('read'))] });
  t.after(() => base.close());
  const result = await base.prompt('task');
  assert.equal(result.status, 'blocked');
  assert.equal(result.errorCode, 'budget_exhausted');
  assert.ok(result.usage.tokens > 0);
  assert.equal(script.requests.length, 1);
  const truncated = await createAgentBase({ model, ...scripted([assistant('partial', 'length')]) });
  t.after(() => truncated.close());
  assert.equal((await truncated.prompt('task')).status, 'truncated');
});

test('invalid schema arguments cannot enter the tool handler', async t => {
  let executed = 0;
  const script = scripted([assistant([call('bad', 'validated', { n: -1 })], 'toolUse'), assistant('invalid request explained')]);
  const base = await createAgentBase({ model, ...script, tools: [tool('validated', async () => {
    executed += 1; return textResult('wrong');
  }, { parameters: { type: 'object', properties: { n: { type: 'integer', minimum: 1 } }, required: ['n'], additionalProperties: false } })] });
  t.after(() => base.close());
  assert.equal((await base.prompt('task')).status, 'succeeded');
  assert.equal(executed, 0);
  assert.equal(script.requests[1].messages.at(-1).isError, true);
});

test('cancellation fences a late successful tool result', async t => {
  const started = deferred();
  const release = deferred();
  const base = await createAgentBase({ model, ...scripted([assistant([call('slow', 'slow')], 'toolUse')]),
    tools: [tool('slow', async () => { started.resolve(); await release.promise; return textResult('late'); })] });
  t.after(() => base.close());
  const pending = base.prompt('task');
  await started.promise;
  await base.abort();
  assert.equal(Object.values(base.snapshot().runs)[0].cancelRequested, true);
  release.resolve();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.text, '');
  assert.equal(Object.values(base.snapshot().calls).find(entry => entry.kind === 'tool').status, 'succeeded');
});

test('unknown side effects require reconciliation and never execute twice on resume', async t => {
  let executed = 0;
  const script = scripted([assistant([call('effect', 'effect')], 'toolUse'), assistant('verified result used')]);
  const base = await createAgentBase({ model, ...script, tools: [tool('effect', async () => {
    executed += 1; throw new Error('transport disconnected after side effect');
  })] });
  t.after(() => base.close());
  const first = await base.prompt('task', { requestId: 'recover' });
  assert.equal(first.status, 'blocked');
  await assert.rejects(base.resume('recover'), { code: 'result_unknown' });
  await assert.rejects(base.prompt('new work'), { code: 'result_unknown' });
  const unknown = Object.values(base.snapshot().calls).find(entry => entry.status === 'unknown');
  await base.reconcile(unknown.key, textResult('verified at provider'));
  const result = await base.resume('recover');
  assert.equal(result.status, 'succeeded');
  assert.equal(executed, 1);
  assert.equal(script.requests[1].messages.at(-1).content[0].text, 'verified at provider');
});

test('steering and follow-up queues persist and are consumed by the real Pi loop', async t => {
  const started = deferred();
  const release = deferred();
  const script = scripted([
    async () => { started.resolve(); await release.promise; return assistant([call('read', 'read')], 'toolUse'); },
    assistant('steering applied'), assistant('follow-up applied'),
  ]);
  const base = await createAgentBase({ model, ...script, tools: [tool('read', async () => textResult('data'))] });
  t.after(() => base.close());
  const running = base.prompt('original');
  await started.promise;
  await base.steer('change direction');
  await base.followUp('then summarize');
  assert.equal(base.snapshot().queues.steering.length, 1);
  release.resolve();
  const result = await running;
  assert.equal(result.status, 'succeeded');
  assert.equal(script.requests.length, 3);
  assert.equal(base.snapshot().queues.steering.length, 0);
  assert.equal(base.snapshot().queues.followUp.length, 0);
  assert.ok(script.requests[1].messages.some(message => Array.isArray(message.content) && message.content.some(item => item.text === 'change direction')));
  assert.ok(script.requests[2].messages.some(message => Array.isArray(message.content) && message.content.some(item => item.text === 'then summarize')));
});

test('file sessions lock competing owners, retain history and reject incompatible tool versions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-base-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await FileStore.open(directory, 'session');
  await assert.rejects(FileStore.open(directory, 'session'), { code: 'session_locked' });
  const base = await createAgentBase({ model, ...scripted([assistant('saved')]), store });
  await base.prompt('task', { requestId: 'persisted' });
  await base.close();
  const reopened = await FileStore.open(directory, 'session');
  const replay = scripted([]);
  const restored = await createAgentBase({ model, ...replay, store: reopened });
  assert.equal((await restored.prompt('task', { requestId: 'persisted' })).text, 'saved');
  assert.equal(replay.requests.length, 0);
  await restored.close();
  const changed = await FileStore.open(directory, 'session');
  await assert.rejects(createAgentBase({ model, ...scripted([]), store: changed, profileVersion: 'changed' }),
    { code: 'session_incompatible' });
  const unlocked = await FileStore.open(directory, 'session');
  await unlocked.close();
});

test('tool catalog discovers and loads tools beyond a provider cap', async t => {
  const script = scripted([
    assistant([call('search', 'search_tools', { query: 'target' })], 'toolUse'),
    assistant([call('load', 'load_tools', { names: ['target'] })], 'toolUse'),
    assistant([call('target', 'target')], 'toolUse'), assistant('target complete'),
  ]);
  const tools = ['one', 'two', 'three', 'target'].map(name => tool(name, async () => textResult(name)));
  const base = await createAgentBase({ model, ...script, tools, maxTools: 3 });
  t.after(() => base.close());
  const result = await base.prompt('find target');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.usage.toolCalls, 3);
  assert.deepEqual(base.agent.state.tools.map(item => item.name).sort(), ['load_tools', 'search_tools', 'target']);
});

test('host hooks and plugin lifecycle carry policy, result transforms and call identities', async () => {
  const actions = [];
  const script = scripted([assistant([call('allowed', 'business')], 'toolUse'), assistant('business answer')]);
  const plugin = { id: 'business-domain', version: '1', tools: [tool('business', async () => textResult('proposal'))],
    attach: async () => actions.push('attached'), dispose: async () => actions.push('disposed') };
  const base = await createAgentBase({ model, plugins: [plugin],
    streamFn: (model, context, options) => {
      assert.ok(options.hostContext.callKey.startsWith('hooks:model:'));
      return script.streamFn(model, context, options);
    },
    prepareRequest: async () => { actions.push('prepare'); },
    beforeToolCall: async context => { actions.push(context.toolCall.name); },
    afterToolCall: async () => ({ content: [{ type: 'text', text: 'audited proposal' }] }),
  });
  assert.equal((await base.prompt('business task', { requestId: 'hooks' })).status, 'succeeded');
  assert.equal(script.requests[1].messages.at(-1).content[0].text, 'audited proposal');
  await base.close();
  assert.deepEqual(actions, ['attached', 'prepare', 'business', 'prepare', 'disposed']);
});

test('a known host refusal leaves no unknown external request', async t => {
  const base = await createAgentBase({ model, streamFn: () => {
    throw new AgentBaseError('permission_revoked', 'Host rejected the request before sending', { knownOutcome: true });
  } });
  t.after(() => base.close());
  const result = await base.prompt('task');
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'permission_revoked');
  assert.ok(Object.values(base.snapshot().calls).every(call => call.status === 'failed'));
});

test('time budget preserves sent unknown calls until reconciliation before a new bounded task', async t => {
  const script = scripted([async () => {
    await new Promise(done => setTimeout(done, 40)); return assistant('late');
  }, assistant('new task')]);
  const base = await createAgentBase({ model, ...script, limits: { seconds: 0.01 } });
  t.after(() => base.close());
  const first = await base.prompt('slow', { requestId: 'slow' });
  assert.equal(first.status, 'blocked');
  assert.equal(first.errorCode, 'time_exhausted');
  const unknown = Object.values(base.snapshot().calls).find(item => item.status === 'unknown');
  assert.ok(unknown, 'The timed-out request was sent and needs an external result');
  await assert.rejects(base.resume('slow'), { code: 'result_unknown' });
  await assert.rejects(base.prompt('new task', { requestId: 'new' }), { code: 'result_unknown' });
  await base.reconcile(unknown.key, assistant('late'));
  await assert.rejects(base.resume('slow'), { code: 'budget_exhausted' });
  base.limits.seconds = 10;
  assert.equal((await base.prompt('new task', { requestId: 'new' })).status, 'succeeded');
});

test('a tool call identifier cannot be reused for a different tool with identical arguments', async t => {
  let secondCalls = 0;
  const script = scripted([assistant([call('same-id', 'one')], 'toolUse'), assistant([call('same-id', 'two')], 'toolUse')]);
  const base = await createAgentBase({ model, ...script, tools: [
    tool('one', async () => textResult('one')),
    tool('two', async () => { secondCalls += 1; return textResult('two'); }),
  ] });
  t.after(() => base.close());
  const result = await base.prompt('two operations');
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'call_input_changed');
  assert.equal(secondCalls, 0);
});

test('plugin cleanup errors still dispose remaining plugins and release the file owner', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-base-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const disposed = [];
  const base = await createAgentBase({ model, ...scripted([]), store: await FileStore.open(directory, 'cleanup'), plugins: [
    { id: 'good', dispose: async () => disposed.push('good') },
    { id: 'broken', dispose: async () => { disposed.push('broken'); throw new Error('cleanup error'); } },
  ] });
  await assert.rejects(base.close(), AggregateError);
  assert.deepEqual(disposed, ['broken', 'good']);
  const reopened = await FileStore.open(directory, 'cleanup');
  await reopened.close();
});

test('nested model calls share the run budget and the same sending hook', async t => {
  const purposes = [];
  const script = scripted([assistant([call('nested', 'nested')], 'toolUse'), assistant('nested answer')]);
  let base;
  base = await createAgentBase({ model, ...script, limits: { modelCalls: 2 },
    beforeModelCall: async ({ call }) => purposes.push(call.purpose),
    tools: [tool('nested', async (_, args, signal) => {
      const stream = base.modelStream(model, { messages: [{ role: 'user', content: 'nested request', timestamp: 1 }] },
        { signal }, 'extension');
      for await (const event of stream) { /* Drain the budgeted nested response. */ }
      return textResult((await stream.result()).content[0].text);
    })] });
  t.after(() => base.close());
  const result = await base.prompt('perform nested work');
  assert.equal(result.status, 'blocked');
  assert.equal(result.errorCode, 'budget_exhausted');
  assert.equal(result.usage.modelCalls, 2);
  assert.deepEqual(purposes, ['response', 'extension']);
  assert.equal(script.requests.length, 2);
});

test('sending hook denial is recorded as an unsent failure', async t => {
  const script = scripted([]);
  const base = await createAgentBase({ model, ...script, beforeModelCall: async () => {
    throw new AgentBaseError('consent_required', 'Model scope needs review');
  } });
  t.after(() => base.close());
  const result = await base.prompt('task');
  assert.equal(result.errorCode, 'consent_required');
  assert.equal(result.usage.tokens, 0);
  assert.equal(script.requests.length, 0);
  assert.equal(Object.values(base.snapshot().calls)[0].status, 'failed');
});
