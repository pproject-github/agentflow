# AgentFlow Skills AI 助手平台接入规范

本文供接入 AgentFlow Skills 的 AI 助手平台、工具执行器和 Skill 编排管理员使用。目标是让用户通过自然语言完成以下闭环：

1. 首次使用时通过浏览器授权 AgentFlow CLI
2. 根据想法创建临时、可运行的 Draft Workspace
3. 打开 Preview、实际试运行并根据反馈动态修改
4. 用户确认后发布到个人空间
5. 仅在用户明确确认后启用定时运行

本接入不依赖 MCP，也不要求平台安装 AgentFlow npm 包。`agentflow-cli` Skill 已携带版本匹配的本地 DSL Runtime。

## 1. Skill 编排

建议在平台的 `agentflow` Skill 集合中按以下顺序启用：

| 顺序 | Skill | 当前验证版本 | 是否必需 | 职责 |
|---|---|---:|---|---|
| 1 | `agentflow-author-flow` | `0.1.2` | 必需 | 用户入口；编排 Draft、试运行、修改、发布和定时生命周期 |
| 2 | `agentflow-flow-dsl` | `0.1.9` | 必需 | 创建和修改 `workspace.flow.js` 流程图 |
| 3 | `agentflow-node-dsl` | `0.1.4` | 建议 | 内置节点不满足需求时创建可执行代码节点 |
| 4 | `agentflow-cli` | `0.1.9` | 必需 | 浏览器授权、DSL 校验、Draft、运行、发布和定时操作 |
| 5 | `agentflow-workspace-chart` | `0.1.1` | 可选 | 生成复杂 `display.chart` ChartSpec |

不要再向用户分发 `agentflow-node-authoring`。它是旧入口，职责已由 `agentflow-node-dsl` 承接，同时启用会造成 Skill 触发歧义。

涉及 TAPD/PRD Workflow 上报时，再单独启用 `agentflow-workflow-report`；它不是普通 Flow 创建链路的必需项。

发布新 Skill 版本后，平台必须更新集合中固定的版本并保存编排。仅在 SkillHub 发布新版本不会自动升级既有集合。

## 2. 平台运行环境要求

平台工具执行器必须满足：

- Node.js 20 或更高版本
- 可以访问 `http://ai.mengma.bigo.inner/`
- 可以执行 Skill 目录内的 `scripts/agentflow-cli.mjs`
- 可以把授权 URL 作为可点击链接返回给当前用户
- 有按平台用户隔离、跨消息和跨对话持久化的文件目录
- 有按用户或会话隔离、可持久化的 Flow 工作目录

平台必须通过已安装 Skill 的真实路径定位 CLI：

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs <command>
```

不要假设当前业务仓库包含 `skills/agentflow-cli`，不要调用全局 `agentflow` 命令，也不要临时安装 npm CLI。

## 3. 授权数据持久化

### 3.1 客户端凭据

CLI 默认将授权状态保存到：

```text
~/.agentflow/auth.json
```

在多用户 AI 平台上，不应依赖共享或临时的 `HOME`。平台必须为每个登录用户设置稳定、隔离的路径，例如：

```text
AGENTFLOW_AUTH_FILE=/persistent/agentflow-auth/<platform-user-id>/auth.json
```

约束如下：

- 同一个平台用户的不同消息、不同对话应复用同一授权文件
- 不同平台用户绝不能共享同一个授权文件
- 目录权限应为 `0700`，文件权限应为 `0600`
- 不得读取、展示、记录或上传授权文件内容
- 不得把 `AGENTFLOW_AUTH_FILE` 放在会被任务结束后删除的临时目录中

授权文件包含两类状态：

- `pending[baseUrl]`：一次性授权请求和只应留在本机的 device code
- `profiles[baseUrl]`：完成兑换后的 CLI Session、用户信息和过期时间

如果平台无法提供跨消息持久化文件系统，当前浏览器授权方案无法正常接入。必须先为工具执行器增加持久卷或等价的按用户安全存储。

### 3.2 Flow 工作目录

平台还应为每个用户和对话保留稳定的本地工作目录，用于保存：

- `workspace.flow.js`
- `workspace.layout.json`
- 自定义 `nodes/`
- 当前 Draft ID 和最近一次 revision

授权文件按用户复用；Flow 工作目录按用户和任务隔离。不要把不同用户或不同任务的 Flow 文件放在同一个可写目录中。

## 4. 浏览器授权状态机

浏览器点击 Allow 只会把服务端授权请求标记为 `approved`，不会自动把凭据写入 CLI。CLI 必须在原执行环境中运行 `auth complete`，把一次性请求兑换为 30 天 CLI Session。

授权请求有效期为 10 分钟；完成兑换后的 CLI Session 有效期为 30 天。

### 4.1 每次执行 AgentFlow 任务前

先执行：

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs config
```

