import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PlatformState } from '../src/platform.js';
import { sandboxTimeout } from '../src/permissions.js';
import { fingerprint } from '../src/shared.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SessionControls, executionScope } from '../src/session-controls.js';
import { AgentBase } from '../src/agent.js';
import { MemoryStore } from '../src/store.js';

async function fixture(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'redmaple-remediation-')));
  const file = join(cwd, 'platform.sqlite');
  const state = await PlatformState.open(file, cwd);
  t.after(async () => { state.close(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, file, state };
}

test('sandbox seconds preserve explicit long timeouts and obey the remaining run deadline', () => {
  assert.equal(sandboxTimeout(), 60000);
  assert.equal(sandboxTimeout(180), 180000);
  assert.equal(sandboxTimeout(0.25), 250);
  assert.equal(sandboxTimeout(180, 500), 500);
  for (const input of [0, -1, Infinity, NaN, '5', 2147484]) assert.throws(() => sandboxTimeout(input), { code: 'invalid_timeout' });
  assert.throws(() => sandboxTimeout(1, 0), { code: 'time_exhausted' });
});

test('resumed budgets count previously elapsed time exactly once', async () => {
  const store = new MemoryStore();
  const limits = { seconds: 10, modelCalls: 10, toolCalls: 10, tokens: 10000 };
  await store.update(data => { data.runs.budget = { requestId: 'budget', purpose: 'resume', status: 'succeeded',
    limits, usage: { modelCalls: 0, toolCalls: 0, tokens: 0, cost: 0 }, nextModel: 0, elapsedMs: 5000 }; });
  const controls = new SessionControls({ abort: async () => {}, agent: { abort() {} } }, {});
  controls.ledger = Object.assign(Object.create(AgentBase.prototype), { store, active: null, limits });
  await controls.runInBudget('budget', async () => { executionScope.getStore().controls.ledger.checkRun(); });
  const elapsed = store.snapshot().runs.budget.elapsedMs;
  assert.ok(elapsed >= 5000 && elapsed < 10000, String(elapsed));
  await store.close();
});

test('legacy JSON migrates with stable records, normalized workflow steps and a consistent backup', async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'redmaple-migration-')));
  let state;
  t.after(async () => { state?.close(); await rm(cwd, { recursive: true, force: true }); });
  const file = join(cwd, 'platform.sqlite');
  const db = new DatabaseSync(file);
  const key = fingerprint(process.platform === 'win32' ? cwd.toLowerCase() : cwd);
  const data = { memories: { m: { id: 'm', key: 'constraint', text: 'keep evidence', status: 'approved', sources: [] } },
    workflows: { w: { id: 'w', title: 'old', version: 3, status: 'completed', steps: [{ id: 's', title: 'old step', status: 'done' }] } },
    proposals: { p: { id: 'p', status: 'conflict' } }, children: { c: { id: 'c', status: 'succeeded' } } };
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE redmaple_platform(workspace TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL)');
  db.prepare('INSERT INTO redmaple_platform VALUES(?,?,?)').run(key, 9, JSON.stringify(data));
  db.close();
  state = await PlatformState.open(file, cwd);
  assert.equal(state.snapshot().revision, 9);
  assert.equal(state.get('memories', 'm').status, 'approved');
  assert.equal(state.get('workflows', 'w').steps[0].status, 'done');
  assert.equal(state.get('workflows', 'w').steps[0].verificationStatus, 'legacy_unverified');
  assert.equal(state.get('proposals', 'p').status, 'conflict');
  const backup = new DatabaseSync(state.backup, { readOnly: true });
  assert.deepEqual(JSON.parse(backup.prepare('SELECT data FROM redmaple_platform').get().data), data);
  backup.close();
  const scopeId = state.key;
  state.close(); state = await PlatformState.open(file, cwd);
  assert.equal(state.key, scopeId);
  assert.equal(state.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.throws(() => state.db.prepare('UPDATE redmaple_platform SET revision=10').run(), /view/);
});

