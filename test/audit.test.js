import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionControls } from '../src/session-controls.js';
import { MemoryStore } from '../src/store.js';
import { PlatformState } from '../src/platform.js';

function controlsWithFailingWrite(failAt) {
  const store = new MemoryStore();
  let writes = 0;
  store.persist = async () => {
    writes += 1;
    if (writes === failAt) throw new Error('simulated storage failure');
  };
  const controls = new SessionControls({ abort: async () => {} }, {});
  controls.ledger = { store, active: null, limits: { seconds: 10, modelCalls: 10, toolCalls: 10, tokens: 10000 },
    snapshot: () => store.snapshot() };
  return controls;
}

for (const failAt of [1, 2]) {
  test(`failed run persistence at write ${failAt} releases active state and fences subsequent execution`, async () => {
    const controls = controlsWithFailingWrite(failAt);
    let executions = 0;
    const action = async () => { executions += 1; };
    await assert.rejects(controls.withRun('probe', action), /simulated storage failure/);
    assert.equal(executions, failAt === 1 ? 0 : 1);
    assert.equal(controls.ledger.active, null);
    await assert.rejects(controls.withRun('retry', action), { code: 'persistence_failed' });
    assert.equal(executions, failAt === 1 ? 0 : 1);
    await controls.ledger.store.close();
  });
}

test('opening an invalid workspace leaves no newly created platform database', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'redmaple-audit-open-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const file = join(cwd, 'platform.sqlite');
  await assert.rejects(PlatformState.open(file, join(cwd, 'missing')), { code: 'ENOENT' });
  await assert.rejects(access(file), { code: 'ENOENT' });
});

test('temporary source IO errors preserve approval and remain visible to the caller', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'redmaple-audit-memory-'));
  let state;
  t.after(async () => { state?.close(); await rm(cwd, { recursive: true, force: true }); });
  await writeFile(join(cwd, 'source.txt'), 'source');
  state = await PlatformState.open(join(cwd, 'platform.sqlite'), cwd);
  const item = await state.remember({ key: 'constraint', text: 'retain evidence', sources: [await state.source('source.txt')] });
  await state.decideMemory(item.id, true);
  const validate = state.validateSources.bind(state);
  state.validateSources = async () => { throw Object.assign(new Error('temporary IO failure'), { code: 'EMFILE' }); };
  await assert.rejects(state.searchMemory(), { code: 'EMFILE' });
  assert.equal(state.snapshot().memories[item.id].status, 'approved');
  state.validateSources = validate;
  assert.equal((await state.searchMemory()).length, 1);
});
