---
name: agentflow-node-authoring
description: >-
  使用任意本地 Agent CLI（Cursor、Codex、Claude Code、OpenCode 等）生成、验证、预览、发布和安装 AgentFlow marketplace 节点。用户要求创建可复用节点、把本地节点发布到平台、或将节点安装进 Flow 时使用。
---

# AgentFlow Node Authoring

这是通用的 Skill，不绑定某一种 Agent。当前 Agent 负责生成文件和调用命令；AgentFlow CLI 负责校验、发布、安装和运行验证。

## 标准流程

1. 先读取 `agentflow-node-reference`，确认输入/输出槽位、handle 顺序和运行类型。
2. 在当前项目创建一个独立节点包目录，至少包含 `node.yaml`。运行脚本节点还应包含 `scripts/run.mjs`，并在 manifest 的 `runtime.entry` 指向它。
3. 用当前 Agent CLI 编写实现、README、prompt/implementation 文档和最小测试输入。
4. 做本地检查：

   ```bash
   agentflow marketplace publish-node <package-dir> --json
   agentflow marketplace list --json
   ```

   `publish-node` 会把包复制到当前 workspace 的 `.workspace/agentflow/marketplace/packages/nodes/<id>/<version>`；发布前应确保 `id`、`version`、`runtime`、`inputs`、`outputs` 完整。

5. 将节点安装到 Flow：

   ```bash
   agentflow marketplace install-node <FlowName> marketplace:<id>@<version> --json
   agentflow validate <FlowName> --json
   ```

6. 启动本地 UI，在节点编辑器或 Flow 画布中确认节点卡片、端口和帮助文案；再用 `agentflow run` 或 UI 运行一个最小样例。

## Manifest 约束

- `id` 只使用小写字母、数字、`_`、`-`；版本使用完整 semver。
- `runtime.type` 使用已有 builtin definition（例如 `tool_nodejs` 或 `agent_subAgent`），不要伪造运行时类型。
- `inputs`/`outputs` 的顺序就是画布 handle 的顺序；新增或调整槽位后必须重新验证 Flow 连线。
- 每个槽位至少提供 `type` 和 `name`；用户需要填写的槽位设置 `required: true` 和 `showOnNode: true`。
- 脚本必须是可移植的 Node.js 实现，不要把本机绝对路径或密钥写入包。

## 权限与发布范围

- `marketplace publish-node` 是本地 workspace 市场发布，不等于 npm 或 Hub 发布。
- 普通用户只能覆盖自己拥有的同名节点；管理员可以治理所有者节点。
- 需要分享给团队时，发布到团队约定的 workspace 或由管理员安装；不要直接把测试包放进 `builtin/nodes`。

## Agent CLI 配合

Agent 可以使用自己擅长的 CLI 生成和修改节点；不要求调用 MCP。完成文件后统一通过 `agentflow` CLI 做确定性操作：

- `marketplace publish-node`：发布本地节点包
- `marketplace list`：确认节点版本和目录
- `marketplace install-node`：写入 Flow 的 marketplace 依赖
- `validate` / `run`：验证和执行

若 AgentFlow CLI 不在 PATH，可使用项目入口：`node bin/agentflow.mjs marketplace ...`。
