# 发版流程与节点状态机设计

## 目标

将发版页当前按单个节点 `nextNodeIds` 推荐的逻辑，升级为按业务线与平台维护的“流程/阶段状态机”。一个流程由多个有序操作节点组成；只有流程内节点全部完成后，才进入下一个流程并推荐该流程的第一个待执行节点。状态机配置同时是当前上下文的可执行节点集合，自定义阶段只能从该集合中选择。

## 核心概念

### 流程（Process/Stage）

流程是推荐和状态判断的最小业务单位，例如：

- 多语言上传流程：上传多语言、校验上传结果、发送通知；
- 多语言下载流程：下载翻译、检查工程差异、提交 MR；
- 发版审核流程：生成审核草稿、等待确认、记录审核结果。

流程包含多个节点，并定义节点顺序、完成条件和下一流程。

### 节点（Action/Operation）

节点对应 `release-skills` 中的一个 Skill Action，是实际执行的最小操作单位。节点状态仍然使用现有状态：`pending`、`running`、`failed`、`completed`。

### 流程状态

流程状态由其节点集合推导，不额外依赖用户手工选择：

- `pending`：流程尚未开始，或仍有未完成节点；
- `running`：流程内至少一个节点执行中；
- `failed`：流程内存在失败节点；
- `completed`：流程内所有必需节点完成。

## 状态机配置来源

状态机的业务配置集中保存在一份纯数据配置中，由前端状态机和服务端目录编排共同读取。建议路径为：

```text
shared/release-workflow-config.js
```

配置以 workflow 列表表达业务线、平台和批次的差异；每个 workflow 包含有序 stages，每个 stage 包含有序 Action 引用及可选节点标记。配置只保存流程语义，不重复保存 release-skill 的标题、输入 schema、执行脚本或确认策略。

配置至少包含以下字段：

- `id`、`title`：流程标识和展示名称；
- `businessLines`、`platforms`、`batches`：适用范围；
- `stages[]`：阶段顺序；
- `stages[].nodes[]`：当前阶段允许执行的 Action ID 顺序；
- `stages[].optionalNodeIds` 或节点级 `optional`：可选节点；
- `processOrder`、`skillProcessMap`、`actionOrder`：无显式流程元数据时的兼容排序。

配置的节点集合具有双重作用：

1. 状态机只对配置引用的节点计算状态和推荐；
2. “自定义添加阶段”只展示当前 workflow、当前批次筛选后的配置节点，不能从整个 release-skill catalog 任意挑选。

动态 release-skill catalog 仍负责发现节点的可执行事实（脚本路径、输入 schema、平台限制、确认要求）。状态机配置负责决定节点是否属于当前业务/平台/批次流程；两者取交集后才是可执行集合。

配置加载必须经过校验：workflow 范围不能为空、stage/node ID 不能重复、同一 workflow 内 Action 不能重复、optional 节点必须属于所属 stage。未找到配置引用的 Action 时记录可读诊断并跳过该节点，不得让其他合法节点消失。

## 状态机与 release-skill 的关系

状态机配置的初始内容由最新 `release-skills` 的以下信息归纳生成：

1. 当前业务线与平台的 Profile；
2. Profile 的 `profile_refs`，决定可用 Skill 集合；
3. Skill Action 的顺序、平台、批次和前置条件；
4. 已执行流程记录，用于识别当前流程状态。

配置生成后，运行时以配置为权威来源；release-skill 目录只提供执行事实和输入定义。没有匹配 workflow 配置时，不产生可执行候选、不推荐节点，也拒绝 preview/run；页面可以展示“当前业务线/平台尚未配置发版流程”的诊断状态。

### 历史执行归纳

当前状态机的 Likee Android 首包、补包/放量顺序来自本地
`.workspace/release-skills/.release-skill/executions/*.yaml` 的成功记录归并：
重复 Action 合并为一个状态，失败或 `external_result_unknown` 不产生状态转移；补包指标检查和
Android 渠道包属于可选分支。历史记录只用于生成或人工调整配置中的状态顺序和可选分支，不会在运行时修改或删除状态机配置。

状态机定义按 `businessLine + platform + batch` 选择，当前覆盖 Likee Android 发版和 Likee iOS
首包/补包；Android 首包与补包共用同一个 `likee-android-release` 状态机，`batch` 只筛选启用的阶段。未匹配的业务线或平台不暴露任意目录节点，等待补充对应 workflow 配置。

