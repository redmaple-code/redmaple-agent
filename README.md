# 红枫 Red Maple Agent Base

基于 Pi 1.5.0 的通用 Agent 基座，提供红枫主题、枫叶 Logo、原生 TUI、SDK、JSON/RPC、MCP、Code Mode、持久任务与领域扩展。红枫层提供结构化验收、工作流恢复、来源知识和可评估的经验改进。需要 Node.js 22.19+，依赖与完整性固定在 package-lock.json。

## 红枫入口

```powershell
npm ci --ignore-scripts
node src/redmaple-cli.js
node src/redmaple-cli.js --config redmaple.config.json
node src/redmaple-cli.js --config redmaple.config.json -p "检查项目并核验结果"
node src/redmaple-cli.js --config redmaple.config.json --mode json "完成任务"
node src/redmaple-cli.js --config redmaple.config.json --mode rpc
npm test
```

`npm start` 打开 TUI。安装本包后可使用 `redmaple` 命令。配置默认放在 `~/.redmaple/agent`，`REDMAPLE_AGENT_DIR` 或配置 `agentDir` 可以指定位置。凭据通过环境变量、`/login` 或 `redmaple auth` 管理。模型可在 `/model` 切换，`redmaple --list-models` 查看目录。

TUI 保留 Pi 原生编辑器、快捷键、外部编辑器、主题切换、会话树、压缩、分支与恢复。使用 `/hotkeys`、`/settings`、`/tree`、`/fork`、`/resume`、`/new`、`/reload`。`--continue`、`--session`、`--fork`、`--session-dir`、`@file` 和图片附件沿用 Pi 参数。导出使用 `redmaple --export session.jsonl output.html`。`--help` 列出完整选项。

主题使用 `redmaple` 和 `redmaple-light`。Logo 位于 `assets/redmaple.svg` 和 `assets/redmaple.png`，终端图标与 SVG 共享枫叶轮廓。

首次 TUI 启动由 Pi 检查 fd 和 ripgrep，缺少时下载。网络受限时可用 `--offline` 跳过下载，文件发现和自动补全需要相应工具可用。`redmaple mcp` 管理 MCP 连接。`install`、`remove`、`update`、`list`、`config` 使用原生包管理，`/reload` 重载扩展、技能、主题和提示模板。

## 完整运行时 SDK

```javascript
import { createRedMapleRuntime } from '@paperpilot/agent-base';

const runtime = await createRedMapleRuntime({
  cwd: process.cwd(),
  model: 'openai/gpt-6-sol',
  apiKeyEnv: 'OPENAI_API_KEY',
  policy: { profile: 'workspace' },
});
try {
  await runtime.session.prompt('完成任务并验证结果');
  console.log(runtime.session.messages);
  console.log(runtime.redmaple.controls.ledger.snapshot().runs);
} finally {
  await runtime.dispose();
}
```

会话与分支由原生 SessionManager 管理。红枫 SQLite 账本记录调用意图、结果、预算、取消和未知结果。模型回答、压缩、Code Mode、图像/分类请求与子 Agent 共用发送控制。`runtime.redmaple.controls` 提供 `withRun`、`reconcile` 与账本读取。完整原生 SDK 通过 `@paperpilot/agent-base/pi` 导出。

原生压缩按下一次回复使用的模型窗口核算系统提示、工具定义、近期消息和输出预留。技能目录随系统上下文保留，正文通过读取或 `/skill:name` 按需加载，摘要提示保留技能名称和来源以便继续读取。工作区权限下，`read` 可读取资源加载器已登记的技能目录与目录内参考文件，真实路径检查会拦截越界链接。写入仍遵循工作区权限。

Code Mode 和工具搜索默认激活。红枫工具以 deferred 方式注册，模型通过 `tool_search` 加载，或在 Code Mode 中发现和调用，降低常驻工具描述量。`platformExposure: 'direct'` 可直接暴露，`tools`、`excludeTools` 和原生 `/tools` 可配置活动集合。

