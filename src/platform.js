import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { AgentBaseError, fingerprint } from './shared.js';
import { scopedPath } from './permissions.js';
import { PlatformStore } from './platform-store.js';
import { acceptanceRules, verifyWorkflow, validateCompletion } from './workflow-verification.js';
import { KnowledgeStore, searchTerms } from './knowledge.js';
import { EvolutionStore } from './evolution.js';
import { FileStore } from './store.js';

function fail(code, message) { throw new AgentBaseError(code, message, { knownOutcome: true }); }
function ownerAlive(owner) {
  if (!owner) return false;
  if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return true;
  try { process.kill(owner.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export class PlatformState extends PlatformStore {
  get knowledge() { return this._knowledge ||= new KnowledgeStore(this, this.knowledgeOptions); }
  get evolution() { return this._evolution ||= new EvolutionStore(this); }

  async source(path) {
    const canonical = await scopedPath(this.workspace, this.resolvePath(path));
    return { kind: 'file', path: canonical, hash: fingerprint(await readFile(canonical, 'utf8')) };
  }

  async validateSources(sources) {
    if (!Array.isArray(sources) || !sources.length) fail('source_required', '记忆需要至少一项可核查来源');
    for (const source of sources) {
      if (source.kind === 'knowledge') { await this.knowledge.validateSource(source); continue; }
      if (source.kind !== 'file' || !source.hash) fail('invalid_source', '文件来源需要路径与内容指纹');
      const current = await this.source(source.path);
      if (current.hash !== source.hash) fail('source_changed', '来源已变化，请重新核查');
    }
  }

  async remember({ key, text, sources }) {
    if (!key?.trim() || !text?.trim()) fail('invalid_memory', '记忆需要名称和内容');
    await this.validateSources(sources);
    const id = randomUUID();
    return this.update(state => {
      const conflicts = Object.values(state.memories).filter(item => item.key === key && item.status === 'approved' && item.text !== text);
      const item = { id, key, text, sources, status: 'pending', conflicts: conflicts.map(item => item.id), createdAt: Date.now() };
      state.memories[id] = item;
      return item;
    });
  }

  async decideMemory(id, approve, { expectedRevision } = {}) {
    const item = this.snapshot().memories[id];
    if (!item) fail('memory_missing', '记忆不存在');
    if (expectedRevision !== undefined && item._revision !== expectedRevision) fail('version_conflict', '记忆已变化，请重新审阅');
    if (approve) await this.validateSources(item.sources);
    return this.update(state => {
      if (fingerprint(state.memories[id] || null) !== fingerprint(item)) fail('version_conflict', '记忆已更新，请重新审阅');
      if (approve) for (const prior of Object.values(state.memories)) {
        if (prior.id !== id && prior.key === item.key && prior.status === 'approved') prior.status = 'superseded';
      }
      state.memories[id].status = approve ? 'approved' : 'rejected';
      return state.memories[id];
    });
  }

  async searchMemory(query = '', approvedOnly = true, { limit = 100, offset = 0, includeUnmatched = false } = {}) {
    if (typeof query !== 'string') fail('invalid_query', '记忆查询需要文本');
    const terms = searchTerms(query.slice(0, 500)).slice(0, 64);
    limit = Math.max(1, Math.min(1000, Math.trunc(limit) || 100));
    offset = Math.max(0, Math.trunc(offset) || 0);
    const text = "lower(json_extract(payload,'$.key') || ' ' || json_extract(payload,'$.text'))";
    const score = terms.length ? terms.map(() => `(CASE WHEN instr(${text},?)>0 THEN 1 ELSE 0 END)`).join('+') : '0';
    const found = this.db.prepare(`SELECT *,(${score}) AS relevance FROM memories WHERE scope_id=?
      ${approvedOnly ? "AND status='approved'" : ''} ${terms.length && !includeUnmatched ? 'AND relevance>0' : ''}
      ORDER BY relevance DESC,rowid DESC LIMIT ? OFFSET ?`).all(...terms, this.key, limit, offset)
      .map(row => ({ ...JSON.parse(row.payload), _revision: row.version }));
    const current = [];
    for (const item of found) {
      try {
        await this.validateSources(item.sources);
        if (fingerprint(this.get('memories', item.id) || null) === fingerprint(item)) current.push(item);
      }
      catch (error) {
        if (!['source_required', 'source_changed', 'source_missing', 'invalid_source', 'outside_workspace', 'ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        if (item.status === 'approved') this.update(state => {
          if (fingerprint(state.memories[item.id] || null) === fingerprint(item)) state.memories[item.id].status = 'stale';
        });
        if (!approvedOnly) current.push({ ...item, status: 'stale', error: error.message });
      }
    }
    return current;
  }

  createWorkflow({ title, steps }) {
    if (!title?.trim() || !Array.isArray(steps) || !steps.length) fail('invalid_plan', '计划需要标题和步骤');
    const ids = new Set(steps.map(step => step.id));
    if (ids.size !== steps.length || steps.some(step => !step.id || !step.title || (step.dependsOn || []).some(id => !ids.has(id)))) {
      fail('invalid_plan', '步骤编号、标题和依赖必须完整且唯一');
    }
    const visited = new Set();
    const visiting = new Set();
    const visit = id => {
      if (visiting.has(id)) fail('plan_cycle', '计划存在循环依赖');
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of steps.find(step => step.id === id).dependsOn || []) visit(dep);
      visiting.delete(id); visited.add(id);
    };
    for (const id of ids) visit(id);
    const plan = { id: randomUUID(), title, status: 'draft', version: 1, ruleVersion: '1',
      steps: steps.map(step => ({ id: step.id, title: step.title, dependsOn: step.dependsOn || [],
        execution: step.execution ? structuredClone(step.execution) : undefined,
        acceptanceSpec: acceptanceRules(step.acceptanceSpec),
        optional: Boolean(step.optional), approvalRequired: Boolean(step.approvalRequired), status: 'pending', attempt: 0 })) };
    this.update(state => { state.workflows[plan.id] = plan; });
    return plan;
  }

  verifyWorkflow(request) { return verifyWorkflow(this, request); }

  recordDecision({ workflowId, stepId, goal, assessment, nextAction, evidenceRefs = [], counterEvidenceRefs = [] }) {
    if (!goal?.trim() || !assessment?.trim() || !nextAction?.trim()) fail('invalid_decision', '决策需要目标、评价和下一步');
    return this.update(state => {
      const plan = state.workflows[workflowId];
      if (!plan?.steps.some(step => step.id === stepId)) fail('step_missing', '步骤不存在');
      for (const id of [...evidenceRefs, ...counterEvidenceRefs]) {
        if (state.verifications[id]?.workflowId !== workflowId) fail('invalid_evidence', '决策证据必须来自此计划');
      }
      const record = { id: randomUUID(), workflowId, stepId, goal, assessment, nextAction,
        evidenceRefs, counterEvidenceRefs, planVersion: plan.version, createdAt: Date.now() };
      state.decisions[record.id] = record;
      return record;
    });
  }

  transitionWorkflow(id, version, action, { stepId, evidence, verificationId, outcome, human = false } = {}) {
    return this.update(state => {
      const plan = state.workflows[id];
      if (!plan || plan.version !== version) fail('version_conflict', '计划版本已变化');
      if (action === 'approve') {
        if (!human || !['draft', 'paused'].includes(plan.status)) fail('approval_required', '需要用户批准计划');
        plan.status = 'active';
      } else if (action === 'pause') {
        if (plan.status !== 'active') fail('invalid_transition', '只有执行中的计划可暂停');
        plan.status = 'paused';
      } else {
        if (plan.status !== 'active') fail('plan_inactive', '请先批准或恢复计划');
        const step = plan.steps.find(item => item.id === stepId);
        if (!step) fail('step_missing', '步骤不存在');
        if (action === 'start') {
          if (step.status !== 'pending' || step.dependsOn.some(dep => !['done', 'skipped'].includes(plan.steps.find(item => item.id === dep).status))) {
            fail('dependency_pending', '步骤尚不满足执行条件');
          }
          if (step.approvalRequired && !human) fail('approval_required', '此步骤需要用户接管');
          step.status = 'running';
          step.attempt = (step.attempt || 0) + 1;
          step.startedAt = Date.now();
        } else if (action === 'complete') {
          if (!['running', 'verifying'].includes(step.status)) fail('evidence_required', '完成需要执行状态与核验依据');
          const verified = validateCompletion(this, plan, step, verificationId);
          step.status = 'done'; step.evidence = evidence || verified.evidence; step.verificationId = verified.id;
        } else if (action === 'fail' || action === 'cancel') {
          if (!['running', 'verifying'].includes(step.status)) fail('invalid_transition', '步骤尚未执行');
          step.status = action === 'fail' ? 'failed' : 'cancelled';
          step.failure = evidence || action;
        } else if (action === 'retry') {
          if (!['failed', 'blocked', 'cancelled'].includes(step.status)) fail('invalid_transition', '步骤不需要重试');
          step.status = 'pending';
          delete step.verificationId;
        } else if (action === 'branch') {
          if (!human || step.status !== 'pending' || !['take', 'skip'].includes(outcome)) fail('approval_required', '分支由用户选择');
          if (outcome === 'skip' && plan.ruleVersion !== 'legacy' && !step.optional) fail('required_step', '必交步骤需要完成验收');
          step.status = outcome === 'skip' ? 'skipped' : 'pending';
        } else fail('invalid_transition', '不支持的计划动作');
        if (plan.steps.every(item => ['done', 'skipped'].includes(item.status))) plan.status = 'completed';
      }
      plan.version += 1;
      return structuredClone(plan);
    });
  }

  async propose({ path, content }) {
    if (typeof content !== 'string') fail('invalid_proposal', '候选内容需要文本');
    const target = await scopedPath(this.workspace, this.resolvePath(path));
    const before = await readFile(target, 'utf8');
    const item = { id: randomUUID(), path: target, before, content, beforeHash: fingerprint(before),
      afterHash: fingerprint(content), status: 'proposed', createdAt: Date.now() };
    this.update(state => { state.proposals[item.id] = item; });
    return item;
  }

  async preview(id) {
    const item = this.snapshot().proposals[id];
    if (!item) fail('proposal_missing', '候选不存在');
    const path = await scopedPath(this.workspace, this.resolvePath(item.path));
    const current = await readFile(path, 'utf8');
    return { ...item, path, currentHash: fingerprint(current), stale: fingerprint(current) !== item.beforeHash,
      approvalHash: fingerprint({ id, before: item.beforeHash, after: item.afterHash }) };
  }

  async exportProposal(id, approvalHash) {
    const item = await this.preview(id);
    if (approvalHash !== item.approvalHash) fail('approval_changed', '候选确认指纹不一致');
    const path = `${item.path}.redmaple-candidate-${item.id}`;
    try { await writeFile(path, item.content, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST' || fingerprint(await readFile(path, 'utf8')) !== item.afterHash) throw error;
    }
    return this.update(state => {
      Object.assign(state.proposals[id], { exportedPath: path, exportedHash: item.afterHash });
      return state.proposals[id];
    });
  }

  async applyProposal(id, approvalHash, undo = false) {
    const item = await this.preview(id);
    const owner = await FileStore.open(dirname(item.path), `proposal-${fingerprint(item.path)}`, { recoverLock: this.recoverLock });
    try { return await this.applyOwnedProposal(id, approvalHash, undo); }
    finally { await owner.close(); }
  }

  async applyOwnedProposal(id, approvalHash, undo = false) {
    const item = await this.preview(id);
    const pending = undo ? 'undoing' : 'applying';
    const terminal = undo ? 'undone' : 'applied';
    const expected = undo ? item.afterHash : item.beforeHash;
    const resulting = undo ? item.beforeHash : item.afterHash;
    if (approvalHash !== item.approvalHash) fail('approval_changed', '候选确认指纹不一致');
    if (item.status === terminal && item.currentHash === resulting) return item;
    if (![undo ? 'applied' : 'proposed', pending].includes(item.status)) fail('invalid_transition', '候选不处于可应用状态');
    if (item.status === pending && ownerAlive(item.owner)) fail('proposal_busy', '候选仍有执行者，请等待处理结果');
    if (item.currentHash !== expected && !(item.status === pending && item.currentHash === resulting)) {
      fail('proposal_stale', '目标文件已变化，请重新生成候选');
    }
    const owner = { pid: process.pid, host: hostname(), token: randomUUID() };
    this.update(state => {
      const saved = state.proposals[id];
      if (saved.status !== item.status || saved.owner?.token !== item.owner?.token) fail('version_conflict', '候选正在被其他操作处理');
      Object.assign(saved, { status: pending, owner });
    });
    const temporary = `${item.path}.redmaple-${randomUUID()}.tmp`;
    try {
      // Recover a rename committed before the prior process stopped.
      if (item.status === pending && item.currentHash === resulting) {
        return this.update(state => { Object.assign(state.proposals[id], { status: terminal, owner: null }); return state.proposals[id]; });
      }
      await writeFile(temporary, undo ? item.before : item.content, { encoding: 'utf8', flag: 'wx' });
      if (fingerprint(await readFile(item.path, 'utf8')) !== expected) fail('proposal_stale', '写入前文件发生变化');
      await rename(temporary, item.path);
      return this.update(state => { Object.assign(state.proposals[id], { status: terminal, owner: null }); return state.proposals[id]; });
    } catch (error) {
      const hash = await readFile(item.path, 'utf8').then(fingerprint).catch(() => undefined);
      this.update(state => Object.assign(state.proposals[id], { owner: null,
        status: hash === resulting ? terminal : hash === expected ? undo ? 'applied' : 'proposed' : 'conflict' }));
      throw error;
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

}
