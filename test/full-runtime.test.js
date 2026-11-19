import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, symlink, writeFile, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRedMapleRuntime } from '../src/full-runtime.js';
import { PlatformState } from '../src/platform.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { model, assistant, call, scripted } from './fixtures.js';
import { logoPath } from '../src/branding.js';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';

async function fixture(t, replies = [assistant('complete')], extra = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'redmaple-full-'));
  const agentDir = join(cwd, 'agent');
  const script = scripted(replies);
  const options = { cwd, agentDir, model, streamFn: script.streamFn, inMemory: true,
    resources: { noExtensions: true, noSkills: true, noPromptTemplates: true },
    policy: { profile: 'trusted' }, settings: { retry: { enabled: false } }, ...extra };
  const runtime = await createRedMapleRuntime(options);
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); await runtime.dispose(); await rm(cwd, { recursive: true, force: true }); });
  return { runtime, cwd, agentDir, script, options, cleanups };
}

test('full SDK uses native tools, Code Mode, themes, resources and one ledger', async t => {
  const f = await fixture(t, [assistant([call('r1', 'read', { path: 'note.txt' })], 'toolUse'), assistant('complete')]);
  await writeFile(join(f.cwd, 'note.txt'), 'source');
  assert.deepEqual(f.runtime.services.resourceLoader.getExtensions().errors, []);
  const tools = f.runtime.session.getAllTools().map(tool => tool.name);
  for (const name of ['read', 'bash', 'powershell', 'edit', 'write', 'find', 'grep', 'ls', 'codemode', 'tool_search',
    'redmaple_plan', 'redmaple_memory', 'redmaple_delegate', 'redmaple_propose', 'redmaple_image']) assert.ok(tools.includes(name), name);
  assert.ok(f.runtime.services.resourceLoader.getThemes().themes.some(theme => theme.name === 'redmaple'));
  await f.runtime.session.prompt('read the note');
  assert.deepEqual(Object.values(f.runtime.redmaple.controls.ledger.snapshot().calls).map(call => [call.kind, call.status]),
    [['model', 'succeeded'], ['tool', 'succeeded'], ['model', 'succeeded']]);
  assert.equal(f.script.requests.length, 2);
});

test('native session replacements release locks and preserve resources', async t => {
  const { runtime } = await fixture(t, [assistant('first'), assistant('second')]);
  const first = runtime.session.sessionId;
  await runtime.session.prompt('one');
  await runtime.newSession();
  assert.notEqual(first, runtime.session.sessionId);
  await runtime.session.prompt('two');
  assert.equal(Object.values(runtime.redmaple.controls.ledger.snapshot().runs).length, 1);
});

test('native resource hot reload retains runtime settings and deferred tool discovery', async t => {
  const { runtime } = await fixture(t, [assistant('reloaded')], { settings: { theme: 'redmaple-light', retry: { enabled: false } } });
  await runtime.session.reload();
  assert.equal(runtime.services.settingsManager.getThemeSetting(), 'redmaple-light');
  assert.ok(runtime.session.getActiveToolNames().includes('tool_search'));
  await runtime.session.prompt('after reload');
  assert.equal(Object.values(runtime.redmaple.controls.ledger.snapshot().calls).length, 1);
});

test('shared native ModelRuntime is metered once and restored after final owner closes', async t => {
  const first = await fixture(t, [assistant('one'), assistant('two')]);
  const shared = first.runtime.services.modelRuntime;
  const script = scripted([assistant('two'), assistant('three')]);
  const second = await createRedMapleRuntime({ ...first.options, modelRuntime: shared, streamFn: script.streamFn });
  try {
    await first.runtime.session.prompt('first');
    await second.session.prompt('second');
    assert.equal(first.script.requests.length, 1);
    assert.equal(Object.values(first.runtime.redmaple.controls.ledger.snapshot().calls).length, 1);
    assert.equal(Object.values(second.redmaple.controls.ledger.snapshot().calls).length, 1);
    await first.runtime.dispose();
    await second.session.prompt('third');
    assert.equal(Object.values(second.redmaple.controls.ledger.snapshot().calls).length, 2);
  } finally { await second.dispose(); }
});

