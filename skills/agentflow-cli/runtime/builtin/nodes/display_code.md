---
# 内置节点：代码展示
runtime: native
description: Display source code with language highlighting, line numbers, copy, wrap, and download controls; passes content downstream as text
displayName: Code Display
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: content
    default: ""
    required: true
    showOnNode: true
  - type: text
    name: language
    default: ""
    description: Syntax language such as javascript, typescript, python, kotlin, java, shell, json, yaml, html, css, or sql
    showOnNode: false
  - type: text
    name: fileName
    default: ""
    description: Optional file name used when downloading
    showOnNode: false
  - type: bool
    name: wrap
    default: "false"
    description: Wrap long source lines by default
    showOnNode: false
output:
  - type: text
    name: content
    default: ""
    showOnNode: true
  - type: node
    name: next
    default: ""
---
${content}
