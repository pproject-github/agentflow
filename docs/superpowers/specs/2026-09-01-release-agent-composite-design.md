# Release Agent Composite Workflow Design

## 背景

当前发版复合节点由 `shared/release-workflow-config.js` 声明多个原子 Action，再由
`bin/lib/release-runtime-executor.mjs` 展开成多个 `tool_nodejs` 节点。该实现重复维护了
release-skills 的流程语义，导致 Skill 更新后还需要同步修改 AgentFlow 执行器。

本设计将复合发版节点改为单个 AgentFlow `agent_subAgent` 节点。Agent 根据当前发版上下文、
能力目标和最新 `release-*` Skill 自主编排原子动作，执行器只负责启动 Agent、传递上下文、
收集结构化结果和持久化运行记录。

## 目标

- 首包和补包使用同一套 Likee Android 状态机。
- 复合节点不再硬编码原子 Action 顺序，也不再展开多语言文件列表。
- Agent 默认可以读取当前 Skill 根目录下全部 `release-*` Skill。
- 状态机只限制可用的业务能力集合、作用域和阶段转移。
- 放量和全量之后都可以创建新的补包批次并循环执行。
- 输入、输出、记录、产物、等待、失败和取消均可审计。

## 非目标

- 不在 AgentFlow 中重新实现 release-skills 的 Git、Crowdin、Jenkins、审核、通知或指标逻辑。
- 不让 Agent 绕过 Skill 中的确认、预检、安全边界和凭据规则。
- 不在当前阶段自动补齐外部 Skill 尚未提供的商店发布能力。

## 核心架构

### 配置层

状态机配置只声明能力节点，不声明原子 Action 图：

```js
{
  id: "localization-upload-notify",
  title: "多语言上传 & 通知",
  description: "上传当前平台全部受审源多语言并发送通知。",
  businessLines: ["likee"],
  platforms: ["android"],
  batches: ["initial", "supplemental"],
  stageId: "localization",
  skillHints: ["release-localization", "release-notification"],
  inputs: [
    { key: "source_path", type: "text", required: false }
  ],
  promptTemplate: "..."
}
```

`skillHints` 只用于提示 Agent 优先关注的 Skill，不限制 Skill 读取范围。Agent 默认可以读取
当前 Skill 根目录下所有 `release-*` Skill；实际可执行范围仍由 Skill 自身的预检和安全策略决定。

### 执行层

每个复合能力只物化为一个 AgentFlow 节点：

```text
release context + user inputs + upstream records
                         ↓
                 agent_subAgent
                         ↓
              structured release result
```

Agent prompt 必须包含：

- businessLine、platform、version、batch、batchIndex；
- 当前工程根目录和 Skill 根目录；
- 当前能力目标及状态机阶段；
- 用户输入和上游成功节点产物；
- 优先关注的 Skill 名称；
- 实际执行、遵循 Skill 确认和预检、禁止伪造结果的要求；
- 统一结构化结果协议。

执行器不得根据 `skillHints` 生成工具节点，不得读取 `sourceFiles` 后进行扇出，不得传递
硬编码的原子 Action 顺序。

### 结果协议

Agent 必须返回可解析的结构化结果：

```json
{
  "status": "completed | waiting | failed",
  "summary": "...",
  "steps": [
    {
      "skill": "release-localization",
      "action": "upload-source-file",
      "status": "completed",
      "inputs": {"source_path": "..."},
      "outputs": {"record_id": "..."}
    }
  ],
  "records": [],
  "artifacts": [],
  "waiting": {"reason": "", "confirmation": null},
  "next_action": ""
}
```

`status=waiting` 表示 Skill 要求人工确认、外部 MR/Jenkins/商店状态或补充输入；不标记为成功，
也不自动跨阶段。`status=failed` 展示 Agent 或 Skill 返回的脱敏失败原因，可重新执行。Agent
实际产生的文件由现有 Workspace output protocol 持久化，`records` 和 `artifacts` 写入发版运行记录。

### 状态机与批次

Likee Android 首包和补包共用 `likee-android-release`：

```text
初始化
  → 多语言上传 & 通知
  → 创建/复用发版分支
  → 多语言下载 & 合并代码 & 提交 MR & 通知
  → 发版分支合回 master
  → 构建包
  → 提审单
  → 首包/补包发布 & 通知
  → 放量
  → 全量
```

每个阶段依据 `batch` 和当前产物决定是否启用。`initial` 和 `supplemental` 不是两份状态机，
而是同一状态机的两种上下文。

放量和全量均可产生新的补包批次：

```text
放量/全量
   └─ create_supplemental_batch
         → 补包通知
         → 构建包
         → 提审单
         → 补包发布 & 通知
         → 放量
         → 全量
         └─ create_supplemental_batch ...
```

每个补包批次拥有独立的批次 ID、阶段实例、输入、Agent run、记录和产物；共享版本和已登记
release 分支。历史批次节点只读，新批次生成新的待执行节点。

### Likee Android 能力集合

状态机及自定义添加阶段只暴露以下能力：

1. 多语言上传 & 通知
2. 创建/复用发版分支
3. 多语言下载 & 合并代码 & 提交 MR & 通知
4. 发版分支合回 master
5. 构建包
6. 提审单
7. 首包/补包发布 & 通知
8. 补包通知
9. 放量
10. 全量

能力节点的推荐 prompt 从对应 Skill 的名称、描述、输入契约和当前状态机上下文生成；具体
动作顺序由 Agent 阅读最新 Skill 后决定。

当前 release-skills 目录没有独立的商店发布 Skill。首包/补包发布节点必须在 prompt 中检查
发布能力是否存在；缺少时返回 `waiting` 或 `failed`，不得将构建完成或审核完成伪装成发布成功。

## 交互与记录

- 点击执行只启动一个 Agent run，节点显示真实运行状态和 Agent 流式日志。
- Agent 返回等待状态时，节点保留待处理状态，详情弹框展示等待原因、确认信息和下一步。
- 失败节点展示脱敏原因并允许重试；正在运行的节点允许取消，取消结果写入运行记录。
- 已完成节点不可编辑，只读展示 prompt、Skill 读取记录、steps、records、artifacts 和日志。
- 待执行、失败和等待节点可编辑输入并重新运行。
- 自定义添加阶段只能从当前 `businessLine + platform + batch` 的能力集合中选择，可重复添加同一能力，
  每次生成新的阶段实例。

## 安全与一致性

- Agent 只能在当前工程和 Skill 根目录范围内工作；凭据继续由 Skill 从既有环境读取。
- Agent prompt 不携带 Token、Webhook 或其他秘密。
- 运行记录只保存脱敏的输入摘要、记录 ID、产物相对路径和 Agent 结果。
- 状态机负责作用域校验和阶段转移，Skill 负责领域预检、确认、幂等、恢复和外部写入。

## 验证标准

- 复合节点 graph 中只有一个 `agent_subAgent`，不再出现 `composite_upload_*` 或其他原子工具实例。
- 多语言上传的文件数量由 Agent 读取的当前 Skill profile 决定；更新 profile 后无需修改 AgentFlow 代码。
- 首包和补包在同一状态机中按 `batch` 正确显示能力集合。
- 从放量、全量创建补包后，新批次可以独立执行并保留历史批次记录。
- Agent 结构化 completed/waiting/failed 结果均能正确映射到页面节点状态和发版记录。