test('runtime cleanup failures still restore the shared model transport', async t => {
  const f = await fixture(t);
  const controls = f.runtime.redmaple.controls;
  const close = controls.close.bind(controls);
  const models = f.runtime.services.modelRuntime;
  controls.close = async () => { await close(); throw new Error('cleanup fixture'); };
  try {
    await assert.rejects(f.runtime.dispose(), /Red Maple cleanup failed/);
    assert.equal(models.streamSimple, Object.getPrototypeOf(models).streamSimple);
  } finally { controls.close = close; }
});

test('workspace policy blocks external paths before native read executes', async t => {
  const { runtime } = await fixture(t, [assistant('complete')], { policy: { profile: 'workspace' } });
  await assert.rejects(runtime.session.getToolDefinition('read').execute('outside', { path: '../private' }), { code: 'outside_workspace' });
  assert.equal(Object.keys(runtime.redmaple.controls.ledger.snapshot().calls).length, 0);
});

test('money gate rejects incomplete prices before dispatch and applies explicit zero prices', async t => {
  const f = await fixture(t, [assistant('no')], { money: { amount: 1 }, pricing: { 'openai/local-test': { input: 1 } } });
  await f.runtime.session.prompt('blocked');
  assert.equal(f.script.requests.length, 0);
  assert.equal(Object.values(f.runtime.redmaple.controls.ledger.snapshot().calls)[0].status, 'failed');
  const free = await fixture(t, [assistant('yes')], { money: { amount: 1 },
    pricing: { 'openai/local-test': { input: 0, output: 0 } } });
  await free.runtime.session.prompt('allowed');
  assert.equal(free.script.requests.length, 1);
});

test('image edit preprocessing and native image generation share parent accounting', async t => {
  let inputs;
  const image = { ...model, type: 'image', id: 'image', name: 'Image fixture', api: 'fixture-images',
    provider: 'visual-fixture', input: ['text', 'image'], output: ['image'] };
  const f = await fixture(t, [assistant([call('image', 'redmaple_image', { model: 'visual-fixture/image', prompt: 'edit image', images: ['leaf.png'] })], 'toolUse'), assistant('image complete')],
    { tools: ['redmaple_image'], money: { amount: 1 }, pricing: { 'openai/local-test': { input: 0, output: 0 },
      'visual-fixture/image': { input: 0, output: 0, request: 0.02 } }, providers: {
      'visual-fixture': { baseUrl: 'http://127.0.0.1', apiKey: 'fixture', models: [image],
        images: { 'fixture-images': { async generateImages(chosen, context) {
          inputs = context.input;
          return { api: chosen.api, provider: chosen.provider, model: chosen.id, output: [{ type: 'image', data: inputs[1].data, mimeType: 'image/png' }],
            stopReason: 'stop', timestamp: Date.now(), usage: assistant('').usage };
        } } } },
    } });
  await copyFile(logoPath.replace(/\.svg$/, '.png'), join(f.cwd, 'leaf.png'));
  await f.runtime.session.prompt('edit the leaf');
  assert.equal(inputs?.[1]?.mimeType, 'image/png');
  const state = f.runtime.redmaple.controls.ledger.snapshot();
  assert.ok(Object.values(state.calls).some(call => call.purpose === 'generateImages' && call.status === 'succeeded'));
  assert.equal(Object.values(state.runs)[0].usage.cost, 0.02);
});

test('multimodal token reservations use native image estimates rather than encoded image bytes', async t => {
  const f = await fixture(t, [assistant('image inspected')], { model: { ...model, input: ['text', 'image'] } });
  await f.runtime.session.prompt('inspect the attached image', {
    images: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(900000) }],
  });
  assert.equal(f.script.requests.length, 1);
  const state = f.runtime.redmaple.controls.ledger.snapshot();
  assert.equal(Object.values(state.runs)[0].status, 'succeeded');
  assert.equal(Object.values(state.calls)[0].status, 'succeeded');
});

