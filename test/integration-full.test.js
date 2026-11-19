import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';
import { InteractiveMode } from '@earendil-works/pi-coding-agent';
import { createRedMapleRuntime } from '../src/full-runtime.js';
import { openRedMapleHarness, BACKGROUND_CONTEXT, AssistantEntry } from '../src/durable.js';
import { executeSandbox } from '../src/permissions.js';
import { upstreamModule } from '../src/upstream.js';
import { model, assistant, call, scripted } from './fixtures.js';
const { Terminal: VirtualTerminal } = xterm;

async function fixture(t, replies, extra = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'redmaple-integration-'));
  const script = scripted(replies);
  const runtime = await createRedMapleRuntime({ cwd, agentDir: join(cwd, 'agent'), model,
    streamFn: script.streamFn, inMemory: true, policy: { profile: 'trusted' },
    settings: { retry: { enabled: false } }, ...extra });
  t.after(async () => { await runtime.dispose(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, script, runtime };
}

test('native Code Mode nested tools share permissions and durable ledger', async t => {
  const f = await fixture(t, [assistant([call('code', 'codemode', { code: "text(await tools.read({path:'note.txt'})); store('checked', true);" })], 'toolUse'), assistant('checked')], { tools: ['read', 'codemode'] });
  await writeFile(join(f.cwd, 'note.txt'), 'nested source');
  await f.runtime.session.prompt('inspect through code');
  const calls = Object.values(f.runtime.redmaple.controls.ledger.snapshot().calls);
  assert.ok(calls.some(call => call.name === 'read' && call.status === 'succeeded'));
  assert.ok(calls.some(call => call.name === 'codemode' && call.status === 'succeeded'));
  assert.ok(f.script.requests[1].messages.some(message => message.role === 'toolResult' && JSON.stringify(message).includes('nested source')));
  assert.ok(f.runtime.session.sessionManager.getEntries().some(entry => entry.customType === 'codemode-store'));
});

test('MCP stdio discovery and direct execution use the native tool pipeline', async t => {
  const path = fileURLToPath(new URL('./mcp-fixture.js', import.meta.url));
  const f = await fixture(t, [assistant([call('mcp', 'mcp__fixture__echo', { text: 'native MCP complete' })], 'toolUse'), assistant('done')],
    { mcp: { loadConfig: () => ({ servers: [{ name: 'fixture', source: path, scope: 'global',
      config: { command: process.execPath, args: [path], exposure: 'direct' } }], errors: [] }) } });
  await f.runtime.session.prompt('use MCP');
  assert.ok(f.runtime.session.getAllTools().some(tool => tool.name === 'mcp__fixture__echo'));
  assert.ok(Object.values(f.runtime.redmaple.controls.ledger.snapshot().calls).some(call => call.name === 'mcp__fixture__echo' && call.status === 'succeeded'));
});

test('parallel child agents use independent native sessions and a shared parent budget', async t => {
  const replies = [assistant([call('search', 'tool_search', { query: 'redmaple_delegate' })], 'toolUse'),
    assistant([call('delegate', 'redmaple_delegate', { tasks: [{ role: 'researcher', prompt: 'first' }, { role: 'reviewer', prompt: 'second' }] })], 'toolUse'),
    assistant('child one'), assistant('child two'), assistant('parent complete')];
  const f = await fixture(t, replies, { apiKey: 'fixture-root-key' });
  await f.runtime.session.prompt('delegate research');
  assert.equal(f.script.requests.length, 5, JSON.stringify(f.runtime.session.messages));
  const calls = Object.values(f.runtime.redmaple.controls.ledger.snapshot().calls);
  assert.equal(calls.filter(call => call.kind === 'model').length, 5);
  assert.equal(calls.filter(call => call.name === 'redmaple_delegate').length, 1);
  const parent = f.runtime.session.messages;
  const output = parent.find(message => message.role === 'toolResult' && message.toolName === 'redmaple_delegate');
  const children = JSON.parse(output.content[0].text).outputs;
  assert.deepEqual(children.map(child => child.status), ['succeeded', 'succeeded']);
  assert.notEqual(children[0].sessionId, children[1].sessionId);
  assert.equal((await f.runtime.services.modelRuntime.getAuth(model.provider)).auth.apiKey, 'fixture-root-key');
  for (const child of children) assert.ok((await readFile(child.sessionFile, 'utf8')).includes('child'));
});

test('actual durable harness persists submissions, extensions and restart idempotency', async t => {
  const f = await fixture(t, [assistant('durable answer')]);
  const file = join(f.cwd, 'durable.sqlite');
  const extension = { name: 'identity', sections: [{ key: 'purpose', render: () => 'Answer precisely' }] };
  let submissionId;
  await f.runtime.redmaple.controls.withRun('durable', async () => {
    const harness = await openRedMapleHarness({ file, models: f.runtime.services.modelRuntime, extensions: [extension] });
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id } } });
      const submission = await root.submit({ type: 'input', content: 'persist this', requestId: 'durable-request' }, BACKGROUND_CONTEXT);
      submissionId = submission.id;
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      assert.equal(settled.status, 'done', JSON.stringify(settled));
      const answer = await root.commit(tx => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
      assert.ok(JSON.stringify(answer).includes('durable answer'));
    } finally { await harness.close(BACKGROUND_CONTEXT); }
  });
  const reopened = await openRedMapleHarness({ file, models: f.runtime.services.modelRuntime, extensions: [extension] });
  try {
    const submission = await reopened.submission(submissionId, BACKGROUND_CONTEXT);
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done');
    assert.equal(f.script.requests.length, 1);
  } finally { await reopened.close(BACKGROUND_CONTEXT); }
});

