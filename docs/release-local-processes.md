# 本地 release-skill 发版流程状态机

## 数据来源

状态机依据本地工程
`/Users/duanfengyuan/migration-workspace/test/likee_android/.workspace/release-skills` 的
`.release-skill/executions/*.yaml` 归纳。共读取 85 条记录：72 条成功、9 条失败、4 条外部结果未知，
时间范围为 2026-08-06 至 2026-08-27。

同一个 Action 的重复执行（例如多次上传源多语言、翻译归档重试、通知重发）只计为一个状态节点；
失败和外部结果未知不会推动状态机前进，成功重试后才允许进入下一状态。

## 状态机选择

状态机按当前上下文选择：

```text
businessLine + platform + batch
```

当前已定义：

- `likee / android / initial|supplemental` → Likee Android 发版（同一状态机，按批次选择阶段）
- `likee / ios / initial|supplemental` → Likee iOS 首包 / 补包

未来增加 bigolive、hello 或新的平台，只需增加同样作用域的定义，不会污染其他集合。

## Likee Android 发版状态机

首包和补包共用 `likee-android-release`，不是两条独立流程。`batch` 只决定当前发版实例启用哪些阶段节点。

### 首包（`batch=initial`）

```text
初始化
  → 发版准备
  → 多语言处理
  → 更新摘要
  → 首次发版审核
  → 指标检查（可选）
  → 灰度观察
  → 发版记录
  → 发版通知
  → Android 渠道包（可选）
```

状态对应的实际 Action：

- 发版准备：确认当前发版、创建/登记活动发版和 release 分支
- 多语言处理：上传源文件、准备翻译归档、应用翻译、提交多语言变更
- 更新摘要：`compose-update-summary`
- 首次审核：`create-initial-release-approval`
- 指标检查：查询版本指标、保存指标快照
- 灰度观察：`observe-gray-dashboard`
- 发版记录：追加 Wiki 行、登记商店过审
- 发版通知：`send-notification`

### 补包 / 放量（`batch=supplemental`）

```text
初始化
  → 补包准备
  → 更新摘要
  → 指标检查（可选）
  → 灰度观察
  → 全量发布审核
  → 补包/全量记录
  → 补包/放量通知
  → Android 渠道包（可选）
```

补包 Wiki 记录必须保留 Android `gray_percent` 输入；全量记录使用 `100`。渠道包仅属于 Android，
默认清单完成后再进入渠道包通知，不由状态机自动发送通知。

## Likee iOS 首包 / 补包状态

iOS 复用准备、多语言、审核、指标、灰度观察、记录和通知状态，并增加
`upload-ios-release-notes`。iOS 不进入 Android 渠道包状态，也不要求 Android 式补包灰度百分比；
`record-full-rollout-time` 作为记录阶段的可选节点。

## 推荐规则

1. 初始化节点进入已完成时间线，不执行任何外部动作。
2. 当前状态内按 Action 顺序推荐第一个未完成节点。
3. 当前状态存在 `running`、`failed` 或 `external_result_unknown` 时停止推荐，不跨状态。
4. 当前状态全部完成后，沿状态机转移到下一个状态并推荐其第一个节点。
5. 用户手工追加的节点仍可执行，但不会改变历史状态机的顺序；成功记录仍会被状态机识别。
6. 节点必须同时满足当前业务线、平台、版本、批次和 Profile 约束。
