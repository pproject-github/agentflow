---
# 内置节点：任一满足
description: 当任一上游输入就绪（success）时，沿 next 继续执行。
displayName: AnyOne
input:
  - type: 节点
    name: prev1
    default: ""
  - type: 节点
    name: prev2
    default: ""
output:
  - type: 节点
    name: next
    default: ""
---
${USER_PROMPT}
