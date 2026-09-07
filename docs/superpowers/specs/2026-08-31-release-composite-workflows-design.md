# 发版复合流程设计

## 目标

在现有按 `skill:action` 编排的发版状态机上增加复合节点。复合节点在时间线上仍表现为一个可执行节点，但内部由多个 release-skill 原子 Action 按顺序组成，并通过 AgentFlow 图真实执行。默认推荐复合节点，原子节点仅作为显式补救能力。

## 配置模型

复合流程与业务线、平台、批次状态机保存在同一份 `shared/release-workflow-config.js`：

```js
{
  id: "localization-upload-notify",
  title: "多语言上传 & 通知",
  description: "上传源多语言文件，成功后发送多语言上传通知。",
  businessLines: ["likee"],
  platforms: ["android", "ios"],
  batches: ["initial", "supplemental"],
  actions: [
    { id: "release-localization:upload-source-file", continueOn: ["completed"] },
    { id: "release-notification:send-notification", inputs: { event: "localization-uploaded" } }
  ],
  default: true
}
```

`actions` 是唯一的内部执行顺序；复合节点自身使用 `composite:<id>` 作为节点身份。配置选择同时决定状态机阶段、默认推荐、自定义阶段候选和后端执行白名单。复合引用的原子 Action 缺失时，catalog 返回可读诊断并不暴露该复合节点为可执行项。

首批通用复合流程：

- `localization-upload-notify`：上传源多语言 → 发送 `localization-uploaded` 通知。
- `localization-download-merge-notify`：准备翻译归档 → 应用翻译 → 提交多语言变更/MR → 发送 `localization-applied` 通知；MR 未合并时停在等待状态。
- `release-summary-record`：整理更新摘要 → 登记 Wiki 发版记录。
- `android-channel-packages`：规划渠道包 → 批量触发构建 → 刷新构建状态，仅 Android 可用。

Likee Android/iOS 的 localization、records 和 Android channel-packages 阶段默认引用复合节点。复合节点内部的原子 Action 不再作为默认推荐，但仍可被显式自定义节点选择。

## AgentFlow 执行

后端 catalog 将复合节点与原子节点统一返回，但复合节点增加：

- `kind: "composite"`
- `compositeId`
- `actions[]`（每项包含原子 Action ID、标题、输入映射和顺序）
- 聚合后的 `inputSchema`

执行复合节点时，后端生成一个 AgentFlow 图：每个原子 Action 是一个 `tool_nodejs` 节点，按配置顺序串行连接。前一步输出通过显式数据槽映射到下一步输入；无映射的上下文输入由统一 `releaseExecutionInputs` 注入。图执行失败时保留已完成的内部步骤、失败步骤和原因，复合节点整体标记失败并允许从失败步骤重试。

预览模式返回完整内部步骤预览，不执行外部写入；需要确认的原子 Action 在其步骤处暂停并沿用现有确认指纹机制。复合节点的确认指纹覆盖复合 ID、上下文、所有输入和内部 Action 顺序。

## 状态与 UI

时间线只新增一个复合节点记录，记录总耗时、操作人、状态和聚合输出；内部步骤保存在 `details.steps`，包括 `actionId`、状态、开始/结束时间、输出、错误和 runId。点击已完成复合节点只读查看内部步骤；点击待执行/失败复合节点可编辑聚合输入并执行或重试。

默认推荐算法按复合节点占位替代其内部原子节点，保证一个阶段不会连续弹出多个原子卡片。若复合节点因缺失 Action 或平台/批次不适用被过滤，则回退到该阶段剩余合法原子节点并展示诊断。

## 兼容与安全

当前项目仍在开发阶段，不新增旧数据迁移或 `workflowVersion`。已有原子 timeline 读取逻辑保留，但新状态机不会把复合内部 Action 误当作独立默认推荐。preview/run 必须同时校验复合节点属于当前 workflow，且每个内部 Action 属于当前业务线、平台和批次允许集合。

## 验收

- 配置可选择业务线、平台、批次对应的复合流程；Android/iOS 差异可通过配置表达。
- catalog、状态机、自定义节点候选和 preview/run 使用同一复合配置。
- 复合节点一次执行多个真实 release-skill Action，并按顺序记录内部步骤。
- 中途失败/等待可重试，不重复已完成步骤；取消可安全终止当前 AgentFlow 运行。
- completed 节点只读，pending/failed 节点可编辑和重试。
- Android 补包灰度输入约束在复合节点聚合输入中保留。
