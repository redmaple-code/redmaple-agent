import { readFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AgentBaseError, fingerprint, checkSignal } from './shared.js';
import { scopedPath } from './permissions.js';

export function acceptanceRules(rules = [{ kind: 'manual' }]) {
  if (!Array.isArray(rules) || !rules.length || rules.some(rule => !['file', 'call', 'manual', 'custom'].includes(rule.kind)
    || rule.kind === 'file' && (typeof rule.path !== 'string' || !rule.path)
    || rule.kind === 'call' && (typeof rule.tool !== 'string' || !rule.tool)
    || rule.kind === 'custom' && (typeof rule.verifier !== 'string' || !rule.verifier
      || !Array.isArray(rule.artifactPaths) || !rule.artifactPaths.length || rule.artifactPaths.some(path => typeof path !== 'string')))) {
    throw new AgentBaseError('invalid_acceptance', '验收规则需要有效的文件、工具调用或人工核验项');
  }
  return structuredClone(rules);
}

export async function verifyWorkflow(state, { id, version, stepId, evidence, callKeys = [], human = false, signal }) {
  const plan = state.get('workflows', id);
  const step = plan?.steps.find(item => item.id === stepId);
  if (!plan || plan.version !== version) throw new AgentBaseError('version_conflict', '计划版本已变化');
  if (plan.status !== 'active' || !['running', 'verifying'].includes(step?.status)) {
    throw new AgentBaseError('invalid_transition', '请先启动步骤再核验');
  }
  const rules = acceptanceRules(step.acceptanceSpec);
  const artifacts = [];
  const calls = [];
  const customChecks = [];
  const diagnostics = [];
  const capture = async rule => {
    const path = await scopedPath(state.workspace, state.resolvePath(rule.path));
    const text = await readFile(path, { encoding: 'utf8', signal });
    const hash = fingerprint(text);
    if (rule.hash && rule.hash !== hash) throw new Error('文件指纹与验收规则不匹配');
    if (rule.contains !== undefined && !text.includes(rule.contains)) throw new Error('文件缺少验收规则要求的内容');
    artifacts.push({ path, hash });
  };
  for (const rule of rules) {
    try {
      checkSignal(signal);
      if (rule.kind === 'manual') {
        if (!human || !evidence?.trim()) throw new Error('此验收项需要用户核验并提供依据');
      } else if (rule.kind === 'file') {
        await capture(rule);
      } else if (rule.kind === 'custom') {
        const verifier = state.verifiers?.[rule.verifier];
        if (typeof verifier?.verify !== 'function' || !verifier.version) throw new Error('请注册具备版本的验收器');
        const verifierVersion = verifier.version;
        const start = artifacts.length;
        for (const path of rule.artifactPaths) await capture({ path });
        const inputs = artifacts.slice(start);
        const result = await verifier.verify({ plan: structuredClone(plan), step: structuredClone(step), rule: structuredClone(rule),
          artifacts: structuredClone(inputs), signal });
        if (result?.verdict !== 'pass') throw new Error('自定义验收器未通过');
        for (const artifact of inputs) {
          if (fingerprint(await readFile(artifact.path, { encoding: 'utf8', signal })) !== artifact.hash) {
            throw new AgentBaseError('artifact_changed', '验收期间输入产物已变化');
          }
        }
        customChecks.push({ verifier: rule.verifier, version: verifierVersion, proof: result.proof || null });
      } else {
        const candidates = await Promise.all(callKeys.map(key => state.callLookup?.(key)));
        const call = candidates.find(item => item?.name === rule.tool && item.status === 'succeeded'
          && item.workflowId === id && item.stepId === stepId && item.attempt === step.attempt
          && !item.result?.isError && (!step.startedAt || item.startedAt >= step.startedAt));
        if (!call) throw new Error('缺少本次步骤成功执行的工具调用');
        calls.push({ key: call.key, hash: fingerprint(call), runId: call.runId });
      }
    } catch (error) { diagnostics.push({ rule, error: error.message, code: error.code }); }
  }
  checkSignal(signal);
  const transient = diagnostics.some(item => ['EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'ETIMEDOUT'].includes(item.code));
  const verdict = diagnostics.length ? transient ? 'inconclusive' : 'fail' : 'pass';
  const record = { id: randomUUID(), workflowId: id, stepId, attempt: step.attempt || 0,
    ruleHash: fingerprint(rules), ruleVersion: plan.ruleVersion || 'legacy',
    status: verdict === 'pass' ? 'passed' : verdict === 'fail' ? 'failed' : 'inconclusive', verdict,
    artifacts, calls, customChecks, diagnostics, evidence: evidence || '', human, createdAt: Date.now(), verifier: 'redmaple/1' };
  return state.update(data => {
    const current = data.workflows[id];
    if (current._revision !== plan._revision) throw new AgentBaseError('version_conflict', '核验期间计划已更新');
    const target = current.steps.find(item => item.id === stepId);
    target.status = record.verdict === 'pass' ? 'verifying' : record.verdict === 'fail' ? 'failed' : 'blocked';
    target.verificationId = record.id;
    current.version += 1;
    data.verifications[record.id] = record;
    return record;
  });
}

export function validateCompletion(state, plan, step, verificationId) {
  const record = state.get('verifications', verificationId || step.verificationId);
  if (!record || record.verdict !== 'pass' || record.workflowId !== plan.id || record.stepId !== step.id
    || record.attempt !== (step.attempt || 0) || record.ruleHash !== fingerprint(acceptanceRules(step.acceptanceSpec))) {
    throw new AgentBaseError('evidence_required', '完成需要当前步骤与版本对应的通过核验记录');
  }
  for (const artifact of record.artifacts) {
    const path = state.resolvePath(artifact.path);
    if (realpathSync(path) !== path || fingerprint(readFileSync(path, 'utf8')) !== artifact.hash) {
      throw new AgentBaseError('artifact_changed', '核验后的文件已变化，请重新核验');
    }
  }
  for (const proof of record.calls) {
    const call = state.callLookup?.(proof.key);
    if (!call || typeof call.then === 'function' || fingerprint(call) !== proof.hash) {
      throw new AgentBaseError('call_changed', '核验后的调用记录已变化或无法同步核对');
    }
  }
  for (const check of record.customChecks || []) {
    if (state.verifiers?.[check.verifier]?.version !== check.version) {
      throw new AgentBaseError('verifier_changed', '验收器版本已更新，请重新核验');
    }
  }
  return record;
}
