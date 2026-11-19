import { join } from 'node:path';
import { openWorkflowRunner } from './workflow-runner.js';
import { AgentBaseError } from './shared.js';
import { executionScope } from './session-controls.js';

export async function openRuntimeWorkflowRunner({ root, state, agentDir, options }) {
  const controls = root.redmaple.controls;
  const callsFor = operation => Object.values(controls.ledger.snapshot().calls)
    .filter(call => call.runId === operation.budgetId && call.startedAt >= operation.createdAt);
  const runner = await openWorkflowRunner({ file: join(agentDir, `workflows-${state.key}.sqlite`), state,
    models: root.services.modelRuntime, controls, recoverLock: options.recoverLock,
    async executeStep({ plan, step, operationId, signal, checkpoint }) {
      if ((executionScope.getStore()?.depth || 0) > (options.maxDelegateDepth ?? 2)) {
        throw new AgentBaseError('delegation_depth', '已达到工作流委派深度上限', { knownOutcome: true });
      }
      const { createRedMapleRuntime } = await import('./full-runtime.js');
      const roleName = step.execution?.role || 'implementer';
      const role = options.roles?.[roleName] || { instructions: '执行任务并引用核验依据' };
      const child = await createRedMapleRuntime({ ...options, cwd: state.workspace, agentDir,
        modelRuntime: root.services.modelRuntime, model: role.model || root.session.model, mode: 'print',
        apiKey: undefined, apiKeyEnv: undefined, sessionManager: undefined, settingsManager: undefined,
        sessionFile: undefined, continueSession: false, inMemory: false, sessionDir: join(agentDir, 'children'),
        tools: role.tools || options.tools, thinkingLevel: role.thinkingLevel || options.thinkingLevel,
        resources: { ...options.resources, appendSystemPrompt: [...(options.resources?.appendSystemPrompt || []), role.instructions || ''] } });
      const abort = () => { void child.session.abort(); };
      try {
        checkpoint({ sessionId: child.session.sessionId, sessionFile: child.session.sessionManager.getSessionFile() });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) throw new AgentBaseError('cancelled', '工作流已取消', { knownOutcome: true });
        await child.session.prompt(`${plan.title}\n${step.execution?.prompt || step.title}`);
        const operation = state.get('children', operationId);
        const scope = executionScope.getStore()?.controls || controls;
        const calls = Object.values(scope.ledger.snapshot().calls)
          .filter(call => call.runId === operation.budgetId && call.startedAt >= operation.createdAt);
        if (calls.some(call => ['pending', 'unknown'].includes(call.status))) throw new AgentBaseError('result_unknown', '子会话存在未核对调用');
        const message = child.session.messages.filter(item => item.role === 'assistant').at(-1);
        if (message?.stopReason !== 'stop') throw new AgentBaseError('step_failed', message?.errorMessage || '子会话缺少完整结果', { knownOutcome: true });
        return { status: 'succeeded', sessionId: child.session.sessionId,
          output: message.content.filter(item => item.type === 'text').map(item => item.text).join('\n'),
          callKeys: calls.map(call => call.key) };
      } finally { signal.removeEventListener('abort', abort); await child.dispose(); }
    },
    async reconcileStep({ operation }) {
      if (!operation.sessionFile) return undefined;
      const calls = callsFor(operation);
      if (!calls.length || calls.some(call => ['pending', 'unknown'].includes(call.status))) return undefined;
      const { SessionManager } = await import('@earendil-works/pi-coding-agent');
      const session = SessionManager.open(operation.sessionFile);
      const message = session.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'assistant').at(-1)?.message;
      if (message?.stopReason !== 'stop') return undefined;
      return { status: 'succeeded', sessionId: operation.sessionId,
        output: message.content.filter(item => item.type === 'text').map(item => item.text).join('\n'), callKeys: calls.map(call => call.key) };
    },
  });
  let invocation;
  runner.run = (workflowId, { signal } = {}) => {
    if (invocation) {
      if (invocation.workflowId === workflowId) return invocation.promise;
      return Promise.reject(new AgentBaseError('run_busy', '当前根会话已有工作流运行', { knownOutcome: true }));
    }
    const promise = controls.withRun('workflow', async () => {
      const budgetId = executionScope.getStore()?.controls?.ledger.active?.id;
      const taskId = await runner.start(workflowId, { budgetId });
      const controller = new AbortController();
      controls.taskAbortControllers.add(controller);
      const abort = () => { void runner.cancel(taskId).catch(error => options.onError?.(error)); };
      const forward = () => controller.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      signal?.addEventListener('abort', forward, { once: true });
      if (signal?.aborted || controls.ledger.active?.reason) controller.abort();
      try { return await runner.wait(taskId); }
      finally {
        controls.taskAbortControllers.delete(controller);
        controller.signal.removeEventListener('abort', abort);
        signal?.removeEventListener('abort', forward);
      }
    });
    invocation = { workflowId, promise: promise.finally(() => { invocation = undefined; }) };
    return invocation.promise;
  };
  return runner;
}
