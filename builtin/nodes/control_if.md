---
# 内置节点：If 分支
description: "约定有且仅有一个 type 为 bool 的 input（名称不限，如 prediction）。该值为 true 时沿 next1 继续，为 false 时沿 next2 继续"
displayName: If
input:
  - type: 节点
    name: prev
    default: ""
  - type: bool
    name: prediction
    default: ""
output:
  - type: 节点
    name: next1
    default: ""
  - type: 节点
    name: next2
    default: ""
---
${USER_PROMPT}
