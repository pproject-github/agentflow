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
    description: "分享页标题；为空时使用 AgentFlow Display。"
    showOnNode: true
  - type: text
    name: layout
    default: "single"
    description: "分享布局：single、gallery、slides、document、canvas。"
    showOnNode: true
  - type: text
    name: nodeIds
    default: ""
    description: "可选。逗号或空格分隔的 Display 节点 ID；为空时自动使用连接到本节点的上游 Display 节点。"
    showOnNode: false
  - type: text
    name: baseUrl
    default: ""
    description: "可选。输出绝对链接的站点地址，例如 https://agentflow.example.com；为空时输出 /display/<id>。"
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
Create a share link for connected Display nodes.
