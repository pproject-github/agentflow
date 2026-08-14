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