只有同时满足以下条件才能继续：

- `hasToken: true`
- `localRuntime.available: true`

### 4.2 `hasToken: false` 时的正确顺序

平台或 Agent 必须先尝试完成已有请求：

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs auth complete
```

根据结果处理：

| 结果 | 平台动作 |
|---|---|
| `authenticated` | 再执行 `auth status`，验证成功后继续用户任务 |
| `authorization_pending` | 返回结果中的原 `verificationUrl`，等待用户点击；不要创建新请求 |
| `No pending AgentFlow authorization` | 才允许执行 `auth start` |
| `expired_token` / `access_denied` | 清理已失效状态后执行一次新的 `auth start` |

首次没有 pending 请求时执行：

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs auth start
```

将返回的 `verificationUrl` 交给当前用户，并明确提示：

> 请打开链接登录 AgentFlow 并点击 Allow。完成后回复“已授权”，我会继续完成 CLI 登录。

用户回复“已授权”“已经点了”“现在能用了吗”等表达后，必须执行：

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs auth complete
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs auth status
```

不得因为 `config` 仍显示 `hasToken: false` 就再次运行 `auth start`。在 `auth complete` 之前，`hasToken: false` 是正常状态。

### 4.3 禁止覆盖 pending 请求

当前 CLI 的 `auth start` 会按 AgentFlow base URL 保存一个 pending 请求。重复执行可能覆盖上一条请求在本地保存的 device code，导致用户已经批准的旧请求无法兑换。

因此平台必须遵守：

1. 已返回授权 URL 后，将本轮状态标记为 `waiting_for_agentflow_authorization`
2. 后续消息先执行 `auth complete`
3. pending 未过期时复用原 URL
4. 只有明确过期、拒绝或本地确实没有 pending 时才创建新请求

### 4.4 平台参考伪代码

```text
ensureAgentFlowAuthorized(user):
  set AGENTFLOW_AUTH_FILE to a stable path owned by user

  config = run("config")
  if config.hasToken:
    status = run("auth status")
    if status.authenticated:
      return AUTHENTICATED

  completion = runAllowingNonZeroExit("auth complete")
  if completion.status == "authenticated":
    assert run("auth status").authenticated
    return AUTHENTICATED

  if completion.status == "authorization_pending":
    return WAITING(completion.verificationUrl)

  if completion.error == "No pending AgentFlow authorization":
    started = run("auth start")
    return WAITING(started.verificationUrl)

  if completion.code in ["expired_token", "access_denied"]:
    started = run("auth start")
    return WAITING(started.verificationUrl)

  return ERROR(completion.safeMessage)
```

`authorization_pending` 可能使用非零退出码表达“需要用户操作”，平台不得把它当成系统故障或触发自动重试 `auth start`。

## 5. 授权后的 Flow 用户链路

授权成功后，平台应由 `agentflow-author-flow` 统筹，不要让用户手工拼 CLI 命令。

### 5.1 创建 Draft

1. 根据用户想法生成 `workspace.flow.js`
2. 使用 `agentflow-flow-dsl` 执行 lint 和 layout
3. 内置节点不足时才使用 `agentflow-node-dsl`
4. 创建可运行 Draft：

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs draft-create \
  --file <flow-dir> \
  --ttl-seconds 7200
```

包含本地 `nodes/` 时增加 `--with-dependencies`。将 Draft URL 返回给用户。

### 5.2 试运行和动态修改

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs draft-run \
  --draft-id <draft-id> \
  --run-node-id <run-node-id>
```

用户在 Workspace UI 修改后，Agent 必须先 pull 最新 Draft，再基于返回的 revision 修改：

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs draft-pull \
  --draft-id <draft-id> \
  --output <flow-dir> \
  --replace

node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs draft-update \
  --draft-id <draft-id> \
  --base-revision <last-revision> \
  --file <flow-dir>
```