test('truncated delegated output is recorded as failure and exposed as a tool error', async t => {
  const f = await fixture(t, [
    assistant([call('delegate', 'redmaple_delegate', { tasks: [{ role: 'researcher', prompt: 'inspect' }] })], 'toolUse'),
    assistant('partial child output', 'length'),
    assistant('The child output was incomplete'),
  ], { tools: ['redmaple_delegate'] });
  await f.runtime.session.prompt('delegate inspection');
  const toolResult = f.runtime.session.messages.find(message => message.role === 'toolResult' && message.toolName === 'redmaple_delegate');
  const outputs = JSON.parse(toolResult.content[0].text).outputs;
  assert.equal(outputs[0].status, 'failed');
  assert.equal(toolResult.isError, true);
});

test('knowledge import and Chinese retrieval work through native model tool calls', async t => {
  const f = await fixture(t, [
    assistant([call('import', 'redmaple_knowledge', { action: 'import', path: 'knowledge.txt' })], 'toolUse'),
    assistant([call('search', 'redmaple_knowledge', { action: 'search', query: '知识' })], 'toolUse'),
    assistant('Evidence retrieved'),
  ], { tools: ['redmaple_knowledge'] });
  await writeFile(join(f.cwd, 'knowledge.txt'), '红枫知识库提供来源引用');
  await f.runtime.session.prompt('Import and retrieve evidence');
  const results = f.runtime.session.messages.filter(item => item.role === 'toolResult' && item.toolName === 'redmaple_knowledge');
  assert.equal(results.length, 2);
  const search = JSON.parse(results[1].content[0].text);
  assert.equal(search.items[0].content, '红枫知识库提供来源引用');
  assert.ok(search.items[0].citation.hash);
});

test('native workflow tool executes a child, verifies the artifact and shares the parent budget', async t => {
  let workflowId;
  const f = await fixture(t, [
    () => assistant([call('run', 'redmaple_plan', { action: 'run', id: workflowId })], 'toolUse'),
    assistant([call('write', 'write', { path: 'workflow.txt', content: 'verified workflow result' })], 'toolUse'),
    assistant('Child finished'), assistant('Workflow complete'),
  ], { tools: ['redmaple_plan', 'write'], roles: { implementer: { tools: ['write'], instructions: 'Write the requested file' } } });
  const state = await f.runtime.redmaple.openPlatform();
  let plan = state.createWorkflow({ title: 'Write workflow.txt', steps: [{ id: 'produce', title: 'Write the required artifact',
    acceptanceSpec: [{ kind: 'file', path: 'workflow.txt', contains: 'verified workflow result' }, { kind: 'call', tool: 'write' }] }] });
  plan = state.transitionWorkflow(plan.id, plan.version, 'approve', { human: true });
  workflowId = plan.id;
  await f.runtime.session.prompt('Execute the approved workflow');
  const result = f.runtime.session.messages.find(item => item.role === 'toolResult' && item.toolName === 'redmaple_plan');
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(state.get('workflows', workflowId).status, 'completed');
  assert.equal(await readFile(join(f.cwd, 'workflow.txt'), 'utf8'), 'verified workflow result');
  const models = Object.values(f.runtime.redmaple.controls.ledger.snapshot().calls).filter(item => item.kind === 'model');
  assert.equal(models.length, 4);
  assert.equal(new Set(models.map(item => item.runId)).size, 1);
});

