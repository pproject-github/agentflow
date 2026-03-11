# AgentFlow 图与 USER_PROMPT 的读写一致性检查

本文档供 AI 参考：对流程图的**语义检查**——${USER_PROMPT} 中描述的「读取」「写入」应与图中的 **handler 节点**（即带 input/output 槽位且通过 edge 连线的节点）一一对应。

---

## 约定

- **USER_PROMPT**：用户或上游在流程中注入的「需求描述」或「本节点说明」，常出现在 provide_str / provide_file、control_start 等节点的正文中，或作为流程级需求。
- **Handler 节点**：在 flow 中通过 **input/output 槽位** 与其它节点用 **edge** 连接、参与数据流的节点。不含 provide_*、control_start、control_end 等「仅作为源/汇」的节点时，通常指会「读入」或「写出」数据的 agent/tool/control 节点。
- **读取**：某节点**消费**某数据 → 对应其 **input** 槽位上有 **入边**（target 为该节点，targetHandle 为该 input）。
- **写入**：某节点**产出**某数据 → 对应其 **output** 槽位上有 **出边**（source 为该节点，sourceHandle 为该 output）。