test('explicit workspace identity restores backed-up knowledge, memory and receipts after relocation', async t => {
  const { state, cwd } = await fixture(t);
  await writeFile(join(cwd, 'source.txt'), 'portable knowledge');
  const source = await state.knowledge.importFile('source.txt');
  const memory = await state.remember({ key: 'portable', text: 'retain source', sources: [source.reference] });
  await state.decideMemory(memory.id, true);
  const { receipt } = await verifiedWork(state, cwd);
  const candidate = await state.evolution.propose({ assetKey: 'portable-policy', content: 'Verify evidence', verificationId: receipt.id });
  await state.evolution.evaluate(candidate.id, improved, evaluationConfig);
  state.evolution.activate(candidate.id, { human: true });
  const moved = await realpath(await mkdtemp(join(tmpdir(), 'redmaple-moved-')));
  t.after(() => rm(moved, { recursive: true, force: true }));
  await writeFile(join(moved, 'source.txt'), 'portable knowledge');
  await writeFile(join(moved, 'evidence.txt'), 'checked');
  const file = join(moved, 'platform.sqlite');
  state.backupTo(file);
  const restored = await PlatformState.open(file, moved, { workspaceId: state.key });
  try {
    assert.equal(restored.key, state.key);
    assert.equal((await restored.searchMemory())[0].id, memory.id);
    assert.equal((await restored.knowledge.search('portable')).items[0].citation.path, join(moved, 'source.txt'));
    assert.equal((await restored.knowledge.importFile('source.txt')).id, source.id);
    assert.equal(restored.evolution.active()[0].content, 'Verify evidence');
    assert.equal(restored.health().synchronous, 2);
    assert.deepEqual(restored.health().foreignKeyErrors, []);
  } finally { restored.close(); }
});

test('source validation cannot override a newer user decision', async t => {
  const { state, cwd } = await fixture(t);
  await writeFile(join(cwd, 'source.txt'), 'evidence');
  const memory = await state.remember({ key: 'rule', text: 'source', sources: [await state.source('source.txt')] });
  await state.decideMemory(memory.id, true);
  state.validateSources = async () => {
    state.update(data => { data.memories[memory.id].status = 'rejected'; });
    throw Object.assign(new Error('source changed'), { code: 'source_changed' });
  };
  assert.deepEqual(await state.searchMemory(), []);
  assert.equal(state.get('memories', memory.id).status, 'rejected');
  state.validateSources = async () => state.update(data => { data.memories[memory.id].text = 'newer'; });
  await assert.rejects(state.decideMemory(memory.id, true), { code: 'version_conflict' });
});

test('new workflows require verifications and reject artifacts changed after validation', async t => {
  const { state, cwd } = await fixture(t);
  await writeFile(join(cwd, 'result.txt'), 'verified output');
  let plan = state.createWorkflow({ title: 'work', steps: [{ id: 'a', title: 'produce',
    acceptanceSpec: [{ kind: 'file', path: 'result.txt', contains: 'verified' }] }] });
  plan = state.transitionWorkflow(plan.id, plan.version, 'approve', { human: true });
  plan = state.transitionWorkflow(plan.id, plan.version, 'start', { stepId: 'a' });
  assert.throws(() => state.transitionWorkflow(plan.id, plan.version, 'complete', { stepId: 'a', evidence: 'done' }), { code: 'evidence_required' });
  const receipt = await state.verifyWorkflow({ id: plan.id, version: plan.version, stepId: 'a' });
  assert.equal(receipt.verdict, 'pass');
  plan = state.get('workflows', plan.id);
  await writeFile(join(cwd, 'result.txt'), 'changed');
  assert.throws(() => state.transitionWorkflow(plan.id, plan.version, 'complete', { stepId: 'a', verificationId: receipt.id }), { code: 'artifact_changed' });
  const failure = await state.verifyWorkflow({ id: plan.id, version: plan.version, stepId: 'a' });
  assert.equal(failure.verdict, 'fail');
  plan = state.get('workflows', plan.id);
  assert.equal(plan.steps[0].status, 'failed');
  plan = state.transitionWorkflow(plan.id, plan.version, 'retry', { stepId: 'a' });
  plan = state.transitionWorkflow(plan.id, plan.version, 'start', { stepId: 'a' });
  await writeFile(join(cwd, 'result.txt'), 'verified output');
  const retry = await state.verifyWorkflow({ id: plan.id, version: plan.version, stepId: 'a' });
  plan = state.get('workflows', plan.id);
  assert.equal(state.transitionWorkflow(plan.id, plan.version, 'complete', { stepId: 'a', verificationId: retry.id }).status, 'completed');
});

