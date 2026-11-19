import { writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PlatformState } from '../src/platform.js';
import { openWorkflowRunner } from '../src/workflow-runner.js';

const [cwd, workflowId] = process.argv.slice(2);
const state = await PlatformState.open(join(cwd, 'platform.sqlite'), cwd);
const models = await ModelRuntime.create({ authPath: join(cwd, 'auth.json'), modelsPath: join(cwd, 'models.json'), allowModelNetwork: false });
const runner = await openWorkflowRunner({ file: join(cwd, 'workflow.sqlite'), state, models,
  executeStep: async () => {
    await appendFile(join(cwd, 'effects.txt'), 'x');
    await writeFile(join(cwd, 'result.txt'), 'effect completed');
    process.stdout.write('effect_completed\n');
    await new Promise(() => {});
  } });
await runner.wait(await runner.start(workflowId));
