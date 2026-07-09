---
# Built-in node: set environment variables for the current run only
description: Set environment variables for downstream nodes in the current workspace run
displayName: Set Run Env
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: key
    default: ""
    description: "单个环境变量名，例如 IMAP_USER。"
    showOnNode: true
  - type: text
    name: value
    default: ""
    description: "单个环境变量值。"
    showOnNode: true
  - type: text
    name: variables
    default: ""
    description: "批量设置，支持多行 KEY=VALUE 或 JSON object。"
    showOnNode: false
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: keys
    default: ""
    showOnNode: false
  - type: text
    name: count
    default: ""
    showOnNode: false
---
Set environment variables for downstream nodes in this run only.