test('custom verifier inputs and implementation versions are bound to the receipt', async t => {
  const { state, cwd } = await fixture(t);
  await writeFile(join(cwd, 'input.txt'), 'checked');
  state.verifiers = { tests: { version: '1', verify: async ({ artifacts }) => {
    assert.equal(artifacts[0].hash, fingerprint('checked'));
    return { verdict: 'pass', proof: { tests: 1 } };
  } } };
  let plan = state.createWorkflow({ title: 'custom verification', steps: [{ id: 's', title: 'run tests',
    acceptanceSpec: [{ kind: 'custom', verifier: 'tests', artifactPaths: ['input.txt'] }] }] });
  plan = state.transitionWorkflow(plan.id, plan.version, 'approve', { human: true });
  plan = state.transitionWorkflow(plan.id, plan.version, 'start', { stepId: 's' });
  assert.equal((await state.verifyWorkflow({ id: plan.id, version: plan.version, stepId: 's' })).verdict, 'pass');
  plan = state.get('workflows', plan.id);
  state.verifiers.tests.version = '2';
  assert.throws(() => state.transitionWorkflow(plan.id, plan.version, 'complete', { stepId: 's' }), { code: 'verifier_changed' });
  state.verifiers.tests.verify = async () => {
    await writeFile(join(cwd, 'input.txt'), 'changed during verification');
    return { verdict: 'pass' };
  };
  const failed = await state.verifyWorkflow({ id: plan.id, version: plan.version, stepId: 's' });
  assert.equal(failed.verdict, 'fail');
  assert.equal(failed.diagnostics[0].code, 'artifact_changed');
});

test('knowledge indexes Chinese short queries, revisions, citations, invalidation and rebuilding', async t => {
  const { state, cwd, file } = await fixture(t);
  state.knowledgeOptions = { aliases: { '记忆': ['memory'] } };
  await writeFile(join(cwd, 'note.txt'), '红枫知识库支持经验检索。\nPersistent agent memory.');
  const source = await state.knowledge.importFile('note.txt');
  for (const query of ['知识', '知识库', '红', 'memory', '经验检索', '记忆']) {
    const result = await state.knowledge.search(query);
    assert.equal(result.items[0].sourceId, source.id);
    assert.equal(result.items[0].citation.hash, source.hash);
  }
  assert.equal((await state.knowledge.search('unrelated')).items.length, 0);
  const measured = await state.knowledge.evaluate([{ query: '知识', expectedSourceIds: [source.id] },
    { query: 'unrelated', expectedSourceIds: [] }]);
  assert.equal(measured.recallAtK, 1);
  assert.equal(measured.mrr, 1);
  assert.equal(measured.noAnswerFalsePositiveRate, 0);
  const memory = await state.remember({ key: 'knowledge', text: 'keep source', sources: [source.reference] });
  await state.decideMemory(memory.id, true);
  assert.equal((await state.searchMemory()).length, 1);
  await writeFile(join(cwd, 'note.txt'), '替换资料，新的中文知识。');
  assert.equal((await state.knowledge.search('memory')).items.length, 0);
  assert.equal((await state.searchMemory()).length, 0);
  const next = await state.knowledge.importFile('note.txt');
  assert.notEqual(next.revisionId, source.revisionId);
  assert.equal((await state.knowledge.search('memory')).items.length, 0);
  state.db.exec('DELETE FROM chunks_fts; DELETE FROM chunk_terms');
  assert.equal(state.knowledge.rebuild().chunks, 1);
  assert.equal((await state.knowledge.search('知识')).items.length, 1);
  const other = await mkdtemp(join(tmpdir(), 'redmaple-scope-'));
  const scoped = await PlatformState.open(file, other);
  try { assert.equal((await scoped.knowledge.search('知识')).items.length, 0); }
  finally { scoped.close(); await rm(other, { recursive: true, force: true }); }
  assert.equal(state.knowledge.remove(next.id).removed, true);
  assert.equal((await state.knowledge.search('知识')).items.length, 0);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM chunk_terms').get().n, 0);
  assert.equal(await readFile(join(cwd, 'note.txt'), 'utf8'), '替换资料，新的中文知识。');
});

test('durable harness rejects competing owners and closes the FULL SQLite connection', async t => {
  const { cwd } = await fixture(t);
  const { openRedMapleHarness, BACKGROUND_CONTEXT } = await import('../src/durable.js');
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const models = await ModelRuntime.create({ authPath: join(cwd, 'auth.json'), modelsPath: join(cwd, 'models.json'), allowModelNetwork: false });
  const { NodeSqliteDatabase } = await import('@earendil-works/pi-durable/storage/sqlite/node');
  const exec = NodeSqliteDatabase.prototype.exec;
  let synchronous;
  t.mock.method(NodeSqliteDatabase.prototype, 'exec', async function (sql) {
    const result = await exec.call(this, sql);
    if (sql === 'PRAGMA synchronous=FULL') synchronous = (await this.get('PRAGMA synchronous')).synchronous;
    return result;
  });
  const file = join(cwd, 'durable.sqlite');
  const harness = await openRedMapleHarness({ file, models });
  assert.equal(synchronous, 2);
  try { await assert.rejects(openRedMapleHarness({ file, models, recoverLock: true }), { code: 'session_locked' }); }
  finally { await harness.close(BACKGROUND_CONTEXT); }
  const reopened = await openRedMapleHarness({ file, models });
  await reopened.close(BACKGROUND_CONTEXT);
});

