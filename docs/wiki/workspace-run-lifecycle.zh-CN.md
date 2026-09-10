# Workspace Run 空间与生命周期

AgentFlow 将一次 Workspace 执行使用的文件分为三类，三者不能共享清理策略。

| 空间 | 默认位置 | 生命周期 |
| --- | --- | --- |
| Source Cache | `.workspace/agentflow/git-repos/` | 持久复用，由 Git Checkout 更新 |
| Run Workspace | `.workspace/agentflow/run-workspaces/` | `wait` 时保留，终态时清理干净的 worktree |
| Node Temp | `.workspace/agentflow/tmp/workspace-run-*` | 每次执行调用结束后清理 |
| Artifacts | `outputs/` | 持久保存，不参与 Runtime finally 清理 |

每次执行还会在 `.workspace/agentflow/run-manifests/<runId>.json` 写入资源清单，记录：

- 本次节点临时目录 `runtimeRoot`
- 持久产物目录 `artifactRoot`
- Git worktree 的仓库、路径、节点和清理结果
- `running`、`waiting`、`completed`、`failed` 或停止后的资源状态

## Wait 与恢复

`control.while` 返回 `wait` 或运行进入 deferred 状态时：

1. 保留已加载的 Run Workspace；
2. 清理与 worktree 分离的节点临时目录；
3. 保留 Worktree Load 节点的 `worktreePath` 输出；
4. 下一次运行优先重新认领该已注册 worktree，而不是创建新的目录。

## 终态清理

运行成功、失败或停止进入终态时，Runtime 对已登记 worktree 执行非强制删除：

- clean worktree：`git worktree remove`，随后 `git worktree prune`；
- dirty worktree：保留目录和 Git 注册，输出 warning，并在 run manifest 中标记 `resourcesPreserved`；
- 已显式执行 Worktree Unload 的资源不会再次清理；
- `outputs/` 永远不由这套 finally 清理。

服务进程被硬终止时 finally 无法执行，run manifest 是后续诊断和回收的事实记录；自动过期扫描属于后续资源回收能力。

## 作用域解析：目录是唯一事实

同一个流程目录只能有一条解析口径。管理员只读视图（`adminOwnerId`）曾经用
`listFlowsJson` 找目录，而流程列表按设计滤掉了 draft 与 preview 目录；owner 自己
打开走的却是 `getPipelineFiles`。于是同一个 `draft_xxx`，owner 打得开，管理员带上
`adminOwnerId` 反而 404 `Pipeline workspace not found`——看着像没权限，其实是没找到。

现在管理员分支在列表落空时回落到 `getPipelineFiles`，与 owner 落到同一个目录。
可见性由目录决定，只读属性仍由作用域决定：`adminReadonly: true`，
`collaborationAccess` 的 `writable` / `runnable` 都是 `false`。

## 定时归属：目录在谁名下就归谁

个人作用域的流程靠 `(ownerId, flowId)` 才唯一——两个人各留一份同名流程是常态，
协作登记的 `flowKey` 就是为此存在的。归属判断只比对 `flowId` + 作用域时，
`find` 命中的是注册表里**第一条当前用户有权限的**记录：A 保存自己的流程，可能被判成
B 的，登记随之改姓，调度按 B 的身份解析作用域、跑的是 B 的那份，运行记录也记到 B 头上。
前缀删除用的是同一个错 userId，还会顺手删掉 B 真实的那条登记。

现在统一走 `workspaceProjectCollaborationForActor`：

1. 先找**自己名下**的协作登记（`getWorkspaceCollaborationForProject` 带 ownerId）；
2. 再看自己在这个作用域下**有没有这份目录**——有就是自己的，不被别人的同名登记接管；
3. 最后才认别人分享过来的同名登记。要打开别人分享的那份，请求带 `workspaceId`，
   在第一步之前就短路了。

`syncWorkspaceSchedulesForGraph` 不再二次推断，直接采信已解析的 `scoped`：
**谁的目录被调度，登记就归谁**。`workspaceRunKey`（并发锁）和
`workspaceCollaborationEventKey`（协作推送）走同一套查找，避免两个人的同名流程
被合并成一个 key。

### 没有归属的共享定时

管理员定时页是逐用户枚举出来的。共享作用域的流程人人可见，用"枚举到的这个人"兜底
归属，等于把流程记在字典序最靠前的账号头上——线上出现过 `registered=false`、
且没有任何协作登记的 workspace 流程被记到一个从没打开过它的人名下。

现在的口径：有登记就用登记里的 `userId`，没登记则用协作登记的 owner，两者都没有时
**留空**。归属为空的行在页面上显示 `-`；`registered=false` 同时意味着轮询根本扫不到它，
图里的"已启用"只是设计态，不代表在跑。

### 存量修复

`workspace-schedule-owner-v1` 启动迁移（与流程迁移同一把锁，在 scheduler 起来之前跑）：

- 个人作用域：按目录认回来——哪个用户的 pipelines 里确实有这份流程、且图里确实有这个
  定时节点，就是谁的；
- 共享作用域：认协作登记的 owner；
- 正主那条已经在了，判错主留下的就是重复登记，删掉（否则同一个定时触发两次）；
- 认不回来的（流程已删、多个用户都对得上、图解析失败）**一律不动**，记进 `unresolved`；
- 改写前把原 `workspace-schedules.json` 备份到 `admin/backups/`。
