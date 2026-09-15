---
# 内置节点：读雷达板词典
runtime: native
type: control
description: |
  读一块雷达板的**词典**：状态怎么念、有哪几个大组、标签只能挑哪些、字段叫什么名字。

  写板的流程需要知道这些，否则只能在自己的提示词里抄一份。抄一份的后果是：
  改一个大组要去编辑流程源码，两条流程各抄一份就会拼出两个同名的组，
  而板上真正生效的那份在 `_board.json` 里——三份真相，没人知道该信谁。

  词典由建板的 AI 写进 `spec`，流程从这里读，页面照它渲染。三方看的是同一份。

  只读：这个节点不写任何东西。
displayName: 读雷达板词典
ui:
  card:
    template: details
    icon: menu_book
    tone: blue
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: board
    default: ""
output:
  - type: node
    name: next
    default: ""
  - type: json
    name: vocab
    default: ""
---
Read a radar board's vocabulary (states, themes, tags, field labels) as read-only input.