async function verifiedWork(state, cwd) {
  await writeFile(join(cwd, 'evidence.txt'), 'checked');
  let plan = state.createWorkflow({ title: 'evidence', steps: [{ id: 's', title: 'check',
    acceptanceSpec: [{ kind: 'file', path: 'evidence.txt', contains: 'checked' }] }] });
  plan = state.transitionWorkflow(plan.id, plan.version, 'approve', { human: true });
  plan = state.transitionWorkflow(plan.id, plan.version, 'start', { stepId: 's' });
  const receipt = await state.verifyWorkflow({ id: plan.id, version: plan.version, stepId: 's' });
  plan = state.get('workflows', plan.id);
  state.transitionWorkflow(plan.id, plan.version, 'complete', { stepId: 's' });
  return { plan, receipt };
}

const evaluationConfig = { evaluatorId: 'fixture/1', datasetVersion: 'paired/1', minCases: 1, maxCost: 2 };
const improved = async () => ({ cases: [{ id: 'task', candidate: { pass: true, cost: 0.1 }, baseline: { pass: false, cost: 0.1 } }] });

test('experience candidates deduplicate, reject regressions, activate with CAS and roll back', async t => {
  const { state, cwd } = await fixture(t);
  const { plan, receipt } = await verifiedWork(state, cwd);
  const request = { assetKey: 'research', content: 'Verify sources before answering', verificationId: receipt.id };
  const candidate = await state.evolution.propose(request);
  assert.equal((await state.evolution.propose(request)).id, candidate.id);
  assert.throws(() => state.evolution.activate(candidate.id, { human: true }), { code: 'evaluation_required' });
  const other = await state.evolution.propose({ ...request, content: 'Cite and verify sources' });
  await state.evolution.evaluate(candidate.id, improved, evaluationConfig);
  await state.evolution.evaluate(other.id, improved, evaluationConfig);
  assert.throws(() => state.evolution.activate(candidate.id), { code: 'approval_required' });
  const pointer = state.evolution.activate(candidate.id, { human: true });
  assert.equal(state.evolution.active()[0].content, request.content);
  assert.throws(() => state.evolution.activate(other.id, { human: true }), { code: 'version_conflict' });
  const rollback = state.evolution.rollback(pointer.id, { human: true, expectedVersion: pointer.version, reason: 'compare previous' });
  assert.equal(rollback.assetId, null);
  assert.equal(state.evolution.active().length, 0);
  const regressed = async () => ({ cases: [{ id: 'task', candidate: { pass: false, cost: 0.1 }, baseline: { pass: true, cost: 0.1 } }] });
  assert.equal((await state.evolution.evaluate(other.id, regressed, evaluationConfig)).eligible, false);
  assert.throws(() => state.evolution.activate(other.id, { human: true }), { code: 'evaluation_required' });
  state.recordDecision({ workflowId: plan.id, stepId: 's', goal: 'check evidence', assessment: 'sources verified',
    nextAction: 'reuse the source verification', evidenceRefs: [receipt.id] });
  assert.equal((await state.evolution.extract()).length, 1);
  const count = Object.keys(state.snapshot().candidates).length;
  await state.evolution.extract();
  assert.equal(Object.keys(state.snapshot().candidates).length, count);
});

test('failed evaluations resume their checkpoints and stale evidence cannot be promoted', async t => {
  const { state, cwd } = await fixture(t);
  const { receipt } = await verifiedWork(state, cwd);
  const candidate = await state.evolution.propose({ assetKey: 'recovery', content: 'Preserve results', verificationId: receipt.id });
  await assert.rejects(state.evolution.evaluate(candidate.id, async ({ checkpoint }) => {
    checkpoint({ completed: ['first'] }); throw new Error('interrupted evaluator');
  }, evaluationConfig), /interrupted evaluator/);
  let resumed;
  const evaluated = await state.evolution.evaluate(candidate.id, async ({ previous }) => {
    resumed = previous; return improved();
  }, { ...evaluationConfig, resume: true });
  assert.deepEqual(resumed, { completed: ['first'] });
  assert.equal(evaluated.eligible, true);
  await writeFile(join(cwd, 'evidence.txt'), 'modified');
  assert.throws(() => state.evolution.activate(candidate.id, { human: true }), { code: 'artifact_changed' });
});

