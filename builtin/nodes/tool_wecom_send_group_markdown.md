---
# Built-in node: WeCom group robot markdown message
description: Send Markdown message to a WeCom group robot webhook
displayName: WeCom Group Chat Markdown
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: markdown
    default: ""
    required: true
    description: "企业微信机器人 markdown.content。请输出企业微信 Markdown 正文，不要包裹 agentflow envelope 或额外解释；支持标题、列表、链接、引用、代码等企业微信 Markdown 子集。"
    showOnNode: true
  - type: text
    name: webhookUrl
    default: ""
    description: "企业微信群机器人完整 webhook 地址。可以只填 webhookKey。"
    showOnNode: true
  - type: text
    name: webhookKey
    default: ""
    description: "企业微信群机器人 key，用于拼出 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
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
Send `${markdown}` to a WeCom group chat through a group robot webhook.

Use either `webhookUrl` or `webhookKey`. If both are empty, AgentFlow reads `WECOM_GROUP_WEBHOOK` / `WECOM_BOT_WEBHOOK` or `WECOM_GROUP_WEBHOOK_KEY` / `WECOM_BOT_KEY` from environment config.
