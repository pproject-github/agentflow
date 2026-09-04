# 发版运行线上部署说明

发版页执行的是 AgentFlow Agent，不是 AgentFlow 服务进程内的硬编码脚本。线上需要准备两类独立目录：

- 产品工程（`repositoryRoot`）：例如 `/srv/release-projects/likee_android`，用于 Git、工程文件、构建和产物。
- Skill 目录（`skillRoots`）：例如 `/opt/release-skills/2026-09-01`，包含 `release-*` Skill 的 `SKILL.md` 与脚本。

状态文件和 Agent 运行产物不应写回 Skill 仓库，分别由 AgentFlow 数据根和运行目录保存。

## 最小配置

线上必须设置 `NODE_ENV=production`，并通过 `AGENTFLOW_RELEASE_PROJECTS_JSON` 配置业务线+平台到产品工程的 allowlist，以及发版写权限名单 `operators`：

```json
{
  "projects": [
    {
      "id": "likee-android-prod",
      "businessLine": "likee",
      "platform": "android",
      "workspaceRoot": "/srv/release-projects/likee_android",
      "skillRoots": ["/opt/release-skills/2026-09-01"]
    },
    {
      "id": "likee-ios-prod",
      "businessLine": "likee",
      "platform": "ios",
      "workspaceRoot": "/srv/release-projects/likee_ios",
      "skillRoots": ["/opt/release-skills/2026-09-01"]
    }
  ],
  "operators": {
    "likee": {
      "android": ["duanfengyuan", "suruijia", "wangfang"],
      "ios": ["liangjiajian", "yangcaimu"]
    },
    "bigolive": { "android": [], "ios": [] },
    "hello": { "android": [], "ios": [] }
  }
}
```

权限规则：

- **读开放**：任意登录用户可查看 catalog / state / 时间线。
- **写锁定**：`run` / `preview` / `stop` / pending 变更，以及聊天助手触发的自由 Agent，都必须在对应 `businessLine × platform` 的 operators 中；否则返回 `403 RELEASE_OPERATOR_FORBIDDEN`。
- 同一用户名只能归属一个业务线+平台；冲突会令配置校验失败。
- 未写明业务线/平台时，服务端与发版页用登录用户的 operators 归属补全。

如果所有项目共用同一个 Skill 版本，也可以用 `AGENTFLOW_RELEASE_SKILLS_ROOT`（多个路径用系统 path delimiter 分隔）指定公共根目录。项目级 `skillRoots` 优先。未配置 `skillRoots` / `AGENTFLOW_RELEASE_SKILLS_ROOT` 时接口返回 `RELEASE_SKILLS_NOT_CONFIGURED`，**不会**再静默回退到产品工程下的 `.workspace/release-skills`。线上应固定挂载知识库中的 `release-skills` 发布目录。浏览器只能提交 `workspaceId`；服务端不会接受未列入 allowlist 的绝对路径。

完整示例见仓库内 `docs/release-projects.example.json`。线上也可改为文件挂载：

```bash
export AGENTFLOW_RELEASE_PROJECTS_FILE=/etc/agentflow/release-projects.json
```

本地开发使用 `npm run dev`（`AGENTFLOW_DEV=1` + `AGENTFLOW_RELEASE_TEST_MODE=1`）时，会注入默认 likee Android 工程及其已挂载的 release-skills；生产环境不要设置 `AGENTFLOW_RELEASE_ALLOW_SERVER_WORKSPACE=1`。若深链误带了知识库工作区 id（`ws_*`），服务端会在仅有一个业务线工程时自动映射到发版工程。

## Skill 更新方式

不要在用户点击节点时执行 `git pull`。推荐流程是：

1. CI 从 `release-skills` 仓库构建带 commit/tag 的不可变目录或容器镜像。
2. 在 staging 使用同一份业务线、平台、版本上下文执行预检和可回放测试。
3. 通过后把 `AGENTFLOW_RELEASE_SKILLS_ROOT` 或项目配置切换到新目录；切换采用软链接/版本目录原子替换。
4. 保留上一版本目录，出现问题时回滚配置指向旧版本。

因此不需要为每次发版重新拉一个 `release-skillsd` 仓库。只有当 Skill 仓库本身需要独立权限、独立发布节奏或与产品工程完全隔离时，才建议把它部署为单独的只读镜像/挂载卷；AgentFlow 运行时通过配置引用该目录。

## 运行隔离和凭据

- Agent worker 只挂载当前业务线+平台的产品工程、对应 Skill 根目录和独立 outputs 目录。
- GitLab、Crowdin、企业微信等凭据通过 Secret Manager 或进程环境注入，不写入 prompt、状态 JSON 或日志。
- 通知 Skill 必须使用 operation/record id 做幂等，Agent 重试不能重复发送同一条通知。
- 多实例部署时，`activeReleaseRuns` 不能继续只放在单进程 `Map`；取消、日志和状态查询需要共享数据库/队列或粘性会话。
- 线上以服务端 release state 为权威，浏览器 `localStorage` 只能作为临时草稿，不能恢复旧节点或覆盖服务端状态。

## 后端选择

Cursor、Claude Code、Codex 已支持显式追加目标目录。若使用 OpenCode，需在部署中固定其外部目录授权策略，并验证临时 Agent 工作目录可以读取产品工程和 Skill 根目录；否则应固定使用已验证的其它后端。

