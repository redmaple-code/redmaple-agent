import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResourcesPlugin, createWorkspaceTools, createAgentBase, MemoryStore,
  compactContext, textResult } from '../src/index.js';
import { fingerprint } from '../src/shared.js';
import { model, scripted, assistant, call, tool, deferred } from './fixtures.js';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-base-tools-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('two domain-independent skills and ancestor instructions load on demand', async t => {
  const root = await workspace(t);
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), 'Root instructions');
  await writeFile(join(root, 'sub', 'AGENTS.md'), 'Subdirectory instructions');
  for (const name of ['format-text', 'inspect-code']) {
    const path = join(root, '.agents', 'skills', name);
    await mkdir(join(path, 'references'), { recursive: true });
    await writeFile(join(path, 'SKILL.md'), `\uFEFF---\nname: ${name}\ndescription: >\n  ${name} instructions\n---\nSECRET_BODY_${name}`);
    await writeFile(join(path, 'references', 'details.md'), 'Supporting reference');
  }
  const resources = await createResourcesPlugin({ workspace: root, cwd: join(root, 'sub') });
  assert.equal(resources.resources.skills.length, 2);
  assert.equal(resources.resources.instructions.length, 2);
  assert.ok(!resources.systemPrompt.includes('SECRET_BODY'));
  const script = scripted([
    assistant([call('skill', 'load_skill', { name: 'format-text' })], 'toolUse'),
    assistant([call('reference', 'load_skill', { name: 'inspect-code', file: 'references/details.md' })], 'toolUse'),
    assistant('skills applied'),
  ]);
  const base = await createAgentBase({ model, ...script, plugins: [resources] });
  t.after(() => base.close());
  assert.equal((await base.prompt('use skills')).status, 'succeeded');
  assert.ok(script.requests[1].messages.at(-1).content[0].text.includes('SECRET_BODY_format-text'));
  assert.equal(script.requests[2].messages.at(-1).content[0].text, 'Supporting reference');
  await assert.rejects(resources.tools[0].execute('escape', { name: 'format-text', file: '../../../AGENTS.md' }),
    { code: 'outside_skill' });
});

test('workspace tools create, read and conditionally edit real files', async t => {
  const root = await workspace(t);
  const tools = await createWorkspaceTools({ workspace: root });
  const byName = Object.fromEntries(tools.map(item => [item.name, item]));
  await byName.write.execute('write', { path: 'notes/file.txt', content: 'hello world', expected_hash: '' });
  const read = await byName.read.execute('read', { path: 'notes/file.txt' });
  await byName.edit.execute('edit', { path: 'notes/file.txt', old_text: 'world', new_text: 'agent', expected_hash: read.details.sha256 });
  assert.equal(await readFile(join(root, 'notes/file.txt'), 'utf8'), 'hello agent');
  await assert.rejects(byName.write.execute('stale', { path: 'notes/file.txt', content: 'overwrite', expected_hash: read.details.sha256 }),
    { code: 'file_conflict' });
  await assert.rejects(byName.read.execute('outside', { path: '../outside.txt' }), { code: 'outside_workspace' });
  await writeFile(join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(byName.read.execute('invalid', { path: 'invalid.txt' }), { code: 'invalid_encoding' });
});

test('exec streams real child output, reports nonzero status and terminates on cancellation', async t => {
  const root = await workspace(t);
  const tools = await createWorkspaceTools({ workspace: root, outputCap: 100 });
  const exec = tools.find(item => item.name === 'exec');
  const updates = [];
  const result = await exec.execute('real', { program: process.execPath, args: ['-e', 'console.log("child output");process.exitCode=2'] },
    undefined, update => updates.push(update));
  assert.ok(result.content[0].text.includes('child output'));
  assert.equal(result.details.exitCode, 2);
  assert.equal(result.isError, true);
  assert.ok(updates.length);
  const controller = new AbortController();
  const started = deferred();
  const running = exec.execute('cancel', { program: process.execPath,
    args: ['-e', 'console.log("ready");setInterval(()=>{},1000)'] }, controller.signal, () => started.resolve());
  await started.promise;
  controller.abort();
  await assert.rejects(running, { code: 'cancelled' });
});

test('context projection keeps archived history, task and whole tool exchanges', async () => {
  const earlier = { role: 'user', content: [{ type: 'text', text: 'old '.repeat(500) }], timestamp: 1 };
  const task = { role: 'user', content: [{ type: 'text', text: 'current task' }], timestamp: 2 };
  const messages = [{ role: 'system', content: 'Keep facts', timestamp: 0 }, earlier, assistant('earlier result'), task,
    assistant([call('r', 'read')], 'toolUse'),
    { role: 'toolResult', toolCallId: 'r', toolName: 'read', content: [{ type: 'text', text: 'fresh evidence' }], timestamp: 3 }];
  const store = new MemoryStore();
  let summaries = 0;
  const options = { store, maxInputTokens: 2200, keepRecentExchanges: 1, pinned: [task],
    summarize: async () => { summaries += 1; return 'Earlier result with constraints'; } };
  const original = fingerprint(messages);
  const projected = await compactContext(messages, options);
  await compactContext(messages, options);
  assert.equal(summaries, 1);
  assert.equal(fingerprint(messages), original);
  assert.ok(projected.some(message => Array.isArray(message.content) && message.content.some(item => item.text === 'current task')));
  assert.equal(projected.at(-1).toolCallId, 'r');
  assert.equal(projected.at(-2).content[0].id, 'r');
});

test('automatic compaction uses the same model call budget as the response', async t => {
  const store = new MemoryStore();
  await store.update(state => { state.messages = [
    { role: 'user', content: [{ type: 'text', text: 'old '.repeat(1000) }], timestamp: 1 }, assistant('old answer'),
  ]; });
  const script = scripted([assistant('Retained goals and decisions')]);
  const base = await createAgentBase({ model, ...script, store, limits: { modelCalls: 1 },
    context: { maxInputTokens: 2000, keepRecentExchanges: 1 } });
  t.after(() => base.close());
  const result = await base.prompt('current task');
  assert.equal(result.status, 'blocked');
  assert.equal(result.errorCode, 'budget_exhausted');
  assert.equal(script.requests.length, 1);
  assert.equal(Object.values(base.snapshot().calls)[0].purpose, 'compaction');
  assert.ok(base.snapshot().messages.some(message => Array.isArray(message.content) && message.content[0]?.text?.length > 3000));
});

test('Pi executes parallel reads together and serializes a batch containing a sequential tool', async t => {
  let active = 0;
  let peak = 0;
  const execute = async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise(done => setTimeout(done, 15));
    active -= 1; return textResult('done');
  };
  const script = scripted([assistant([call('a', 'one'), call('b', 'two')], 'toolUse'), assistant('done')]);
  const base = await createAgentBase({ model, ...script, tools: [tool('one', execute), tool('two', execute)] });
  t.after(() => base.close());
  assert.equal((await base.prompt('parallel')).status, 'succeeded');
  assert.equal(peak, 2);
  peak = 0;
  const serial = await createAgentBase({ model, ...scripted([assistant([call('a', 'one'), call('b', 'two')], 'toolUse'), assistant('done')]),
    tools: [tool('one', execute), tool('two', execute, { executionMode: 'sequential' })] });
  t.after(() => serial.close());
  assert.equal((await serial.prompt('serial')).status, 'succeeded');
  assert.equal(peak, 1);
});