当前 `release-skills` 的 Likee Android Profile 仅声明 `profile_refs`，尚未绑定已发布的
`workflow_id/workflow_version`，各 Skill Action 也尚未声明流程字段。因此前端状态机的
`processId/processOrder` 目前属于推荐层兼容映射：优先使用目录或未来 Workflow 定义提供的
显式字段，否则按 Skill/Action 兜底。它不替代 release-runtime 的 WorkflowDefinition、edges、
条件依赖和 ready 节点计算；接入正式 Workflow 实例后，应以实例状态和依赖结果覆盖本地线性推荐。

## 推荐策略

推荐不再直接把任意 `nextNodeIds` 当作最终推荐结果，而是：

```text
当前上下文（业务线/平台/版本/批次）
  ↓
加载当前 Profile 对应的流程状态机
  ↓
读取 timeline 中已完成的节点
  ↓
计算当前流程及其状态
  ↓
当前流程未完成：推荐该流程的下一个未完成节点
当前流程已完成：迁移到状态机的下一流程
  ↓
推荐下一流程的第一个合法节点
```

推荐约束：

- 推荐单位是流程中的节点，但 UI 展示为流程/阶段卡片；
- 同一流程内节点必须按定义顺序执行；
- 流程未完成时不跨流程推荐；
- 流程完成后才允许推荐下一流程；
- 只推荐当前 Profile、业务线、平台、版本和批次范围内节点；
- 已完成节点、已有 pending 节点和不可运行节点不重复推荐；
- 没有合法下一流程时进入终态，不再按目录顺序盲目推荐。

## 前端状态结构

```js
{
  context: { businessLine, platform, version, batch },
  timeline: [
    { nodeId, processId, status: "completed", ... }
  ],
  pending: [
    { nodeId, processId, status: "pending" | "running" | "failed", ... }
  ],
  processStates: {
    [processId]: "pending" | "running" | "failed" | "completed"
  }
}
```

`processStates` 可以由 `timeline` 和 `pending` 派生；若实现中不持久化该字段，必须保证每次状态回填和节点完成后重新计算结果一致。

## 状态迁移

```text
初始化声明完成
  → 准备活动发版上下文（已有记录复用，不存在时按输入创建）
  → 按 workflow 配置计算入口流程
  → 推荐入口流程内第一个节点

节点执行成功
  → 节点加入 timeline
  → 流程仍有未完成节点：推荐同流程下一个节点
  → 流程全部完成：迁移到下一流程

节点执行失败
  → 节点保留 failed
  → 不迁移流程
  → 重试成功后继续原流程

节点取消
  → 节点回到 pending
  → 不迁移流程
```

## 统一执行与节点集合

推荐、状态推导、候选节点过滤和 AgentFlow 执行使用同一套节点身份：`skill:action`。执行前后端都必须验证：

- 节点属于当前业务线、平台、版本和批次 scope；
- 节点被当前选中的 workflow/stage 配置引用；
- 请求中的 `processId` 与配置计算结果一致；
- 自定义节点只能复制配置中已有节点定义，不能创建新的执行脚本或绕过配置白名单。
- 活动发版上下文准备属于初始化前置步骤，未完成前不推荐普通发版节点；
- 初始化后的入口流程由 workflow 配置决定，不依赖 catalog 数组顺序或固定创建分支。

这样不同业务线和平台只需新增或调整配置项，执行代码、状态迁移代码和 UI 候选节点代码保持不变。

## 兼容性

- 当前仍处于开发阶段，本次不新增旧状态迁移；无法映射的历史节点不进入新的可执行候选集合。
- 保留静态 `releaseNodeCatalog` 作为 API 不可用时的兜底，但推荐逻辑同样经过流程状态机过滤。
- 后端继续负责目录发现、执行范围校验和状态持久化；前端负责根据状态机计算当前流程和推荐节点。
- 当前仍处于开发阶段，本次不新增旧状态迁移或配置版本兼容逻辑；已有兼容读取代码可保留，但不得阻碍共享配置和节点白名单实现。

## 测试要求

- Likee Android 的流程定义能从 Profile 和 Action 生成；
- 初始化后推荐第一个流程的第一个节点；
- 流程内第一个节点完成后推荐同流程下一个节点；
- 流程内所有节点完成后才推荐下一流程；
- 流程节点失败或取消不会跨流程；
- 不同业务线、平台、版本、批次和 Profile 的节点不会被推荐；
- 新建状态只按当前 workflow 配置计算，不要求旧 timeline 迁移；
- 没有合法下一流程时保持终态。
- 配置新增、删除、调整节点后，状态机选择和自定义节点候选集合同步变化；前端与服务端读取同一配置得到相同节点集合。
