import { defineTask, defineDoc } from '@earendil-works/pi-durable';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { openRedMapleHarness, BACKGROUND_CONTEXT } from './durable.js';
import { AgentBaseError } from './shared.js';
import { executionScope } from './session-controls.js';

const Index = defineDoc({ kind: 'redmaple.workflow.index', version: 1, scope: 'session',
  initial: () => ({ tasks: {} }), checkpointWhen: () => true });

export async function openWorkflowRunner({ file, state, models, executeStep, reconcileStep, controls, recoverLock = false }) {
  if (typeof executeStep !== 'function') throw new TypeError('A step executor is required');
  const Task = defineTask({ name: 'redmaple.workflow', version: 1,
    initial: () => ({ phase: 'advance', sequence: 0 }),
    phases: {
      async advance(task, runtime, context) {
        let plan = state.get('workflows', task.input.workflowId);
        const finish = outcome => runtime.commit(() => ({ status: 'terminal', outcome }), context);
        if (plan?.status === 'completed') return finish({ status: 'completed', result: { workflowId: plan.id } });
        if (plan?.status !== 'active') return finish({ status: 'failed', error: { message: '计划尚未批准或已暂停' } });
        let step = plan.steps.find(item => ['running', 'verifying', 'blocked'].includes(item.status));
        if (!step) step = plan.steps.find(item => item.status === 'pending' && !item.approvalRequired
          && item.dependsOn.every(id => ['done', 'skipped'].includes(plan.steps.find(dep => dep.id === id).status)));
        if (!step) return finish({ status: 'failed', error: { message: '计划需要用户处理失败、依赖或人工节点' } });
        if (step.status === 'pending') {
          plan = state.transitionWorkflow(plan.id, plan.version, 'start', { stepId: step.id });
          step = plan.steps.find(item => item.id === step.id);
        }
        const operationId = `${plan.id}/${step.id}/${step.attempt}`;
        let operation = state.get('children', operationId);
        if (!operation) {
          state.update(data => { data.children[operationId] = { id: operationId, type: 'workflow-operation',
            workflowId: plan.id, stepId: step.id, attempt: step.attempt, budgetId: task.input.budgetId,
            status: 'intent', createdAt: Date.now() }; });
          operation = state.get('children', operationId);
        }
        const checkpoint = patch => state.update(data => Object.assign(data.children[operationId], patch));
        try {
          let result = operation.result;
          if (operation.status !== 'succeeded') {
            if (operation.status !== 'intent') {
              result = await reconcileStep?.({ plan, step, operation, signal: runtime.signal });
              if (!result || result.status !== 'succeeded') throw new AgentBaseError('result_unknown', '步骤已发送，需核对实际结果后继续');
            } else {
              checkpoint({ status: 'dispatched', owner: { pid: process.pid, host: hostname(), token: randomUUID() } });
              const execute = () => executionScope.run({ ...executionScope.getStore(), workflow: {
                workflowId: plan.id, stepId: step.id, attempt: step.attempt, operationId,
              }, depth: (executionScope.getStore()?.depth || 0) + 1 },
              () => executeStep({ plan, step, operationId, signal: runtime.signal, checkpoint }));
              result = controls && task.input.budgetId ? await controls.runInBudget(task.input.budgetId, execute) : await execute();
              if (result?.status !== 'succeeded') throw new AgentBaseError('step_failed', result?.error || '步骤执行未成功', { knownOutcome: true });
            }
            checkpoint({ status: 'succeeded', result, owner: null });
          }
          plan = state.get('workflows', plan.id);
          if (plan.status !== 'active') throw new AgentBaseError('plan_inactive', '执行期间计划已暂停');
          step = plan.steps.find(item => item.id === step.id);
          if (step.status === 'blocked') {
            state.update(data => { data.workflows[plan.id].steps.find(item => item.id === step.id).status = 'running'; });
            plan = state.get('workflows', plan.id);
          }
          const verification = await state.verifyWorkflow({ id: plan.id, version: plan.version, stepId: step.id,
            callKeys: result?.callKeys || [], signal: runtime.signal });
          if (verification.verdict !== 'pass') return finish({ status: 'failed', error: { message: '步骤验收失败' } });
          plan = state.get('workflows', plan.id);
          state.transitionWorkflow(plan.id, plan.version, 'complete', { stepId: step.id, verificationId: verification.id });
          await runtime.commit(() => ({ status: 'pending', checkpoint: { phase: 'advance', sequence: task.state.checkpoint.sequence + 1 } }), context);
        } catch (error) {
          if (runtime.signal.aborted) return;
          state.update(data => {
            const saved = data.workflows[plan.id];
            const current = saved.steps.find(item => item.id === step.id);
            if (!['done', 'cancelled'].includes(current.status)) current.status = error.knownOutcome ? 'failed' : 'blocked';
            current.failure = error.message;
            saved.version += 1;
          });
          await finish({ status: 'failed', error: { message: error.message, detail: { code: error.code || 'result_unknown' } } });
        }
      },
    },
    async abort(task, runtime, context) {
      state.update(data => {
        const plan = data.workflows[task.input.workflowId];
        for (const step of plan?.steps || []) if (['running', 'verifying', 'blocked'].includes(step.status)) step.status = 'cancelled';
        if (plan) plan.version += 1;
      });
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
    },
  });
  const harness = await openRedMapleHarness({ file, models, recoverLock,
    extensions: [{ name: 'redmaple-workflow', tasks: [Task] }] });
  return {
    harness,
    async start(workflowId, { budgetId } = {}) {
      const plan = state.get('workflows', workflowId);
      if (!plan) throw new AgentBaseError('plan_missing', '计划不存在');
      const root = await harness.root(BACKGROUND_CONTEXT);
      const taskId = await root.commit(async tx => {
        const index = await tx.doc(Index);
        const previous = index.tasks[workflowId] && await tx.task(index.tasks[workflowId]);
        if (previous && !['terminal', 'completing'].includes(previous.state.status)) return previous.id;
        if (previous?.state.outcome?.status === 'completed' && plan.status === 'completed') return previous.id;
        const id = await tx.createTask(Task, { workflowId, budgetId: budgetId || null }, { ownership: { kind: 'conversation' } });
        index.tasks[workflowId] = id;
        return id;
      }, BACKGROUND_CONTEXT);
      state.update(data => { data.workflows[workflowId].durableTaskId = taskId; });
      return taskId;
    },
    wait: taskId => harness.waitForTask(taskId, BACKGROUND_CONTEXT),
    cancel: taskId => harness.abortTask(taskId, BACKGROUND_CONTEXT),
    close: () => harness.close(BACKGROUND_CONTEXT),
  };
}