test('manual native compaction uses the same model ledger and retains original session history', async t => {
  const f = await fixture(t, [assistant('one'), assistant('two'), assistant('summary with task and sources')],
    { settings: { retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 100, reserveTokens: 1024 } } });
  await f.runtime.session.prompt('original task and evidence '.repeat(150));
  await f.runtime.session.prompt('follow-up evidence '.repeat(100));
  await f.runtime.session.compact();
  assert.equal(f.script.requests.length, 3);
  assert.equal(Object.values(f.runtime.redmaple.controls.ledger.snapshot().calls).filter(call => call.kind === 'model').length, 3);
  assert.ok(f.runtime.session.sessionManager.getEntries().some(entry => entry.type === 'compaction'));
  assert.ok(f.runtime.session.sessionManager.getEntries().some(entry => JSON.stringify(entry).includes('original task and evidence')));
});

test('native compaction budgets active tool schemas and keeps the next request within capacity', async t => {
  let summaryLimit;
  const f = await fixture(t, [assistant('earlier response'), assistant('recent response'), async (_, options) => {
    summaryLimit = options.maxTokens;
    return assistant('summary '.repeat(Math.max(1, Math.floor(summaryLimit / 2))));
  }, assistant('continued within capacity')], {
    model: { ...model, contextWindow: 12288 }, maxOutputTokens: 2048,
    tools: ['read', 'large_tool'],
    customTools: [{ name: 'large_tool', label: 'Large schema fixture', description: 'x'.repeat(33000),
      parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) }],
    settings: { retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 100, reserveTokens: 2048 } },
  });
  assert.equal(f.runtime.session.model.contextWindow, 12288);
  await f.runtime.session.prompt('original task '.repeat(30));
  assert.equal(f.runtime.session.messages.at(-1).stopReason, 'stop', f.runtime.session.messages.at(-1).errorMessage);
  await f.runtime.session.prompt('recent task '.repeat(80));
  assert.equal(f.runtime.session.messages.at(-1).stopReason, 'stop', f.runtime.session.messages.at(-1).errorMessage);
  await f.runtime.session.compact();
  assert.ok(summaryLimit > 0 && summaryLimit < 2048, `summary reservation ${summaryLimit}`);
  const projection = f.runtime.session.sessionManager.buildSessionProjection();
  assert.ok(getCurrentSystemMessage(projection.messages).toolsAdded.some(tool => tool.name === 'large_tool'));
  const estimate = f.runtime.redmaple.controls.ledger.options.estimateTokens;
  assert.ok(estimate({ messages: projection.messages }) + 2048 <= 12288);
  await f.runtime.session.prompt('continue');
  assert.equal(f.script.requests.length, 4);
  assert.equal(f.runtime.session.messages.at(-1).stopReason, 'stop');
});

test('automatic native compaction triggers once and a following user turn continues', async t => {
  const largeUsage = assistant('completed before threshold compaction');
  largeUsage.usage = { ...largeUsage.usage, input: 12500, output: 100, totalTokens: 12600 };
  const f = await fixture(t, [assistant('initial context'), largeUsage, assistant('checkpoint preserving the original task'), assistant('continued after checkpoint')], {
    model: { ...model, contextWindow: 16384 }, maxOutputTokens: 2048,
    settings: { retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 100 } },
  });
  assert.equal(f.runtime.session.model.contextWindow, 16384);
  await f.runtime.session.prompt('original task and constraints '.repeat(100));
  await f.runtime.session.prompt('additional evidence '.repeat(100));
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'compaction').length, 1);
  assert.equal(f.script.requests.length, 3);
  await f.runtime.session.prompt('continue this task');
  assert.equal(f.script.requests.length, 4);
  assert.equal(f.runtime.session.messages.at(-1).stopReason, 'stop');
  assert.equal(f.runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'compaction').length, 1);
});

