---
# Built-in node: WeCom direct markdown message
runtime: native
description: Send Markdown message to WeCom users through an enterprise application
displayName: WeCom Direct Markdown
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: markdown
    default: ""
    required: true
    description: "企业微信应用消息 markdown.content。请输出企业微信 Markdown 正文，不要包裹 agentflow envelope 或额外解释；适合通知、告警、任务摘要等个人消息。"
    showOnNode: true
  - type: text
    name: toUser
    default: ""
    required: true
    description: "接收人企业微信 userid；多个用户用 | 分隔，@all 表示全部。"
    showOnNode: true
  - type: text
    name: corpId
    default: ""
    showOnNode: false
  - type: text
    name: corpSecret
    default: ""
    showOnNode: false
  - type: text
    name: agentId
    default: ""
    showOnNode: false
  - type: text
    name: accessToken
    default: ""
    showOnNode: false
output:
  - type: node
    name: next
    default: ""
  - type: bool
    name: sent
    default: ""
    showOnNode: true
  - type: text
    name: message
    default: ""
    showOnNode: false
  - type: text
    name: response
    default: ""
    showOnNode: false
---
Send `${markdown}` to one or more WeCom users (`${toUser}`) using a WeCom enterprise application.

If credential inputs are empty, AgentFlow reads `WECOM_CORP_ID`, `WECOM_APP_SECRET` / `WECOM_CORP_SECRET`, `WECOM_AGENT_ID`, and optionally `WECOM_TO_USER` from environment config.
