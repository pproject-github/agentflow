---
name: agentflow-flow-sync-ui
description: >-
  在 AgentFlow Web UI + Composer 场景下，将 flow.yaml 保存到磁盘后通知本地 UI 刷新画布；
  使用 POST /api/flow-editor-sync（端口以 Composer 系统提示中的 URL 为准）。
---

# AgentFlow：保存 flow.yaml 后同步 Web 画布

在 **已通过 Composer 编辑当前流水线**（系统提示里已注入 `flowId`、`flowSource`、UI 端口）且 **本机正在运行 `agentflow ui`** 时使用。

## 何时执行

每次对当前流水线的 **`flow.yaml` 做完增删改并已写入磁盘** 后执行 **一次**（含多次保存中的最后一次完成后）。

## 做什么

向本地 Web UI 发通知，让已打开该流水线的浏览器通过 SSE 重拉 `GET /api/flow`（与手动切换流水线效果一致，但保留 Composer 对话区）。

在终端执行（**必须与系统提示中的 `flowId`、`flowSource`、`端口` 一致**；以下占位符在 Composer 上下文中会给出**可复制的一行命令**）：

```bash
curl -sS -X POST http://127.0.0.1:<PORT>/api/flow-editor-sync \
  -H 'Content-Type: application/json' \
  -d '{"flowId":"<flowId>","flowSource":"user"}'
```

`flowSource` 取值：

- `user`：用户目录 `~/agentflow/pipelines`（或 `AGENTFLOW_HOME`）下的该流水线
- `workspace`：当前项目下 `.workspace/agentflow/pipelines` 下的该流水线（仍会读取旧路径 `.cursor/agentflow/pipelines`）。同项目内 **nodes** 以 `.workspace/agentflow/nodes` 为主（可读 `.cursor/agentflow/nodes`）；**models.json** 以 `.workspace/agentflow/models.json` 为主（可读 `.cursor` 下旧文件）。
- `builtin`：包内 `builtin/pipelines` 模板（只读；若实际写入的是工作区副本，须用 `workspace` 触发刷新）

## 等价的 Node one-liner（无 curl 时）

```bash
node -e "fetch('http://127.0.0.1:<PORT>/api/flow-editor-sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({flowId:'<flowId>',flowSource:'user'})}).then(r=>r.text()).then(console.log)"
```

（将 `<PORT>`、`<flowId>`、`flowSource` 换成实际值。）

## 注意

- 仅 **127.0.0.1** 本地 UI；未启动 UI 时请求会失败，可忽略（Composer 正常结束时前端仍会兜底重拉图一次）。
- 本操作**不**写入 YAML，只触发刷新；请勿用其代替保存文件。

---

## 安装（vercel-labs [skills](https://github.com/vercel-labs/skills)）

在 AgentFlow 仓库根目录：

```bash
npx skills add ./skills --agent cursor --skill agentflow-flow-sync-ui -y
# 或安装本包全部技能：
npx skills add ./skills --agent cursor -y
```

项目内默认 **`.agents/skills/`**；全局加 **`-g`** → **`~/.cursor/skills/`**。