test('durable workflow execution verifies steps, persists the task identity and reopens without duplicate effects', async t => {
  const { state, cwd } = await fixture(t);
  const { openWorkflowRunner } = await import('../src/workflow-runner.js');
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const models = await ModelRuntime.create({ authPath: join(cwd, 'auth.json'), modelsPath: join(cwd, 'models.json'), allowModelNetwork: false });
  let plan = state.createWorkflow({ title: 'execute', steps: [{ id: 's', title: 'write file',
    acceptanceSpec: [{ kind: 'file', path: 'output.txt', contains: 'done' }] }] });
  plan = state.transitionWorkflow(plan.id, plan.version, 'approve', { human: true });
  let executions = 0;
  const options = { state, models, file: join(cwd, 'workflow.sqlite'), executeStep: async () => {
    executions += 1; await writeFile(join(cwd, 'output.txt'), 'done'); return { status: 'succeeded' };
  } };
  let runner = await openWorkflowRunner(options);
  let taskId;
  try {
    taskId = await runner.start(plan.id);
    const result = await runner.wait(taskId);
    assert.equal(result.state.outcome.status, 'completed', JSON.stringify(result));
    assert.equal(state.get('workflows', plan.id).status, 'completed');
    assert.equal(executions, 1);
  } finally { await runner.close(); }
  runner = await openWorkflowRunner(options);
  try {
    assert.equal(await runner.start(plan.id), taskId);
    assert.equal((await runner.wait(taskId)).state.outcome.status, 'completed');
    assert.equal(executions, 1);
  } finally { await runner.close(); }
});

test('copy-mode proposals preserve originals and remain idempotent', async t => {
  const { state, cwd } = await fixture(t);
  const path = join(cwd, 'draft.txt');
  await writeFile(path, 'original');
  const proposal = await state.propose({ path, content: 'candidate' });
  const preview = await state.preview(proposal.id);
  await writeFile(path, 'external edit');
  const exported = await state.exportProposal(proposal.id, preview.approvalHash);
  assert.equal(await readFile(path, 'utf8'), 'external edit');
  assert.equal(await readFile(exported.exportedPath, 'utf8'), 'candidate');
  assert.equal((await state.exportProposal(proposal.id, preview.approvalHash)).exportedPath, exported.exportedPath);
});

test('strong-kill recovery reconciles a sent effect and never blindly replays it', { timeout: 90000 }, async t => {
  const { state, cwd } = await fixture(t);
  let plan = state.createWorkflow({ title: 'crash recovery', steps: [{ id: 's', title: 'effect',
    acceptanceSpec: [{ kind: 'file', path: 'result.txt', contains: 'effect completed' }] }] });
  plan = state.transitionWorkflow(plan.id, plan.version, 'approve', { human: true });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./workflow-crash-fixture.js', import.meta.url)), cwd, plan.id],
    { windowsHide: true, env: { ...process.env, PI_OFFLINE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', part => { stderr += part; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((done, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Child startup timed out: ${stderr}`)); }, 60000);
    child.stdout.on('data', part => { if (part.toString().includes('effect_completed')) { clearTimeout(timer); done(); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { if (code) { clearTimeout(timer); reject(new Error(stderr)); } });
  });
  const stopped = new Promise(done => child.once('exit', done));
  child.kill(); await stopped;
  const { openWorkflowRunner } = await import('../src/workflow-runner.js');
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const models = await ModelRuntime.create({ authPath: join(cwd, 'auth.json'), modelsPath: join(cwd, 'models.json'), allowModelNetwork: false });
  let executions = 0;
  const options = { file: join(cwd, 'workflow.sqlite'), state, models, recoverLock: true,
    executeStep: async () => { executions += 1; return { status: 'succeeded' }; } };
  let runner = await openWorkflowRunner(options);
  try {
    const blocked = await runner.wait(await runner.start(plan.id));
    assert.equal(blocked.state.outcome.status, 'failed');
    assert.equal(state.get('workflows', plan.id).steps[0].status, 'blocked');
    assert.equal(executions, 0);
  } finally { await runner.close(); }
  runner = await openWorkflowRunner({ ...options, reconcileStep: async () => {
    assert.equal(await readFile(join(cwd, 'result.txt'), 'utf8'), 'effect completed');
    return { status: 'succeeded', reconciled: true };
  } });
  try {
    const settled = await runner.wait(await runner.start(plan.id));
    assert.equal(settled.state.outcome.status, 'completed', JSON.stringify(settled));
    assert.equal(await readFile(join(cwd, 'effects.txt'), 'utf8'), 'x');
    assert.equal(executions, 0);
  } finally { await runner.close(); }
});
