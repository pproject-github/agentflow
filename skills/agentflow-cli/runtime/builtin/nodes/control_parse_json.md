---
# 内置节点：解析 JSON
runtime: native
type: control
description: 显式解析并校验文本 JSON，成功后输出 json 类型；解析失败会终止本次运行。
displayName: Parse JSON
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: value
    default: ""
    required: true
    showOnNode: true
output:
  - type: node
    name: next
    default: ""
  - type: json
    name: result
    default: "null"
    showOnNode: true
---
Parse a text value as JSON and expose the validated result through a typed output.