test('failed native compaction preserves original history and permits a later user turn', async t => {
  const f = await fixture(t, [assistant('one'), assistant('two'), () => { throw new Error('summary connection interrupted'); }, assistant('continued')], {
    settings: { retry: { enabled: false }, compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 100 } },
  });
  await f.runtime.session.prompt('original goal '.repeat(100));
  await f.runtime.session.prompt('evidence to preserve '.repeat(100));
  const originalEntries = structuredClone(f.runtime.session.sessionManager.getEntries());
  await assert.rejects(f.runtime.session.compact(), /summary connection interrupted/);
  assert.deepEqual(f.runtime.session.sessionManager.getEntries(), originalEntries);
  await f.runtime.session.prompt('continue after the failed summary');
  assert.equal(f.script.requests.length, 4);
  assert.equal(f.runtime.session.messages.at(-1).stopReason, 'stop');
});

test('registered skill metadata stays compact, bodies load on demand and external read access stays scoped', async t => {
  const root = await mkdtemp(join(tmpdir(), 'redmaple-skill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillRoot = join(root, 'registered-skill');
  await mkdir(join(skillRoot, 'references'), { recursive: true });
  await mkdir(join(root, 'private'));
  const skillPath = join(skillRoot, 'SKILL.md');
  await writeFile(skillPath, '---\nname: audit-skill\ndescription: A & B <tag>\n---\nONLY_LOAD_BODY_ON_DEMAND\nRead references/method.md when applying this skill.\n');
  await writeFile(join(skillRoot, 'references', 'method.md'), 'REGISTERED_REFERENCE');
  await writeFile(join(root, 'private', 'note.txt'), 'OUTSIDE_REGISTERED_ROOT');
  await symlink(join(root, 'private'), join(skillRoot, 'outside-link'), 'junction');
  const f = await fixture(t, [assistant('skill applied'), assistant('evidence recorded'), assistant('checkpoint with skill source'), assistant('continued')], {
    policy: { profile: 'workspace' },
    resources: { noExtensions: true, noSkills: true, noPromptTemplates: true, additionalSkillPaths: [skillPath] },
    settings: { retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 100, reserveTokens: 1024 } },
  });
  assert.ok(f.runtime.session.systemPrompt.includes('A &amp; B &lt;tag&gt;'));
  assert.ok(!f.runtime.session.systemPrompt.includes('ONLY_LOAD_BODY_ON_DEMAND'));
  const read = f.runtime.session.getToolDefinition('read');
  const skillResult = await read.execute('skill-body', { path: skillPath });
  assert.ok(skillResult.content.some(block => block.text?.includes('ONLY_LOAD_BODY_ON_DEMAND')));
  const reference = await read.execute('skill-reference', { path: join(skillRoot, 'references', 'method.md') });
  assert.ok(reference.content.some(block => block.text?.includes('REGISTERED_REFERENCE')));
  await assert.rejects(read.execute('unregistered-file', { path: join(root, 'private', 'note.txt') }), { code: 'outside_workspace' });
  await assert.rejects(read.execute('symlink-escape', { path: join(skillRoot, 'outside-link', 'note.txt') }), { code: 'outside_workspace' });
  await assert.rejects(f.runtime.session.getToolDefinition('write').execute('outside-write', { path: skillPath, content: 'changed' }), { code: 'outside_workspace' });
  await f.runtime.session.prompt('/skill:audit-skill apply this method');
  assert.ok(JSON.stringify(f.script.requests[0].messages).includes('ONLY_LOAD_BODY_ON_DEMAND'));
  assert.ok(!JSON.stringify(f.script.requests[0].messages).includes('OUTSIDE_REGISTERED_ROOT'));
  await f.runtime.session.prompt('evidence and conditions '.repeat(100));
  await f.runtime.session.compact();
  const projection = f.runtime.session.sessionManager.buildSessionProjection();
  assert.ok(getCurrentSystemMessage(projection.messages).sections.skills.includes('audit-skill'));
  assert.ok(JSON.stringify(f.script.requests[2].messages).includes('Preserve invoked skill names and source paths'));
  await f.runtime.session.prompt('continue with the registered method');
  assert.equal(f.script.requests.length, 4);
  assert.equal(f.runtime.session.messages.at(-1).stopReason, 'stop');
});

test('SQLite session ownership, persistence and release are enforced', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'redmaple-sql-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const file = join(cwd, 'sessions.sqlite');
  const store = await SqliteStore.open(file, 'a');
  await assert.rejects(SqliteStore.open(file, 'a', { recoverLock: true }), { code: 'session_locked' });
  await store.update(state => { state.context.test = 'saved'; });
  await store.close();
  const reopened = await SqliteStore.open(file, 'a');
  assert.equal(reopened.snapshot().context.test, 'saved');
  await reopened.close();
});

