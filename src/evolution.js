import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { AgentBaseError, fingerprint } from './shared.js';
import { ownerAlive } from './store.js';
import { validateCompletion } from './workflow-verification.js';

function fail(code, message) { throw new AgentBaseError(code, message, { knownOutcome: true }); }

export class EvolutionStore {
  constructor(state) { this.state = state; }

  async propose({ assetKey, kind = 'strategy', content, verificationId, decisionId }) {
    if (typeof assetKey !== 'string' || !assetKey.trim() || typeof content !== 'string' || !content.trim() || !['strategy', 'skill', 'memory'].includes(kind)) {
      fail('invalid_candidate', '经验候选需要名称、内容和有效类型');
    }
    const verified = this.validateEvidence(verificationId);
    const id = fingerprint({ assetKey, kind, content, verificationId, decisionId });
    const existing = this.state.get('candidates', id);
    if (existing) return existing;
    const candidate = { id, assetKey, kind, content, verificationId, decisionId,
      sourceHash: fingerprint(verified), status: 'proposed', createdAt: Date.now() };
    return this.state.update(data => { data.candidates[id] = candidate; return candidate; });
  }

  validateEvidence(verificationId) {
    const receipt = this.state.get('verifications', verificationId);
    const plan = receipt && this.state.get('workflows', receipt.workflowId);
    const step = plan?.steps.find(item => item.id === receipt.stepId);
    if (!step || step.status !== 'done') fail('invalid_evidence', '经验需要已完成步骤的核验依据');
    return validateCompletion(this.state, plan, step, verificationId);
  }