| 扩展 | 正常入口 |
|---|---|
| 来源记忆 | `redmaple_memory` 获取文件指纹、提交和检索，`/memory` 审阅批准。冲突替代、失效来源与工作区隔离持久化 |
| 计划与工作流 | `redmaple_plan` 创建依赖图、运行、核验、完成、失败和重试，`/plan` 批准与人工核验。完成绑定规则、步骤尝试、产物指纹及调用 |
| 来源知识 | `redmaple_knowledge` 导入、刷新、中文检索、删除、重建与评测，返回来源版本和行引用 |
| 决策与经验 | `redmaple_decision` 保存目标、评价、证据和下一步，`redmaple_evolution` 提炼与评估，`/evolution` 确认晋升或回滚 |
| 子 Agent 与角色流水线 | `redmaple_delegate` 的 tasks 并行执行，pipeline 顺序交接。角色由 config.roles 配置，子会话和结果持久化，默认最大深度 2 |
| 文件候选 | `redmaple_propose` 生成和预览，`/proposal ID` 应用，`/proposal ID undo` 撤销，`/proposal ID copy` 保存独立候选。核对指纹与协作写入锁 |
| 图像工作流 | 原生 read/附件用于视觉输入，`redmaple_image` 调用已登记图像模型生成/编辑，输入图片经过原生预处理 |
| 未知结果 | 文字回复或压缩中断后可直接重新提问，账本保留未知结果与用量记录。工具、图像等操作结果未知时，用 `/calls` 查看记录，核实后用 `/calls {"callKey":"...","result":{...}}` 登记。SDK 使用 controls.reconcile |

记忆、计划和候选的宿主接口位于 `@paperpilot/agent-base/platform`。它们的批准方法供明确的用户操作调用，模型工具只开放提出与执行状态操作。领域插件可通过 `extensionFactories` 注册原生工具、命令、UI 和生命周期钩子。

## 权限、费用与恢复

默认 `workspace` 策略限定原生文件工具的真实路径，Shell 和外部操作由 TUI/RPC 明确授权。`read-only`、`ask`、`trusted`、`sandbox` 可选，`allowTools` 可登记明确允许的外部工具。`trusted` 使用进程账户权限。

`sandbox` 的 Bash/PowerShell 工具与 TUI Shell 在 Docker Linux 容器内执行，网络关闭，限制 CPU、内存、进程与 capabilities。配置 `policy.dockerImage` 为已安装镜像，Bash 使用 sh，PowerShell 需要镜像中的 pwsh。扩展本身运行于可信 Node 宿主，扩展原生代码的权限由宿主控制。

`limits` 限定每轮模型调用、工具调用、token 和时间，子 Agent 共享父级上限。可配置 `money: { amount: 1, currency: 'USD' }`，以及 `pricing: { 'provider/model': { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 } }`，费率单位为 USD/百万 token。图像模型可登记每请求固定 `request` 费率，并填写 input/output 为 0。金额门禁按发送前预留和实际用量记账，未知结果须先核对，缺失用量保守记入预留。模型服务的最终账单以提供方为准。

费率支持 Pi 原生 `tiers` 阶梯计价，一小时缓存写入按 Pi 规则结算。预留覆盖输入范围内可能使用的费率与模型声明的长缓存费用。明确标记 `usage.cost.totalFromProvider: true` 的合法账单优先入账，按用量计算时使用发送时保存的费率，并清除旧的 `costEstimated` 标记。

SQLite 使用 WAL、同步落盘和单会话所有者校验。崩溃后的 pending 调用转为 unknown，阻止后续发送。核对外部结果后通过 native session 继续任务，原会话树保留。`recoverLock: true` 只允许接管本机已停止的进程。

## 长历史与停止处理

