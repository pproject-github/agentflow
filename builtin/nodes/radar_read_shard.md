---
# 内置节点：读雷达分片
runtime: native
type: control
description: |
  读同一块雷达板上**另一条流程**那一片的原始条目，作为本流程的输入。

  子流程要基于父表做自己的状态梳理，就需要先拿到父表。跨片**只读**：这个节点
  不写任何东西，也读不到板的合并视图——合并视图会把 `unknown` 归一成 `idle`，
  再写回去就是把「没查出来」伪造成「没什么可报告的」。

  依赖因此是图上的一条边，而不是藏在某个 tool_nodejs 的命令行里：谁读谁的产出
  在画布上看得见，lint 查得到，人批准图的时候就批准了这条依赖。
displayName: 读雷达分片
ui:
  card:
    template: details
    icon: table_view
    tone: blue
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: board
    default: ""
  - type: text
    name: shard
    default: ""
output:
  - type: node
    name: next
    default: ""
  - type: json
    name: rows
    default: ""
---
Read another flow's shard on the same radar board as read-only input.
