---
# Built-in node: Image Display
runtime: native
description: Display an image URL, data URL, or image path in workspace canvas; passes source downstream as text
displayName: Image Display
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: src
    default: ""
    required: true
    showOnNode: true
  - type: file
    name: filePath
    default: ""
    showOnNode: false
  - type: text
    name: alt
    default: ""
    showOnNode: false
  - type: text
    name: workspaceContext
    default: ""
    showOnNode: false
output:
  - type: text
    name: src
    default: ""
    showOnNode: true
  - type: node
    name: next
    default: ""
---
${src}