发生 revision 冲突时必须重新 pull，不能用旧本地文件覆盖用户的 UI 修改。

### 5.3 发布和定时运行

发布前必须向用户展示 Draft ID、目标 Flow ID、个人空间和定时模式，并等待明确确认。

默认发布但不启用定时运行：

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs draft-publish \
  --draft-id <draft-id> \
  --flow-id <flow-id> \
  --target-space personal \
  --schedule disabled
```

只有用户明确要求自动运行时才使用 `--schedule enabled`。启用后必须执行 `schedule-list`，只有 `enabled: true` 且存在 `nextRunAt` 时才能向用户报告定时任务已生效。

## 6. 用户交互规范

平台回答应使用用户语言描述结果，CLI JSON 只作为内部证据。禁止把以下内容返回给用户或写入普通日志：

- CLI Token
- device code
- 浏览器 Cookie
- `auth.json` 内容
- 密码或其它本地凭据

允许返回：

- 当前用户专属的 `verificationUrl`
- 授权请求过期时间
- 已授权用户名
- Session 过期时间
- Draft URL、运行状态和安全的错误信息

授权 URL 虽然不包含 Token，但代表一个有效授权请求，只能发送给发起请求的用户。

建议交互文案：

```text
首次授权：
AgentFlow CLI 已就绪，还需要一次浏览器授权。请打开以下链接登录并点击 Allow：
<verificationUrl>
完成后回复“已授权”。

授权完成：
AgentFlow CLI 已完成授权，现在可以创建、试运行和发布 Flow。

仍待授权：
当前授权请求仍在等待确认，请继续使用原链接；我不会重复创建新的授权请求。
```

## 7. 错误处理

| 现象 | 原因 | 处理 |
|---|---|---|
| 浏览器显示“授权完成”，但 `hasToken: false` | 尚未执行 `auth complete` | 在生成链接的同一持久化环境执行 `auth complete` |
| `No pending AgentFlow authorization` | 授权文件未持久化、路径变化或从未 start | 核对 `AGENTFLOW_AUTH_FILE`；确实无 pending 后重新 start |
| 已批准的旧 URL 无法生效 | 后续 `auth start` 覆盖了本地 pending | 停止重复 start；使用当前 pending URL重新批准 |
| 每轮对话都要求授权 | `HOME` 或授权文件位于临时容器 | 改为稳定、按用户隔离的持久卷路径 |
| A 用户看到 B 用户身份 | 多用户共享授权文件 | 立即停止服务、撤销 Session并修复用户隔离 |
| `localRuntime.available: false` | Skill 版本过旧或安装不完整 | 从 SkillHub 更新/重装 `agentflow-cli`，不要安装 npm CLI |
| `revision-mismatch` | 用户或 Agent 已更新 Draft | pull 最新 revision 后重新应用修改 |
| 定时发布后没有 `nextRunAt` | Schedule 未真正注册或配置无效 | 读取 `schedule-list`，不得宣称已启用 |

## 8. 接入验收清单

使用一个没有旧 Token、没有项目 `.env`、没有全局 AgentFlow npm 包的新平台账号完成以下验收：

- [ ] 平台安装并启用正确版本的核心 Skills
- [ ] `config` 显示 `localRuntime.available: true`
- [ ] 首次询问 AgentFlow 时只生成一个授权请求
- [ ] 用户点击 Allow 后，下一条消息执行 `auth complete` 而不是新的 `auth start`
- [ ] `auth status` 返回当前授权用户
- [ ] 重启工具进程和开启新对话后仍保持授权
- [ ] 不同平台用户之间授权完全隔离
- [ ] 能根据自然语言创建 Draft 并返回可打开 URL
- [ ] Draft 能真实运行并读取 display 输出
- [ ] 用户在 UI 修改后，Agent 能 pull、继续修改且不覆盖用户变更
- [ ] 未经确认不会发布正式 Flow
- [ ] 默认发布到个人空间且 Schedule disabled
- [ ] 用户明确确认后可启用 Schedule，并验证 `nextRunAt`
- [ ] `auth logout` 后服务端 Session 失效，本地 profile 被清除

以上项目全部通过后，才可认为 AI 助手平台完成 AgentFlow 用户功能接入。