  active() {
    return this.state.list('activations', { status: 'active' }).filter(item => item.assetId).flatMap(item => {
      const asset = this.state.get('assets', item.assetId);
      const candidate = this.state.get('candidates', asset.candidateId);
      try {
        if (fingerprint(this.validateEvidence(candidate.verificationId)) !== candidate.sourceHash) return [];
        return [{ ...asset, activationId: item.id, activationVersion: item.version }];
      } catch (error) {
        if (!['invalid_evidence', 'artifact_changed', 'call_changed', 'ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        return [];
      }
    });
  }

  async extract(options) {
    const results = [];
    for (const decision of this.state.list('decisions', options)) {
      const verificationId = decision.evidenceRefs.find(id => this.state.get('verifications', id)?.verdict === 'pass');
      if (!verificationId) continue;
      try {
        results.push(await this.propose({ assetKey: `decision/${decision.workflowId}/${decision.stepId}`,
          kind: 'strategy', content: `${decision.goal}\n${decision.assessment}\n${decision.nextAction}`,
          verificationId, decisionId: decision.id }));
      } catch (error) { if (!['invalid_evidence', 'artifact_changed', 'call_changed', 'ENOENT'].includes(error.code)) throw error; }
    }
    return results;
  }

  async evaluate(id, evaluator, { evaluatorId, datasetVersion, minCases = 1, maxCost = Infinity,
    signal, resume = false } = {}) {
    if (typeof evaluator !== 'function' || typeof evaluatorId !== 'string' || !evaluatorId
      || typeof datasetVersion !== 'string' || !datasetVersion) fail('evaluator_required', '请配置独立评估器和数据集版本');
    if (!Number.isInteger(minCases) || minCases < 1 || !(maxCost >= 0)) fail('invalid_evaluation', '评估样本数和预算配置无效');
    const candidate = this.state.get('candidates', id);
    if (!candidate) fail('candidate_missing', '候选不存在');
    const source = this.validateEvidence(candidate.verificationId);
    if (fingerprint(source) !== candidate.sourceHash) fail('invalid_evidence', '候选证据已变化');
    if (candidate.status === 'active') fail('invalid_transition', '活动版本请通过新候选评估');
    const pointerId = fingerprint({ assetKey: candidate.assetKey, kind: candidate.kind });
    const pointer = this.state.get('activations', pointerId);
    const baseline = pointer?.assetId ? this.state.get('assets', pointer.assetId) : undefined;
    const prior = candidate.evaluationId && this.state.get('evaluations', candidate.evaluationId);
    if (candidate.status === 'evaluating' && (!resume || ownerAlive(prior?.owner))) fail('evaluation_busy', '此评估仍有执行者');
    if (resume && prior && (prior.evaluatorId !== evaluatorId || prior.datasetVersion !== datasetVersion
      || prior.baselineId !== (baseline?.id || null))) fail('evaluation_changed', '恢复评估的基准或配置已变化');
    const evaluationId = resume && prior ? prior.id : randomUUID();
    const token = randomUUID();
    const record = { id: evaluationId, candidateId: id, candidateHash: fingerprint(candidate.content),
      baselineId: baseline?.id || null, pointerVersion: pointer?.version || 0, evaluatorId, datasetVersion,
      status: 'evaluating', createdAt: prior?.createdAt || Date.now(),
      checkpoint: resume ? prior?.checkpoint : undefined, owner: { pid: process.pid, host: hostname(), token } };
    this.state.update(data => {
      if (data.candidates[id]._revision !== candidate._revision) fail('version_conflict', '候选已更新');
      Object.assign(data.candidates[id], { status: 'evaluating', evaluationId });
      data.evaluations[evaluationId] = record;
    });
    const checkpoint = value => this.state.update(data => {
      const active = data.evaluations[evaluationId];
      if (active.owner?.token !== token) fail('owner_changed', '评估执行者已变化');
      active.checkpoint = structuredClone(value);
    });
    try {
      if (signal?.aborted) fail('cancelled', '评估已取消');
      const result = await evaluator({ candidate: structuredClone(candidate), baseline: structuredClone(baseline),
        operationId: evaluationId, previous: record.checkpoint, checkpoint, maxCost, signal });
      if (signal?.aborted) fail('cancelled', '评估已取消');
      const cases = result?.cases;
      if (!Array.isArray(cases) || cases.length < minCases || cases.some(item => typeof item.id !== 'string'
        || typeof item.candidate?.pass !== 'boolean' || typeof item.baseline?.pass !== 'boolean'
        || !Number.isFinite(item.candidate.cost) || item.candidate.cost < 0
        || !Number.isFinite(item.baseline.cost) || item.baseline.cost < 0)
        || new Set(cases.map(item => item.id)).size !== cases.length) fail('invalid_evaluation', '评估需要独立且完整的配对任务结果');
      const candidatePass = cases.filter(item => item.candidate.pass).length;
      const baselinePass = cases.filter(item => item.baseline.pass).length;
      const candidateCost = cases.reduce((sum, item) => sum + item.candidate.cost, 0);
      const baselineCost = cases.reduce((sum, item) => sum + item.baseline.cost, 0);
      const regressed = cases.some(item => item.baseline.pass && !item.candidate.pass);
      const eligible = !regressed && candidateCost + baselineCost <= maxCost
        && (candidatePass > baselinePass || candidatePass === baselinePass && candidateCost < baselineCost);
      return this.state.update(data => {
        const active = data.evaluations[evaluationId];
        if (active.owner?.token !== token) fail('owner_changed', '评估执行者已变化');
        Object.assign(active, { status: 'completed', owner: null, cases, candidatePass, baselinePass,
          candidateCost, baselineCost, eligible, endedAt: Date.now() });
        data.candidates[id].status = eligible ? 'eligible' : 'evaluated';
        return active;
      });
    } catch (error) {
      this.state.update(data => {
        const active = data.evaluations[evaluationId];
        if (active.owner?.token !== token) return;
        Object.assign(active, { status: 'evaluation_failed', owner: null, error: error.message, endedAt: Date.now() });
        data.candidates[id].status = 'evaluation_failed';
      });
      throw error;
    }
  }

  activate(id, { human = false, policy, expectedVersion, expectedRevision } = {}) {
    const candidate = this.state.get('candidates', id);
    if (expectedRevision !== undefined && candidate?._revision !== expectedRevision) fail('version_conflict', '候选已变化，请重新审阅');
    const evaluation = candidate && this.state.get('evaluations', candidate.evaluationId);
    if (!candidate || candidate.status !== 'eligible' || !evaluation?.eligible || evaluation.status !== 'completed'
      || evaluation.candidateHash !== fingerprint(candidate.content)) fail('evaluation_required', '晋升需要此候选的有效通过评估');
    if (fingerprint(this.validateEvidence(candidate.verificationId)) !== candidate.sourceHash) fail('invalid_evidence', '候选证据已变化');
    if (!human && policy?.({ candidate: structuredClone(candidate), evaluation: structuredClone(evaluation) }) !== true) {
      fail('approval_required', '晋升需要人工确认或预授权策略');
    }
    return this.state.update(data => {
      if (data.candidates[id]._revision !== candidate._revision) fail('version_conflict', '候选已更新');
      const pointerId = fingerprint({ assetKey: candidate.assetKey, kind: candidate.kind });
      const prior = data.activations[pointerId];
      if ((prior?.version || 0) !== (expectedVersion ?? evaluation.pointerVersion)
        || (prior?.assetId || null) !== evaluation.baselineId) fail('version_conflict', '活动基准已变化，请重新评估');
      const assetId = fingerprint({ assetKey: candidate.assetKey, kind: candidate.kind, content: candidate.content });
      data.assets[assetId] ||= { id: assetId, assetKey: candidate.assetKey, kind: candidate.kind,
        content: candidate.content, candidateId: id, evaluationId: evaluation.id, status: 'version', createdAt: Date.now() };
      data.activations[pointerId] = { id: pointerId, assetKey: candidate.assetKey, kind: candidate.kind, assetId,
        previous: prior?.assetId || null, history: [...(prior?.history || []), { assetId: prior?.assetId || null, at: Date.now() }],
        status: 'active', version: (prior?.version || 0) + 1 };
      if (prior?.assetId) data.candidates[data.assets[prior.assetId].candidateId].status = 'superseded';
      data.candidates[id].status = 'active';
      return data.activations[pointerId];
    });
  }

  rollback(activationId, { human = false, expectedVersion, targetId, reason } = {}) {
    if (!human || !reason?.trim()) fail('approval_required', '回滚需要用户确认与原因');
    return this.state.update(data => {
      const pointer = data.activations[activationId];
      if (!pointer || pointer.version !== expectedVersion) fail('version_conflict', '活动版本已更新');
      const target = targetId === undefined ? pointer.previous : targetId;
      if (target && !pointer.history.some(item => item.assetId === target)) fail('invalid_version', '目标不属于此资产的历史');
      if (pointer.assetId) data.candidates[data.assets[pointer.assetId].candidateId].status = 'rolled_back';
      pointer.history.push({ assetId: pointer.assetId, reason, at: Date.now() });
      pointer.previous = pointer.assetId;
      pointer.assetId = target || null;
      pointer.version += 1;
      pointer.status = target ? 'active' : 'disabled';
      if (target) data.candidates[data.assets[target].candidateId].status = 'active';
      return pointer;
    });
  }
}