默认红枫入口和兼容 SDK 共用容量检查与摘要输入缩减逻辑。实现参考 [Codex 公开客户端的容量回退](https://github.com/openai/codex/blob/75fc67e8f4284a669eebd90ab6bc9ef7697e876e/codex-rs/core/src/compact.rs#L362) 和 [工具输出缩减](https://github.com/openai/codex/blob/75fc67e8f4284a669eebd90ab6bc9ef7697e876e/codex-rs/core/src/compact_remote_history.rs)。接近容量时触发压缩，摘要请求预留输出空间。输入仍然超限时，先缩短较大的工具输出，再逐步移除较早的记录。服务端明确返回容量不足时也会缩减后重试，各次请求共用原任务预算。

摘要会标出输入缩减范围，完整原始历史由会话管理器或存储保留。兼容 SDK 使用前次摘要和新增历史递进压缩，摘要通过容量检查后才写缓存。默认入口保留 Pi 的会话格式、扩展覆盖、模型路由、认证和压缩事件，通过锁定的 Pi 1.5.0 摘要适配接入。必要指令和当前保留内容本身超过容量时返回明确错误。

停止会终止本地模型等待并拦截迟到增量。已发送且缺少终态回执的调用记为 `unknown`，保留预算预留，通过 `/calls` 或 SDK 核对后继续。提供方对生成和费用的最终处理以其回执为准。

兼容文件工具 `write`、`edit` 均可省略 `expected_hash`。编辑使用唯一原文匹配，写入时核对执行过程中的文件变化。旧哈希参数和旧会话身份继续兼容。读取片段、命令非零退出、超时和输出截断会写入模型可见正文。

## 持久任务与领域接入

`@paperpilot/agent-base/durable` 导出原生 Harness、任务、文档、注册表及存储接口。`openRedMapleHarness({file, models, extensions})` 提供 SQLite，`directory` 可选择 JSONL。使用完整运行时的 modelRuntime 时，在 `controls.withRun('durable', async () => {...})` 内提交并等待任务，使调用进入共享控制。Harness 自有任务/文档状态与原生 TUI 会话分别持久化。

配置 `paperpilot: { baseUrl: 'http://127.0.0.1:8872', projectId: '论文编号', conversationId: '会话编号' }` 启用 `paperpilot_read`、`paperpilot_propose` 和 `/paperpilot ID`。通过现有 API 连接论文工作区、记忆、可审阅业务候选及 scholar-apprentice 研究知识/路线/合同状态。业务应用沿用宿主来源授权、版本、预览指纹和幂等事务。领域历史恢复由相应宿主流程处理。

## 可恢复工作流与验收

在已创建的完整运行时中，通过下列函数运行一个由宿主用户确认的任务。

```javascript
async function runApprovedTask(runtime) {
  const state = await runtime.redmaple.openPlatform();
  let plan = state.createWorkflow({
    title: '生成 summary.md',
    steps: [{
      id: 'write', title: '在 summary.md 中写出结论',
      execution: { role: 'implementer', prompt: '生成包含结论的 summary.md' },
      acceptanceSpec: [{ kind: 'file', path: 'summary.md', contains: '结论' }],
    }],
  });
  plan = state.transitionWorkflow(plan.id, plan.version, 'approve', { human: true });
  const runner = await runtime.redmaple.openWorkflowRunner();
  return (await runner.run(plan.id)).state.outcome;
}
```

验收规则包括 `file`、绑定实际步骤的 `call`、`manual` 和注册的 `custom`。自定义验收通过 `verifiers: { name: { version, verify } }` 配置，规则声明 `artifactPaths`，验收前后与完成时核对输入指纹。评估器返回 `{verdict:'pass', proof}`，失败或不确定结果保留诊断。人工规则通过 `/plan {"id":"...","stepId":"...","action":"verify","evidence":"..."}` 确认，随后完成步骤。必交步骤需要通过验收，`optional:true` 的步骤可由用户跳过。

角色流水线可表示为工作流步骤的 `execution` 与 `dependsOn`，由 durable 调度器保存执行位置、子会话、操作标识和回执。兼容的 `redmaple_delegate` 提供单轮并行或 pipeline 委派。SDK 的 `@paperpilot/agent-base/workflows` 导出 `openWorkflowRunner`，宿主可提供 `executeStep` 和 `reconcileStep`。已发送而结果不明的操作先核对，重开使用原任务身份与预算。`recoverLock:true` 可恢复已停止进程的锁，当前根会话一次运行一个受管工作流，相同运行请求复用结果。

## 知识库与经验改进

```javascript
const state = await runtime.redmaple.openPlatform();
const imported = await state.knowledge.importFile('notes.md');
const found = await state.knowledge.search('知识', { limit: 8 });
const memory = await state.remember({
  key: '研究约束', text: '引用原始资料', sources: [imported.reference],
});
// 宿主审阅后调用 state.decideMemory(memory.id, true)。
console.log(found.items.map(item => item.citation));
```

基础导入支持工作区 UTF-8 文本，默认单来源上限 4 MiB、分块 2000 字符，可由 `knowledge.maxSourceBytes` 和 `knowledge.chunkSize` 调整。PDF/OCR、网页和领域来源通过宿主提取或连接器提供文本。索引组合 FTS5 trigram、中文一字/两字词项和可配置 `knowledge.aliases`，正文与引用保留原文。检索分页返回，候选集合截断时返回 `truncated` 与 `totalIsExact`。`knowledge.evaluate(cases)` 记录 Recall@k、MRR、无答案误召回与耗时，工具评测读取宿主配置的 `knowledge.evaluationCases`。

来源刷新保留版本，删除清理分块及索引，并失效相关批准记忆。`state.backupTo(file)` 产生包含已提交 WAL 内容的一致性备份，`state.health()` 检查 schema、外键和同步配置。旧 JSON 平台库首次迁移前自动备份，旧表改为只读历史视图，旧客户端写入获得错误。

工作区身份见 `state.key`。恢复备份到新位置时，使用 `PlatformState.open(file, newWorkspace, {workspaceId})`，或运行时配置 `workspaceId`，显式保持身份与历史路径映射。旧格式仅有路径指纹时可补 `previousWorkspace`，历史文件引用仍核对实际内容。

`state.evolution` 提供 `propose`、`extract`、`evaluate`、`activate` 和 `rollback`。候选来自已完成步骤的有效核验，自动提炼读取决策记录。配对评估绑定候选 hash、基准、数据集、评估器及检查点。退化、无改进、证据失效和超出配置费用的候选保持待审状态。启用需要人工或宿主预授权的 `activationPolicy`，并比较活动指针版本。运行记录固定其启用版本，后续新运行读取新指针。

SDK 配置 `evolution: { evaluate, evaluatorId, datasetVersion, minCases, maxCost, autoEvaluate }`。`evaluate({candidate, baseline, operationId, checkpoint, previous, signal})` 返回 `cases`，每项包含 `id`、`candidate:{pass,cost}`、`baseline:{pass,cost}`。评估器与真实任务集由宿主控制，模型调用使用受管 ModelRuntime 计量。CLI 可配置 `evolution.evaluatorModule`，模块导出 `evaluate`、`evaluatorId` 和 `datasetVersion`。`autoEvaluate:true` 启用每轮结束后的有界自动评估，默认每批一项。真实收益依据宿主任务评测结果记录。

`/evolution {"id":"候选ID"}` 审阅并启用已评估候选，`/evolution {"action":"rollback","id":"活动指针ID","expectedVersion":1,"reason":"复核"}` 回滚。启用策略与评估配置由宿主提供。

普通文件覆盖使用指纹和合作写入锁。独立候选保存使用排他新建文件，保留外部编辑。版本化宿主文档沿用宿主 CAS 事务。`REDMAPLE_TRACE_FILE` 指定诊断 JSONL，记录启动、ready、代理结束、stdin 结束、释放及资源时序，字段仅包含阶段和控制标识。

真实第三方 OAuth、生产模型的语义质量、图像生成费用和远程 MCP 需要相应账户与服务环境验证。本地测试覆盖协议、控制和隔离行为，具体矩阵见工程包 AGENT-BASE/v2。

## 兼容 SDK 与 CLI

下列 `createAgentBase`、`agent-base` 命令和 `example.config.json` 保留 v0.1 接口，适用于显式装配的嵌入场景。`npm run start:legacy` 启动兼容命令行。

## 功能边界

| 层次 | 能力 |
|---|---|
| 核心 | Pi 多轮工具循环、schema 校验、文本和工具事件、串并行、取消、steering/follow-up |
| 可靠性 | 持久会话、单写者锁、请求幂等、调用意图与结果记录、未知结果对账、显式续跑、调用/token/时间预算 |
| 上下文 | 完整历史保留、按完整工具交换压缩模型投影、原始任务保留、摘要共享调用预算、容量拒绝 |
| 可选模块 | 工作区 read/write/edit/exec、AGENTS.md、技能目录和支持文件按需加载 |
| 扩展 | 普通 Pi AgentTool、插件生命周期、自定义 StreamFn、请求与工具钩子、提供方容量下的工具发现与加载 |

完整运行时的 TUI、主题、Code Mode、图像、会话树、多 Agent 和 MCP 使用上面的红枫入口。兼容 SDK 使用显式插件装配。

## 安装与启动

在本目录运行以下命令。修改配置示例中的模型 ID、端点和真实容量，凭据从进程环境读取。

```powershell
npm ci --ignore-scripts
$env:OPENAI_API_KEY = "your-key"
node src/cli.js --config example.config.json --workspace "F:\my-workspace" --session demo --prompt "检查项目并总结下一步"
npm test
```

`--json` 输出逐行事件和最终结果，`--request-id` 指定幂等请求编号，`--resume` 显式续跑。`--help` 显示入口。默认会话目录为工作区 `.agent-base`，可用配置 `sessionsDirectory` 指定其他位置。会话文件包含完整消息和工具结果，工作目录与会话目录均由宿主选择。

`workspaceTools: false` 可创建纯业务工具基座。`skillDirectories` 可指定技能目录列表，默认使用工作区 `.agents/skills`。技能元数据进入提示，正文和支持文件通过 `load_skill` 读取。AGENTS.md 按显式工作区到当前目录的层级加载。

工作工具的文件路径按真实路径核对工作区归属。exec 使用明确的程序和参数数组，以启动进程的账户权限执行。进程隔离与外部服务权限由宿主提供。

## SDK

```javascript
import {
  createAgentBase, FileStore, createWorkspaceTools,
  createResourcesPlugin, createOpenAIModel, createOpenAITransport,
} from './src/index.js';

const workspace = process.cwd();
const model = createOpenAIModel({
  id: process.env.AGENT_BASE_MODEL,
  baseUrl: process.env.AGENT_BASE_URL || 'https://api.openai.com/v1',
  contextWindow: 32768,
  maxTokens: 2048,
});
const base = await createAgentBase({
  model,
  streamFn: createOpenAITransport({ getApiKey: () => process.env.OPENAI_API_KEY }),
  store: await FileStore.open('./sessions', 'session-1'),
  tools: await createWorkspaceTools({ workspace }),
  plugins: [await createResourcesPlugin({ workspace })],
});

base.subscribe(event => {
  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  const run = base.prompt('完成任务并核对结果', { requestId: 'task-001' });
  // 有运行中的任务时，宿主可调用 base.steer(text)、base.followUp(text) 或 base.abort()。
  const result = await run;
  console.log(result.status, result.usage);
} finally {
  await base.close();
}
```

`createAgentBase` 接受普通 `tools` 和 `plugins`。插件结构包含稳定的 `id`、`version`、可选的 `tools`、`systemPrompt`、`attach(base)`、`dispose()`。工具沿用 Pi 的 name、label、description、parameters、execute 和 executionMode。

```javascript
const plugin = {
  id: 'domain-proposals',
  version: '1',
  tools: [{
    name: 'propose_change',
    label: 'Create proposal',
    description: 'Create a reviewable domain proposal.',
    version: '1',
    executionMode: 'sequential',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    execute: async (callId, arguments_, signal) => {
      const proposal = await host.propose(callId, arguments_.text, signal);
      return { content: [{ type: 'text', text: proposal.summary }], details: proposal };
    },
  }],
};
```

工具数量超过 `maxTools` 时，初始暴露 search_tools 与 load_tools，后续按任务加载实际工具集合。两个发现工具持续保留，加载容量计入上限。搜索结果最多显示 20 项，并提供总数与截断标记。工具清单和版本在会话期间保持稳定，宿主通过 `setActiveTools(names)` 选择活动集合。

## 宿主接口

| 入口 | 用途 |
|---|---|
| `streamFn(model, context, options)` | 自定义模型传输，`options.hostContext` 提供 runId、callKey、purpose，便于宿主关联调用账本 |
| `beforeModelCall({model, context, call}, signal)` | 覆盖回答、压缩及工具内模型调用的统一发送前门禁 |
| `base.modelStream(model, context, options, purpose)` | 工具与插件使用同一调用记录和预算调用模型，返回 Pi 标准事件流 |
| `prepareRequest(request, signal)` | 发送前核对目标、权限、配置版本及材料，沿用 Pi 返回契约 |
| `beforeToolCall(context, signal)` | 基于已校验参数执行宿主策略，可返回 block 与 reason |
| `afterToolCall(context, signal)` | 转换工具结果或附加可审阅信息 |
| `finishTurn(turn, signal)` | 宿主完成判定，返回 end 或 continue，默认使用 Pi 正常循环 |
| `transformContext(messages, signal)` | 在压缩策略之后注入或转换模型上下文 |
| `prepareNextTurn(turn, signal)` | 在下一轮更新上下文、模型或推理档位 |
| `convertToLlm(messages)` | 将自定义应用消息映射为模型消息 |

论文审批、来源记忆、模型凭据与金额规则可以沿用现有 Python 服务。外部副作用通过受记录的工具或模型传输执行，生命周期钩子中的持久写入由宿主以 callKey 或 toolCallId 保持幂等。自定义传输与工具需要协作处理 AbortSignal。其他 Pi 提供方可按需导入并作为 streamFn 传入，宿主应明确处理每一次实际重试的记录与预算，附带的 OpenAI 适配关闭自动重试。

## 恢复与预算

每次外部调用先保存 pending 意图，获得结果后保存已知结果，再发布最终消息。进程中断后 pending 变成 unknown。unknown 结果由用户或宿主核对后通过 `reconcile(callKey, verifiedPiResult)` 登记，再调用 `resume(requestId)`。已记录的工具结果按原调用编号复用。

默认运行时的图像和分类调用使用相同的取消与预算控制，核对时可直接提交 Pi 原生的 `output` 或 `answers` 结果。核对操作保留原生会话历史，并追加核对记录。

工具主动返回 `isError: true` 表示已知错误结果。执行途中抛出异常默认按未知副作用处理。`replay: 'safe'` 的只读工具异常记录为已知失败，自动重试由宿主明确发起。宿主确认请求尚未发送时，可抛出 `new AgentBaseError(code, message, { knownOutcome: true })`。工具已发生的结果以对账事实为准。

正常关闭会释放文件锁。确认原进程已终止后，可用 `FileStore.open(directory, id, { recoverLock: true })` 或 CLI `--recover-lock` 恢复锁。其他主机的拥有者按活动状态保守处理。文件存储支持本机单写者会话，跨主机持久化可通过实现相同的 snapshot/update/close 接口替换。

limits 可配置 modelCalls、toolCalls、tokens、seconds。摘要调用与回答共用预算，时间预算上限受 Node 定时器范围约束。默认 token 估计使用完整 JSON 的 UTF-8 字节数，宿主可传入 `estimateTokens` 提供模型或多模态估算。模型上限依据配置进行核对，生产容量来源由宿主维护。

单次请求的输出预留采用本次有效 `maxTokens`，并校验其为正整数。金额控制固定保存发送时的费率。已发送但结果未知、或成功响应缺少完整用量时，费用保留预估值，缺少用量的结果标记 `usage.costEstimated`。后续可用核实的用量或费用更新记录。发送前取消会释放 token 和费用预留。

context 默认在配置容量的保守阈值触发摘要投影，可配置 maxInputTokens、keepRecentExchanges，或设为 false。会话快照保留完整历史，摘要结果独立缓存。近期窗口会根据容量收缩至一个完整交换，必需任务及当前交换本身超限时返回 context_overflow。摘要内容的语义保真仍需真实模型任务验证。

结果状态包含 succeeded、failed、blocked、cancelled、truncated。usage 记录模型、工具、token 与费用估计，elapsedMs 记录累计执行时间。调用前后保存时间检查点，恢复采用最近持久记录。`costKnown` 默认 false，金额规则和真实费率由宿主负责。工具处理逻辑、钩子或授权策略改变时，升级工具/插件 version 或 profileVersion，旧身份会话将提示新建。

## JSONL 进程协议

```powershell
node src/cli.js --config example.config.json --rpc
```

每行发送一个对象，id 使用字符串。prompt/resume 会异步执行，输入流可继续接收 steer、followUp、cancel、snapshot 和 reconcile。输入流结束后等待已接收请求结算并关闭会话。

```json
{"id":"task-1","method":"prompt","params":{"input":"完成任务"}}
{"id":"steer-1","method":"steer","params":{"input":"先检查测试失败原因"}}
{"id":"follow-1","method":"followUp","params":{"input":"结束后总结改动"}}
{"id":"cancel-1","method":"cancel"}
```

响应为带相同 id 的 ok/result 或 error。事件使用 `type: "event"`，原始 Pi 事件位于 event 字段。snapshot 返回持久状态，可用于宿主恢复与研究阶段 UI 投影。

## 交付状态

本模块已经过真实 Pi 运行时、确定性模型流、真实文件与子进程、本地 HTTP/SSE、CLI/RPC 和进程强杀恢复测试。当前以独立基座交付，现有论文应用的生产接入、现网提供方兼容和真实模型质量验证属于后续集成范围。

Pi 上游采用 MIT 许可，依赖版本和完整性记录在 package-lock.json。安装、完整测试命令、功能覆盖和实际结果见 [测试说明](docs/TESTING.md)。