test('evolution tool uses configured evaluation and activates the fixed version on the next native turn', async t => {
  let candidateId;
  let evaluations = 0;
  const f = await fixture(t, [
    () => assistant([call('evaluate', 'redmaple_evolution', { action: 'evaluate', id: candidateId })], 'toolUse'),
    assistant('Evaluated'), assistant('Applied versioned strategy'),
  ], { tools: ['redmaple_evolution'], evolution: { evaluatorId: 'fixture/1', datasetVersion: 'cases/1', autoEvaluate: true,
    evaluate: async () => { evaluations += 1;
      return { cases: [{ id: 'citation', candidate: { pass: true, cost: 0 }, baseline: { pass: false, cost: 0 } }] };
    } } });
  const state = await f.runtime.redmaple.openPlatform();
  await writeFile(join(f.cwd, 'verified.txt'), 'source proof');
  let plan = state.createWorkflow({ title: 'verify', steps: [{ id: 's', title: 'check',
    acceptanceSpec: [{ kind: 'file', path: 'verified.txt', contains: 'proof' }] }] });
  plan = state.transitionWorkflow(plan.id, plan.version, 'approve', { human: true });
  plan = state.transitionWorkflow(plan.id, plan.version, 'start', { stepId: 's' });
  const receipt = await state.verifyWorkflow({ id: plan.id, version: plan.version, stepId: 's' });
  plan = state.get('workflows', plan.id);
  state.transitionWorkflow(plan.id, plan.version, 'complete', { stepId: 's' });
  state.recordDecision({ workflowId: plan.id, stepId: 's', goal: 'Cite evidence', assessment: 'The evidence was verified',
    nextAction: 'Reuse the evidence check', evidenceRefs: [receipt.id] });
  candidateId = (await state.evolution.propose({ assetKey: 'citation-policy', content: 'Always verify source citations before finalizing', verificationId: receipt.id })).id;
  await f.runtime.session.prompt('Evaluate the improvement candidate');
  assert.equal(state.get('candidates', candidateId).status, 'eligible');
  assert.equal(state.list('candidates', { status: 'eligible' }).length, 2);
  assert.equal(evaluations, 2);
  state.evolution.activate(candidateId, { human: true });
  await f.runtime.session.prompt('Use the active policy');
  assert.ok(JSON.stringify(f.script.requests.at(-1)).includes('Always verify source citations before finalizing'));
});

test('reopened native sessions resume the original shared budget without granting new calls', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'redmaple-budget-resume-'));
  let runtime;
  t.after(async () => { await runtime?.dispose(); await rm(cwd, { recursive: true, force: true }); });
  const script = scripted([assistant('first'), assistant('second')]);
  const options = { cwd, agentDir: join(cwd, 'agent'), model, streamFn: script.streamFn,
    policy: { profile: 'trusted' }, limits: { modelCalls: 2 }, settings: { retry: { enabled: false } } };
  runtime = await createRedMapleRuntime(options);
  await runtime.session.prompt('first task');
  const budgetId = Object.keys(runtime.redmaple.controls.ledger.snapshot().runs)[0];
  const sessionFile = runtime.session.sessionManager.getSessionFile();
  await runtime.dispose();
  runtime = await createRedMapleRuntime({ ...options, sessionFile });
  await runtime.redmaple.controls.runInBudget(budgetId, () => runtime.session.prompt('continue the same task'));
  const state = runtime.redmaple.controls.ledger.snapshot();
  assert.equal(state.runs[budgetId].usage.modelCalls, 2);
  assert.equal(Object.keys(state.runs).length, 1);
  await runtime.redmaple.controls.runInBudget(budgetId, () => runtime.session.prompt('exceed the original budget'));
  assert.equal(script.requests.length, 2);
  assert.equal(runtime.redmaple.controls.ledger.snapshot().runs[budgetId].usage.modelCalls, 2);
});

