# AgentFlow Flow DSL — 内置节点调用表

> Generated from `builtin/nodes/*.md` by `scripts/generate-agentflow-skill-references.mjs`.
> 只列 `runtime: native` 的节点——其余类型 lint 会直接报错。

`prev` / `next` / `next1` / `next2` 是控制引脚，由 `flow()` 自动接，**不要手写**。

| 调用 | 输入引脚 | 输出引脚 |
|------|----------|----------|
| `agent.subAgent` | context:context, workspaceContext:text, skillsContext:text, mcpContext:text, knowledgeContext:text | result:text |
| `context.bundle` | knowledgeContext:text, skillsContext:text, workspaceContext:text, mcpContext:text | context:context |
| `context.knowledge` | workspaceIds:json | knowledgeContext:text |
| `context.skills` | skills:json | skillsContext:text |
| `context.workspace` | workspaceId:text, access:text | workspaceContext:text |
| `control.cdWorkspace` | path:text, label:text, knowledgeContext:text, workspaceContext:text | knowledgeContext:text, workspaceContext:text, cwd:file |
| `control.if` | prediction:bool | — |
| `control.loadMcp` | serverNames:text | mcpContext:text |
| `control.loadSkills` | skillKeys:text | skillsContext:text |
| `control.parseJson` | value:text | result:json |
| `control.userWorkspace` | — | workspaceContext:text, cwd:file |
| `control.while` | context:context, state:json, maxIterations:text, timeout:text | result:json, state:json, decision:text, iterations:text, summary:text, history:json, checkpointFingerprint:text |
| `display.ascii` | content:text | content:text |
| `display.chart` | content:text, filePath:file, workspaceContext:text | content:text |
| `display.code` | content:text, language:text, fileName:text, wrap:bool | content:text |
| `display.html` | content:text, filePath:file, workspaceContext:text | content:text |
| `display.image` | src:text, filePath:file, alt:text, workspaceContext:text | src:text |
| `display.markdown` | content:text | content:text |
| `display.mermaid` | content:text | content:text |
| `display.reactApp` | content:text, filePath:file, workspaceContext:text | content:text |
| `display.table` | content:text, filePath:file, workspaceContext:text | content:text |
| `provide.bool` | — | value:bool |
| `provide.file` | — | value:file |
| `provide.json` | — | value:json |
| `provide.password` | — | value:text |
| `provide.str` | — | value:text |
| `tool.displayShareLink` | title:text, layout:text, nodeIds:text, baseUrl:text | url:text, shareId:text, expiresAt:text |
| `tool.gitCheckout` | repoUrl:text, branch:text, targetDir:text, pullIfExists:bool, includeSubmodules:bool, remote:text, workspaceContext:text | repoPath:file, branch:text, commit:text, changed:bool, workspaceContext:text, gitContext:text |
| `tool.gitlabCreateMr` | repoPath:file, gitContext:text, workspaceContext:text, sourceBranch:text, targetBranch:text, title:text, description:text, draft:bool, labels:text, push:bool, remote:text, tokenEnv:text, gitlabApiBase:text, removeSourceBranch:bool, squash:bool | mrUrl:text, created:bool, mrIid:text, projectId:text, sourceBranch:text, targetBranch:text, title:text, message:text |
| `tool.gitWorktreeLoad` | repoPath:file, branch:text, worktreePath:file, pruneMissing:bool, force:bool, gitContext:text, workspaceContext:text | worktreePath:file, branch:text, commit:text, workspaceContext:text, gitContext:text |
| `tool.gitWorktreeUnload` | repoPath:file, worktreePath:file, gitContext:text, workspaceContext:text, force:bool, prune:bool | removed:bool, workspaceContext:text, message:text |
| `tool.jenkinsBuild` | job:text, parameters:text, credentialRef:text, pollInterval:text, timeout:text | status:text, url:text, qrUrl:text |
| `tool.nodejs` | workspaceContext:text, skillsContext:text, mcpContext:text | result:text |
| `tool.setRunEnv` | key:text, value:text, variables:text | keys:text, count:text |
| `tool.wecomSendAppMarkdown` | markdown:text, toUser:text, corpId:text, corpSecret:text, agentId:text, accessToken:text | sent:bool, message:text, response:text |
| `tool.wecomSendGroupMarkdown` | markdown:text, webhookUrl:text, webhookKey:text | sent:bool, message:text, response:text |
| `workspace.oneClickTask` | skillKeys:text, includeWorkspaceContext:bool, displayType:text, knowledgeContext:text, workspaceContext:text | content:text, displayType:text |
| `workspace.run` | — | — |
| `workspace.scheduledRun` | — | — |
