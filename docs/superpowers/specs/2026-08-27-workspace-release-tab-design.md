# Workspace 发版 Tab 设计

## 背景与目标

在现有 `/workspaces` 页面中增加“发版”Tab，将
`/Users/duanfengyuan/migration-workspace/test/likee_android/.workspace/release-skills`
目录中的可用发版 Skill 抽象为可执行的阶段节点，支持人工逐阶段触发，并为后续接入真实 AgentFlow 执行器保留接口。

首版目标是可本地自测的完整交互原型：进入页面可看到业务线、平台和版本上下文；节点可加入待执行列表、执行、取消和重试；完成节点进入当前版本时间线；失败节点保留失败原因；刷新页面状态不丢失。

## 方案

### 页面与路由

- 保持 `/workspaces` 路由不变，在 `WorkspacesPage` 顶部增加“迭代 / 发版”Tab。
- 进入发版 Tab 时优先从当前 Workspace 的 `mountPath`、`label` 或 `path` 推断业务线；推断不到时默认 `likee`。
- 平台从 Workspace 推断（路径包含 `ios` / `iphone` 时为 iOS，否则为 Android），也允许用户切换。
- 版本号提供可编辑输入，默认使用当前 Workspace 中已有版本，否则为 `1.0.0`。

### 节点模型

节点定义包含：

```js
{
  id, title, description, skill, category,
  businessLines: ['likee', 'bigolive', 'hello'],
  platforms: ['android', 'ios'],
  durationMs, nextNodeIds
}
```

节点集合由 Skill 名称映射生成，通用节点和平台专属节点共存：

- 通用：发版准备、接入工程、创建/选择发版、登记 release 分支、登记构建信息、Git 合并、多语言、指标快照、全量审核、发版记录、通知。
- iOS 专属：版本更新说明、首次审核。
- Android 专属：补包记录、渠道包。

节点定义保留 `businessLines` 字段，即使当前三条业务线共用同一套定义，后续可以直接按业务线裁剪或覆盖。

### 状态与数据流

发版状态保存在 `localStorage`，按 Workspace、业务线、平台和版本号组成 key：

```js
{
  context: { businessLine, platform, version },
  timeline: [{ nodeId, status: 'completed', completedAt, runId }],
  pending: [{ nodeId, status: 'pending' | 'running' | 'failed', startedAt, error, runId }],
  customNodes: [{ id, title, description, selectedNodeIds }]
}
```

执行适配器采用异步接口：

```js
runReleaseNode(node, context, { signal, onProgress })
```

首版实现本地模拟执行器，延迟后随机/可控地返回成功，支持 `AbortController` 取消；适配器独立于 UI，后续可替换为 AgentFlow run API。

每个节点完成后：

1. 从待执行列表移除并追加到时间线；
2. 根据 `nextNodeIds` 和当前上下文推理 1~2 个新的待执行节点；
3. 去重已完成、执行中和待执行节点。

失败节点保留在待执行列表，显示红色状态和错误原因；用户可重新执行。执行中的节点显示呼吸动画，并提供取消按钮，取消后回到待执行状态。

### 自定义节点

- “新增自定义节点”打开内联表单，填写标题和说明。
- 用户可从当前平台/业务线可用的全部节点中多选依赖/候选节点。
- 保存后自定义节点立即进入待执行列表，可执行；允许继续新增。

### 视觉结构

- 发版上下文卡片：业务线、平台、版本号、节点统计。
- 主体双栏：左侧垂直时间线，右侧待执行阶段卡片。
- 节点卡片状态色：完成绿色、执行中蓝色呼吸态、失败红色、待执行中性灰。
- 沿用现有 `af-workspaces-*` 设计语言，新增 `af-release-*` 样式，移动端降为单栏。

## 错误处理

- localStorage 读写失败时退化为内存状态，并在页面显示非阻塞提示。
- 执行异常统一转换为可读错误文本；不会丢失失败节点。
- 取消只影响当前节点，不会修改已完成时间线。

## 测试与验证

- `npm run lint`：检查新增 React 代码和 hooks。
- `npm run build`：验证 Vite 构建。
- 启动 `npm run dev`，验证 `/workspaces` 的 Tab 切换、平台切换、节点执行/取消/重试、自定义节点、刷新持久化。

