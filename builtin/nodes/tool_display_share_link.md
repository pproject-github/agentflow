---
# Built-in node: create share link for Display nodes
description: Create a public share link for upstream Display nodes
displayName: Display Share Link
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: title
    default: ""
    description: "可选。分享页标题；只影响打开分享页后的页面标题，不影响输出 URL。为空时使用 AgentFlow Display。"
    showOnNode: true
  - type: text
    name: layout
    default: "single"
    description: "可选。分享页布局：single、gallery、slides、document、canvas。通常保持默认 single。"
    showOnNode: false
  - type: text
    name: nodeIds
    default: ""
    description: "可选。逗号或空格分隔的 Display 节点 ID；为空时自动分享连接到本节点的上游 Display 节点。"
    showOnNode: false
  - type: text
    name: baseUrl
    default: ""
    description: "可选。分享站点地址，例如 https://agentflow.example.com；为空时优先使用环境变量，其次使用当前访问地址。"
    showOnNode: false
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: url
    default: ""
    showOnNode: true
  - type: text
    name: shareId
    default: ""
    showOnNode: false
  - type: text
    name: expiresAt
    default: ""
    showOnNode: false
---
Create a share link for connected Display nodes. Connect a Display node to this node, optionally set title, and use the url output.
