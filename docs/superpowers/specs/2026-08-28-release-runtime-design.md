# 发版 Skill AgentFlow 运行与节点详情设计

## 背景与目标

当前发版页将节点定义写在前端，并使用短计时器模拟执行。`release-skills` 已经把发版能力定义为多个 Skill Action，且 Android/iOS 以及 Google Play 分支存在不同动作、输入和确认边界。本次改造将这些 Action 作为真实 AgentFlow 可运行节点，保留现有发版时间线和自定义补充流程，同时为节点提供与 Workspace 一致的查看/编辑体验。

## 现状核对

- `release-skills/main` 提供 approval、git、localization、metrics、gray-observe、records、notification、channel-packages、release-notes 等 Skill。
- `release-skills-google-play-aab/feat/google-play-aab-submission` 额外提供 `release-google-play`，包含 `preview-aab-submission`、`submit-aab-internal-testing`、`list-tracks`。
- Action 的机器可读来源是各 Skill `SKILL.md` 的 YAML frontmatter；不能继续用“一个 Skill 一个节点”的静态目录代替。
- Skill 脚本要求使用各自 `scripts/run.py`，并且带确认的外部写操作必须先预览、再用确认指纹执行。

## 总体方案

### 1. Action 驱动的节点目录

新增共享的 release catalog loader，读取当前 release-skills 根目录及可选扩展目录，解析每个 `SKILL.md` frontmatter：

```js
{
  id: "release-google-play:submit-aab-internal-testing",
  skill: "release-google-play",
  action: "submit-aab-internal-testing",
  title,
  description,
  category,
  businessLines,
  platforms,
  allowedBatches,
  requiresConfirmation,
  inputSchema,
  source: { skillRoot, skillPath, scriptPath },
  nextNodeIds: []
}
```

节点通过业务线、平台和当前发版批次筛选。缺少业务线专属配置时使用共享定义，但始终保留 `businessLines` 字段和映射入口。Android/iOS 的差异由 frontmatter 的 `platforms`、`release_context` 和 Action 输入决定；Google Play Action 只在 Android 且启用扩展 Skill 根目录时出现。

`release-initialization` 仍是不可编辑的首个上下文节点，携带业务线、平台、版本、工作区路径和批次快照。

### 2. AgentFlow 真实运行适配器

后端新增 Release Runtime API，负责目录发现、节点详情、执行和状态查询。每次节点执行创建一个隔离的 AgentFlow workspace run graph：

1. `tool_nodejs` 节点接收当前发版上下文和用户编辑的 Action 输入。
2. 节点脚本调用对应 Skill 的 `scripts/run.py --action <action>`，工作目录固定为 release-skills 工程根目录。
3. 脚本 stdout/stderr、确认预览、确认指纹、输出和退出状态写入 AgentFlow run log；凭据、绝对路径和敏感值按现有脱敏规则处理。
4. AgentFlow 返回 `runId`、节点状态、输出和日志；前端通过流式事件或状态接口更新呼吸态、进度、失败原因和取消状态。

`requiresConfirmation: false` 的 Action 点击执行即运行；`true` 的 Action 第一次点击只生成预览，弹框展示预览和确认指纹，二次确认后才真实执行。确认指纹只对当前节点、当前输入和当前上下文有效。

取消通过 AgentFlow run stop API 终止活动子进程；结果未知时保留“结果未知”记录，不自动重试。失败节点留在待执行区，可编辑输入后重试。

### 3. 发版状态持久化

发版状态从浏览器 `localStorage` 迁移为服务端/工作区运行态存储，键由 workspace、businessLine、platform、version、batch 组成。保留兼容读取旧 localStorage 数据的迁移逻辑，避免已有时间线丢失。状态至少包含：

```js
{
  context,
  timeline: [{ itemId, nodeId, runId, status, inputs, operator, startedAt, completedAt, durationMs, outputSummary }],
  pending: [{ itemId, nodeId, status, inputs, runId, error, preview, operator }],
  customNodes: [{ id, sourcePresetId, inputs }]
}
```

时间线中的已完成节点不可修改或再次执行；执行中节点可取消；失败节点可编辑并重复执行；自定义节点允许从全部当前可用 Action 中重复选择。

### 4. 节点详情弹框

新增 Release Node Inspector，视觉和布局复用 Workspace/Subflow Preview 的节点详情风格：

- 已完成节点：展示真实 definition、Action、输入、输出摘要、运行日志、runId、操作人、开始/完成时间、耗时；所有输入、脚本和执行按钮只读。
- 待执行节点：展示同样的信息；输入表单可编辑，支持保存、预览、执行；未执行节点可查看节点定义和前置条件。
- 失败节点：额外展示红色错误原因、最近一次 runId 和重试入口。
- 支持最大化/退出最大化、Escape 关闭、滚动日志和复制输出；弹框不会改变已完成时间线。

### 5. 时间线与推理

完成真实 AgentFlow run 后，服务端将该 Action 追加到当前版本时间线，并依据节点的 `nextNodeIds` 以及 Action 输出推理一个或多个待执行节点。推理结果去重，但用户自定义添加不去重，允许同一预置 Action 多次加入。已完成组和待执行组沿用当前科技感上下布局与连接线样式。

## API 草案

- `GET /api/release/catalog?workspaceId=...&businessLine=...&platform=...&batch=...`
- `GET /api/release/state?...`
- `POST /api/release/nodes/preview`
- `POST /api/release/nodes/run`
- `POST /api/release/runs/stop`
- `GET /api/release/runs/:runId`
- `GET /api/release/runs/:runId/logs`
- `PATCH /api/release/pending/:itemId`

所有接口使用当前 AgentFlow 登录态和 workspace 权限；外部写操作的确认指纹必须在服务端再次校验。

## 错误处理与安全边界

- release-skills 目录不存在、frontmatter 无法解析或 Action 缺少脚本时，节点标记为不可运行并在详情中说明原因。
- Skill 进程非零退出、超时、取消和外部结果未知分别记录，不能伪装为成功。
- 不把 OAuth/Jenkins/GitLab/Google 凭据写入节点状态、日志、前端 payload 或命令行可见文本。
- 不允许节点脚本通过输入覆盖工作目录、执行记录根目录或任意命令；脚本路径必须由已发现的 Skill 目录映射得到。
- 仅已完成节点只读；待执行和失败节点编辑只影响该节点实例输入，不修改 Skill 源文件。

## 测试策略

1. frontmatter loader：Action 拆分、平台/批次过滤、Google Play 扩展、业务线预留字段。
2. AgentFlow adapter：真实脚本命令构造、输入传递、预览/确认指纹、日志解析、退出失败和取消。
3. Release API：权限、状态持久化、运行状态更新、重复执行、结果未知和旧 localStorage 迁移。
4. React contract：已完成只读、待执行可编辑、弹框最大化、真实 runId/log 展示、确认二次操作。
5. 回归验证：发版相关 Node 测试、Web UI lint、生产 build、`git diff --check`。
