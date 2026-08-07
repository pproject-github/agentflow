---
# 内置节点：执行 Node.js
description: |
  Execute a Node.js script. The Workspace runtime spawns the command directly — no agent involved.

  **Success/Failure:** Determined by the script process **exit code** — 0 = success, non-0 = failed.
  **Result Output:** Script stdout becomes the `result` slot content (plain text, e.g. `console.log("hello")`).
  When stdout is empty and the exit code is non-0, stderr is written to the failure message.
  Do **not** wrap stdout in a JSON envelope.

  **Script placeholders:** `script` (inline) or `scriptRef` (file) support `${}` placeholders —
  `workspaceRoot` / `pipelineWorkspace` / `flowDir` (all three resolve to the scoped workspace root),
  `cwd`, `nodeRunDir`, `nodeTmpDir`, `outputsDir`, `scriptRef`, plus every input and output slot name.
  Values are auto shell-quoted, so do not add your own quotes.
  Example: `script: node ${flowDir}/scripts/my-check.mjs --root ${workspaceRoot} --input ${todo}`

  **Pin Path Constraint (Important):** File paths read/written by the script **must be passed via pins**;
  never construct output paths inside the script.
  - Input slots of type `file` are resolved from upstream connections; the script receives them as CLI args.
  - Output slots of type `file` are resolved to absolute paths by the runtime; the script writes to them directly.
  - Reference them with `${slotName}` in `script`, e.g. `--figma-tree ${figma_tree} --output ${restore_todolist}`.
  - **Forbidden** to invent output paths inside the script — downstream nodes will not find the files.

  **Scripts under `scripts/` must be referenced as `${flowDir}/scripts/xxx.mjs`.**
displayName: NodeJs
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: workspaceContext
    default: ""
    required: true
    showOnNode: true
  - type: text
    name: skillsContext
    default: ""
  - type: text
    name: mcpContext
    default: ""
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: result
    default: ""
    required: true
    showOnNode: true
---
${USER_PROMPT}