test('root session cancellation reaches a workflow child even without an outer prompt', { timeout: 60000 }, async t => {
  let started;
  const waiting = new Promise(done => { started = done; });
  let cancelled = false;
  const slow = { name: 'slow_check', label: 'Slow check', description: 'wait for cancellation',
    parameters: { type: 'object', properties: {} }, annotations: { readOnlyHint: true },
    async execute(id, args, signal) {
      started();
      return new Promise((done, reject) => {
        const abort = () => { cancelled = true; reject(Object.assign(new Error('cancelled'), { knownOutcome: true })); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    } };
  const f = await fixture(t, [assistant([call('slow', 'slow_check', {})], 'toolUse')],
    { customTools: [slow], tools: ['slow_check'], roles: { implementer: { tools: ['slow_check'] } } });
  const state = await f.runtime.redmaple.openPlatform();
  let plan = state.createWorkflow({ title: 'slow check', steps: [{ id: 's', title: 'Use slow_check',
    acceptanceSpec: [{ kind: 'file', path: 'never-created.txt' }] }] });
  plan = state.transitionWorkflow(plan.id, plan.version, 'approve', { human: true });
  const runner = await f.runtime.redmaple.openWorkflowRunner();
  const run = runner.run(plan.id);
  await waiting;
  await f.runtime.session.abort();
  assert.equal((await run).state.outcome.status, 'aborted');
  assert.equal(cancelled, true);
  assert.equal(state.get('workflows', plan.id).steps[0].status, 'cancelled');
});

class TestTerminal {
  constructor(columns = 100, rows = 36) {
    this.screen = new VirtualTerminal({ cols: columns, rows, allowProposedApi: true });
    this.columns = columns; this.rows = rows; this.kittyProtocolActive = false;
  }
  start(onInput, onResize) { this.input = onInput; this.resize = onResize; }
  stop() {}
  write(data) { this.screen.write(data); }
  moveBy(lines) { this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? 'A' : 'B'}`); }
  hideCursor() {} showCursor() {} setTitle() {} setProgress() {} setProgramStatus() {}
  clearLine() { this.write('\x1b[2K'); }
  clearFromCursor() { this.write('\x1b[0J'); }
  clearScreen() { this.write('\x1b[2J\x1b[H'); }
  async flush() { await new Promise(done => this.screen.write('', done)); }
  text() { return Array.from({ length: this.screen.buffer.active.length }, (_, index) => this.screen.buffer.active.getLine(index).translateToString(true)).join('\n'); }
}

test('native TUI renders maple branding, keyboard editor, help and theme palette', async t => {
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = '1';
  const f = await fixture(t, [assistant('TUI verified')], { mode: 'tui' });
  const terminal = new TestTerminal();
  const ui = new InteractiveMode(f.runtime, { terminal, initialThemeSetting: 'redmaple', tuiMode: 'regular' });
  try {
    await ui.init();
    await new Promise(done => setTimeout(done, 100));
    await terminal.flush();
    assert.match(terminal.text(), /红枫 Red Maple/);
    terminal.input('hello maple');
    await new Promise(done => setTimeout(done, 60));
    await terminal.flush();
    assert.match(terminal.text(), /hello maple/);
    terminal.input('\x15');
    terminal.input('/hotkeys'); terminal.input('\r');
    await new Promise(done => setTimeout(done, 200));
    await terminal.flush();
    assert.match(terminal.text(), /[Kk]eyboard|[Hh]otkeys|[Kk]eybindings/);
    const evidence = process.env.REDMAPLE_TUI_EVIDENCE;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, 'tui-screen.txt'), terminal.text());
      const buffer = terminal.screen.buffer.active;
      const lines = Array.from({ length: buffer.length }, (_, row) => {
        const line = buffer.getLine(row);
        return Array.from({ length: line.length }, (_, column) => {
          const cell = line.getCell(column);
          return { text: cell.getChars(), width: cell.getWidth(), fg: cell.isFgRGB() ? cell.getFgColor() : null, bg: cell.isBgRGB() ? cell.getBgColor() : null };
        });
      });
      await writeFile(join(evidence, 'tui-cells.json'), JSON.stringify(lines));
    }
  } finally {
    ui.stop(); terminal.screen.dispose(); (await upstreamModule('modes/interactive/theme/theme.js')).stopThemeWatcher();
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  }
});

test('Docker sandbox runs with network disabled and cancellation removes its container', { skip: !process.env.REDMAPLE_SANDBOX_IMAGE }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'redmaple-docker-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const image = process.env.REDMAPLE_SANDBOX_IMAGE;
  const result = await executeSandbox({ workspace: cwd, image, command: 'printf isolated > proof.txt; cat /proc/net/route' });
  assert.equal(result.details.isolation, 'docker');
  assert.equal(result.details.exitCode, 0);
  assert.equal(await readFile(join(cwd, 'proof.txt'), 'utf8'), 'isolated');
  assert.ok(!result.content[0].text.includes('eth0'));
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), 2000);
  const cancelled = await executeSandbox({ workspace: cwd, image, command: 'sleep 60', signal: controller.signal });
  clearTimeout(timer);
  assert.equal(cancelled.details.cancelled, true);
  assert.ok(Date.now() - started < 45000);
});

test('native sandbox tool forwards fractional and long explicit timeouts', { skip: !process.env.REDMAPLE_SANDBOX_IMAGE }, async t => {
  const f = await fixture(t, [
    assistant([call('short', 'bash', { command: 'sleep 5', timeout: 0.1 })], 'toolUse'),
    assistant([call('long', 'bash', { command: 'printf forwarded', timeout: 180 })], 'toolUse'),
    assistant('Timeout forwarding verified'),
  ], { tools: ['bash'], limits: { seconds: 200 }, policy: { profile: 'sandbox', dockerImage: process.env.REDMAPLE_SANDBOX_IMAGE } });
  await f.runtime.session.prompt('Run the sandbox checks');
  const calls = Object.values(f.runtime.redmaple.controls.ledger.snapshot().calls).filter(item => item.name === 'bash');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].result.details.timedOut, true);
  assert.equal(calls[0].result.details.timeoutMs, 100);
  assert.equal(calls[1].result.details.timeoutMs, 180000);
  assert.equal(calls[1].result.isError, false);
});
