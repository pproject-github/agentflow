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

- `likee / android / initial|supplemental` → `likee-android-release`（含灰度放量）
- `likee / ios / initial|supplemental` → `likee-ios-release`（与 Android 节点同步，无灰度放量）

未来增加 bigolive、hello 或新的平台，只需增加同样作用域的定义，不会污染其他集合。

## Likee Android 发版状态机

首包和补包共用 `likee-android-release`，不是两条独立流程。`batch` 只决定当前发版实例启用哪些阶段节点。

### 首包（`batch=initial`）

```text
发版入口（准备上下文 / 多语言上传 / 创建分支）
  → 多语言下载合入
  → 合回 master
  → 构建包
  → 提审单
  → 发布并通知
  → 放量
  → 全量审核单 → 全量发布
```

### 补包（`batch=supplemental`）

```text
发版入口（准备上下文 / 补包通知）
  → 构建包
  → 发布并通知
  → 放量
  → 全量审核单 → 全量发布
```

补包可从「放量」或「全量发布」开新批次。渠道包 / Google Play 仅属于 Android。

## Likee iOS 发版状态机

首包和补包共用 `likee-ios-release`。阶段与 Android 对齐，但**没有灰度放量**；构建走 `release-build`，发布可含 `release-release-notes`。

### 首包（`batch=initial`）

```text
发版入口（准备上下文 / 多语言上传 / 创建分支）
  → 多语言下载合入
  → 合回 master
  → 构建包
  → 提审单
  → 发布并通知
  → 全量审核单 → 全量发布
```

### 补包（`batch=supplemental`）

```text
发版入口（准备上下文 / 补包通知）
  → 构建包
  → 发布并通知
  → 全量审核单 → 全量发布
```

补包可从「发布并通知」或「全量发布」开新批次（无放量阶段）。

## 推荐规则

1. 初始化节点进入已完成时间线，不执行任何外部动作。
2. 当前状态内按能力顺序推荐第一个未完成节点。
3. 当前状态存在 `running` 或 `failed` 时停止推荐；`waiting` 视为成功并推进。
4. 当前状态全部完成后，沿状态机转移到下一个状态并推荐其第一个节点。
5. 用户手工追加的节点仍可执行，但不会改变历史状态机的顺序；成功记录仍会被状态机识别。
6. 节点必须同时满足当前业务线、平台、版本、批次和 Profile 约束。
