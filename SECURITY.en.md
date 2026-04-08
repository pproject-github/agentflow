# Security Policy

[中文](./SECURITY.zh-CN.md) | **English**

## Supported Versions

| Version | Supported |
| ------- | --------- |
| Latest main branch | ✅ Receives security updates |
| Older versions | ❌ Not maintained separately |

## Reporting a Vulnerability

If you discover a security vulnerability, please **do not** disclose it in a public GitHub Issue.

Report it privately via:

1. **GitHub Security Advisories**: Use the [private vulnerability reporting feature](https://github.com/bigo-sg/agentflow/security/advisories/new)
2. Or contact the maintainers directly

We will acknowledge and assess the impact as soon as possible.

## Security Practices

### Secret Management

- **Never hardcode API keys, passwords, or tokens in code**
- Use `GetEnv` nodes to read sensitive configurations from environment variables or `~/.cursor/config.json`
- See [flow-control-capabilities.md](reference/flow-control-capabilities.md) for environment variable injection methods

### Flow Execution

- AgentFlow invokes Cursor CLI (`agent`) or OpenCode CLI (`opencode`) during execution
- Ensure these CLI tools' permissions meet your security requirements
- Review script content in flow nodes before execution

### MCP Servers

- Cursor MCP auto-approval is enabled by default (`--approve-mcps`)
- To disable, set environment variable `AGENTFLOW_CURSOR_APPROVE_MCPS=0`

## Security Fix History

(No disclosed security fixes yet)