test('unknown result reconciliation preserves the canonical native transcript', async t => {
  const f = await fixture(t, [() => { throw new Error('connection lost after send'); }, assistant('continued')]);
  await f.runtime.session.prompt('keep this original goal');
  const unknown = Object.values(f.runtime.redmaple.controls.ledger.snapshot().calls).find(call => call.status === 'unknown');
  assert.ok(unknown);
  await f.runtime.redmaple.controls.reconcile(unknown.key, assistant('externally verified answer'));
  assert.ok(f.runtime.session.messages.some(message => JSON.stringify(message).includes('keep this original goal')));
  await f.runtime.session.prompt('continue with verified result');
  assert.equal(f.script.requests.length, 2);
  assert.ok(f.script.requests[1].messages.some(message => JSON.stringify(message).includes('externally verified answer')));
});

test('an interrupted chat response retains unknown accounting and permits the next user turn', async t => {
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const f = await fixture(t, [async (_, options) => {
    requestStarted();
    await new Promise(resolve => {
      if (options.signal.aborted) resolve();
      else options.signal.addEventListener('abort', resolve, { once: true });
    });
    return assistant([], 'aborted');
  }, assistant('I am Red Maple')]);
  const first = f.runtime.session.prompt('who are you');
  await started;
  await f.runtime.session.abort();
  await first;
  const controls = f.runtime.redmaple.controls;
  const interrupted = Object.values(controls.ledger.snapshot().calls).find(item => item.status === 'unknown');
  assert.equal(interrupted?.purpose, 'response');
  const usage = structuredClone(controls.ledger.snapshot().runs[interrupted.runId].usage);
  await f.runtime.session.prompt('who are you again');
  assert.equal(f.script.requests.length, 2);
  assert.equal(f.runtime.session.messages.at(-1).content[0].text, 'I am Red Maple');
  assert.deepEqual(controls.ledger.snapshot().calls[interrupted.key], interrupted);
  assert.deepEqual(controls.ledger.snapshot().runs[interrupted.runId].usage, usage);
});

test('a lost chat transport can be retried while unknown tool effects still require reconciliation', async t => {
  const f = await fixture(t, [() => { throw new Error('connection lost after send'); }, assistant('retried')]);
  await f.runtime.session.prompt('first attempt');
  await f.runtime.session.prompt('try again');
  assert.equal(f.script.requests.length, 2);
  const controls = f.runtime.redmaple.controls;
  assert.ok(Object.values(controls.ledger.snapshot().calls).some(item => item.status === 'unknown' && item.kind === 'model'));
  await assert.rejects(controls.withRun('tool:external-write', () => controls.ledger.executeTool({
    name: 'external-write', replay: 'never',
    execute: async () => { throw new Error('connection lost after external write'); },
  }, 'external-write', {})), /connection lost after external write/);
  await assert.rejects(f.runtime.session.prompt('must verify the external write'), { code: 'result_unknown' });
  assert.equal(f.script.requests.length, 2);
});

test('unknown image-generation outcomes and pending calls continue to block new turns', async t => {
  const f = await fixture(t);
  const controls = f.runtime.redmaple.controls;
  for (const call of [
    { key: 'pending-response', kind: 'model', purpose: 'response', status: 'pending' },
    { key: 'unknown-image', kind: 'model', purpose: 'generateImages', status: 'unknown' },
  ]) {
    await controls.ledger.store.update(state => { state.calls = { [call.key]: call }; });
    await assert.rejects(f.runtime.session.prompt('wait for recovery'), { code: 'result_unknown' });
  }
  assert.equal(f.script.requests.length, 0);
  await controls.ledger.store.update(state => { state.calls = {}; });
});

