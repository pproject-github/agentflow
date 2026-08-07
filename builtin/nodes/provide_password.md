---
# Built-in node: directly provide a hidden password/secret value
runtime: native
description: Provide a secret text value without showing it on the node card
displayName: Password
input: []
output:
  - type: text
    name: value
    default: ""
    required: true
    showOnNode: true
---
${USER_PROMPT}
