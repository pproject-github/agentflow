# Security Policy

## 支持的版本

| 版本 | 支持状态 |
|------|----------|
| 最新主分支 | ✅ 接收安全更新 |
| 旧版本 | ❌ 不单独维护 |

## 报告安全漏洞

如果你发现了安全漏洞，请**不要**在公开的 GitHub Issue 中披露。

请通过以下方式私下报告：

1. **GitHub Security Advisories**：使用 [GitHub 私下报告漏洞功能](https://github.com/bigo-sg/agentflow/security/advisories/new)
2. 或直接联系维护者

我们会在收到报告后尽快确认并评估影响范围。

## 安全实践

### 密钥管理

- **不要在代码中硬编码 API 密钥、密码或 token**
- 使用 `GetEnv` 节点从环境变量或 `~/.cursor/config.json` 读取敏感配置
- 参考 [flow-control-capabilities.md](reference/flow-control-capabilities.md) 了解环境变量注入方式

### 流程执行

- AgentFlow 执行时会调用 Cursor CLI (`agent`) 或 OpenCode CLI (`opencode`)
- 确保这些 CLI 工具的权限配置符合你的安全要求
- 审查 flow 中节点执行的脚本内容

### MCP 服务器

- 默认启用 Cursor MCP 自动批准 (`--approve-mcps`)
- 如需关闭，设置环境变量 `AGENTFLOW_CURSOR_APPROVE_MCPS=0`

## 历史安全修复

（暂无已披露的安全修复记录）
