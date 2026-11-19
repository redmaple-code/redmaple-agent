import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createAgentBase, FileStore, textResult } from '../src/index.js';
import { model, scripted, assistant, tool } from './fixtures.js';

test('process death leaves an unknown call and recovery reuses its reconciled result', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-base-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sdk = pathToFileURL(resolve('src/index.js')).href;
  const fixtures = pathToFileURL(resolve('test/fixtures.js')).href;
  const source = `
    import {createAgentBase,FileStore} from ${JSON.stringify(sdk)};
    import {model,scripted,assistant,call,tool} from ${JSON.stringify(fixtures)};
    const store=await FileStore.open(${JSON.stringify(directory)},'crash');
    const base=await createAgentBase({model,...scripted([assistant([call('effect','effect')],'toolUse')]),store,
      tools:[tool('effect',async()=>{process.stdout.write('TOOL_STARTED\\n');await new Promise(()=>{});})]});
    await base.prompt('recover this task',{requestId:'crashed-run'});
  `;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((done, reject) => { proc.on('close', done); proc.on('error', reject); });
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
  let output = '';
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('Child did not reach its durable tool intent')), 15000);
    proc.stdout.on('data', part => {
      output += part;
      if (output.includes('TOOL_STARTED')) { clearTimeout(timeout); done(); }
    });
    proc.once('error', reject);
  });
  proc.kill('SIGKILL');
  await closed;
  const store = await FileStore.open(directory, 'crash', { recoverLock: true });
  let repeated = 0;
  const script = scripted([assistant('verified recovery')]);
  const base = await createAgentBase({ model, ...script, store,
    tools: [tool('effect', async () => { repeated += 1; return textResult('wrong repeat'); })] });
  t.after(() => base.close());
  assert.equal(base.snapshot().runs['crashed-run'].status, 'interrupted');
  const unknown = Object.values(base.snapshot().calls).find(call => call.status === 'unknown');
  assert.equal(unknown.kind, 'tool');
  await assert.rejects(base.resume('crashed-run'), { code: 'result_unknown' });
  assert.equal(script.requests.length, 0);
  await base.reconcile(unknown.key, textResult('provider result confirmed'));
  const result = await base.resume('crashed-run');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.text, 'verified recovery');
  assert.equal(repeated, 0);
  assert.equal(script.requests[0].messages.at(-1).content[0].text, 'provider result confirmed');
  await base.close();
});