test('sourced memory requires approval, handles conflicts and excludes changed sources', async t => {
  const f = await fixture(t);
  const state = await PlatformState.open(join(f.agentDir, 'platform.sqlite'), f.cwd);
  f.cleanups.push(() => state.close());
  const path = join(f.cwd, 'note.txt');
  await writeFile(path, 'source');
  const sources = [await state.source(path)];
  const memory = await state.remember({ key: 'preference', text: 'one', sources });
  assert.equal((await state.searchMemory()).length, 0);
  await state.decideMemory(memory.id, true);
  const conflict = await state.remember({ key: 'preference', text: 'two', sources });
  assert.deepEqual(conflict.conflicts, [memory.id]);
  await state.decideMemory(conflict.id, true);
  assert.equal((await state.searchMemory())[0].text, 'two');
  await writeFile(path, 'changed');
  assert.equal((await state.searchMemory()).length, 0);
  assert.equal(state.snapshot().memories[conflict.id].status, 'stale');
});

test('workflow validates DAG, approval, optimistic versions and completion evidence', async t => {
  const f = await fixture(t);
  const state = await PlatformState.open(join(f.agentDir, 'platform.sqlite'), f.cwd);
  f.cleanups.push(() => state.close());
  assert.throws(() => state.createWorkflow({ title: 'cycle', steps: [{ id: 'a', title: 'a', dependsOn: ['b'] }, { id: 'b', title: 'b', dependsOn: ['a'] }] }), { code: 'plan_cycle' });
  const plan = state.createWorkflow({ title: 'research', steps: [{ id: 'a', title: 'collect' }, { id: 'b', title: 'review', dependsOn: ['a'], approvalRequired: true }] });
  assert.throws(() => state.transitionWorkflow(plan.id, 1, 'approve'), { code: 'approval_required' });
  state.transitionWorkflow(plan.id, 1, 'approve', { human: true });
  assert.throws(() => state.transitionWorkflow(plan.id, 1, 'start', { stepId: 'a' }), { code: 'version_conflict' });
  assert.throws(() => state.transitionWorkflow(plan.id, 2, 'start', { stepId: 'b', human: true }), { code: 'dependency_pending' });
  state.transitionWorkflow(plan.id, 2, 'start', { stepId: 'a' });
  assert.throws(() => state.transitionWorkflow(plan.id, 3, 'complete', { stepId: 'a' }), { code: 'evidence_required' });
  await state.verifyWorkflow({ id: plan.id, version: 3, stepId: 'a', evidence: 'source saved', human: true });
  state.transitionWorkflow(plan.id, 4, 'complete', { stepId: 'a' });
  assert.throws(() => state.transitionWorkflow(plan.id, 5, 'start', { stepId: 'b' }), { code: 'approval_required' });
  state.transitionWorkflow(plan.id, 5, 'start', { stepId: 'b', human: true });
  await state.verifyWorkflow({ id: plan.id, version: 6, stepId: 'b', evidence: 'reviewed', human: true });
  assert.equal(state.transitionWorkflow(plan.id, 7, 'complete', { stepId: 'b' }).status, 'completed');
});

test('proposal approval fingerprints, stale writes and undo preserve user changes', async t => {
  const f = await fixture(t);
  const state = await PlatformState.open(join(f.agentDir, 'platform.sqlite'), f.cwd);
  f.cleanups.push(() => state.close());
  const path = join(f.cwd, 'note.txt');
  await writeFile(path, 'before');
  const proposal = await state.propose({ path, content: 'after' });
  const preview = await state.preview(proposal.id);
  await assert.rejects(state.applyProposal(proposal.id, 'wrong'), { code: 'approval_changed' });
  await state.applyProposal(proposal.id, preview.approvalHash);
  await state.applyProposal(proposal.id, preview.approvalHash);
  assert.equal(await readFile(path, 'utf8'), 'after');
  await writeFile(path, 'user change');
  await assert.rejects(state.applyProposal(proposal.id, preview.approvalHash, true), { code: 'proposal_stale' });
  await writeFile(path, 'after');
  await state.applyProposal(proposal.id, preview.approvalHash, true);
  assert.equal(await readFile(path, 'utf8'), 'before');
});
