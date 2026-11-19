import { AgentBaseError, textResult } from './shared.js';

export class PaperPilotBridge {
  constructor({ baseUrl = 'http://127.0.0.1:8872', projectId, conversationId = '', headers = {}, fetch: transport = fetch }) {
    if (!projectId) throw new AgentBaseError('project_required', 'PaperPilot 接入需要论文编号');
    this.base = new URL(`/api/projects/${encodeURIComponent(projectId)}/agent/`, baseUrl);
    this.conversationId = conversationId;
    this.headers = headers;
    this.transport = transport;
  }

  async request(path, data, signal) {
    const response = await this.transport(new URL(path, this.base), { method: data === undefined ? 'GET' : 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data), signal });
    const result = await response.json();
    if (!response.ok) throw new AgentBaseError(result.detail?.code || 'paperpilot_request_failed',
      result.detail?.message || `PaperPilot HTTP ${response.status}`, { knownOutcome: response.status < 500 });
    return result;
  }

  read(kind, signal) {
    const paths = { workspace: 'workspace', research: 'research', memories: 'memories', conversations: 'conversations',
      actions: `actions?conversation_id=${encodeURIComponent(this.conversationId)}` };
    if (!paths[kind]) throw new AgentBaseError('invalid_operation', '未登记的论文读取操作', { knownOutcome: true });
    return this.request(paths[kind], undefined, signal);
  }

  propose(data, signal) {
    return this.request('actions', { ...data, conversation_id: this.conversationId, run_id: '' }, signal);
  }

  preview(id, selection = {}, signal) { return this.request(`actions/${encodeURIComponent(id)}/preview`, selection, signal); }

  apply(id, data, signal) { return this.request(`actions/${encodeURIComponent(id)}/apply`, data, signal); }
  reject(id, signal) { return this.request(`actions/${encodeURIComponent(id)}/reject`, {}, signal); }
}

export function paperpilotExtension(config) {
  const bridge = new PaperPilotBridge(config);
  return pi => {
    pi.registerTool({ name: 'paperpilot_read', label: '论文与学徒工作区',
      description: '通过现有 PaperPilot API 读取当前论文的对话、记忆、候选、工作区和 scholar-apprentice 原生研究状态。',
      annotations: { readOnlyHint: true },
      parameters: { type: 'object', properties: { kind: { type: 'string',
        enum: ['workspace', 'research', 'memories', 'conversations', 'actions'] } }, required: ['kind'], additionalProperties: false },
      async execute(_, args, signal) { const data = await bridge.read(args.kind, signal); return textResult(JSON.stringify(data), data); } });
    pi.registerTool({ name: 'paperpilot_propose', label: '论文业务候选',
      description: '创建论文业务候选。沿用宿主版本检查、来源授权、幂等及研究候选流程。用户通过 /paperpilot 预览和应用。',
      parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['outline', 'logic', 'term', 'corpus', 'reference', 'oa', 'research'] },
        request_id: { type: 'string' }, base_version: { type: 'integer' }, payload: { type: 'object' },
        source_refs: { type: 'array', items: { type: 'object' } } }, required: ['operation', 'request_id', 'base_version', 'payload'], additionalProperties: false },
      async execute(_, args, signal) { const data = await bridge.propose(args, signal); return textResult(JSON.stringify(data), data); } });
    pi.registerCommand('paperpilot', { description: '预览并明确应用论文候选，参数为候选编号', async handler(args, context) {
      const id = args.trim();
      if (!id) { context.ui.notify('请提供候选编号', 'warning'); return; }
      const preview = await bridge.preview(id);
      if (!await context.ui.confirm('应用论文候选', JSON.stringify(preview, null, 2))) return;
      const { randomUUID } = await import('node:crypto');
      const data = await bridge.apply(id, { request_id: randomUUID(), accepted: true,
        expected_version: preview.base_version, action_fingerprint: preview.action_fingerprint });
      context.ui.notify(`已应用 ${data.action_id}`, 'info');
    } });
  };
}
