# Code node packages

A code node is a **directory** whose `index.mjs` carries both the declaration and the
implementation. The directory can live inside a flow (`<flowDir>/nodes/<name>/`) or be
published to the marketplace.

```js
// nodes/count-lines/index.mjs
import fs from "node:fs/promises";

export default {
  id: "count_lines",              // required — forms marketplace:count_lines@1.0.0
  version: "1.0.0",               // required
  name: "统计行数",
  description: "读一个文本文件，统计行数",
  inputs:  { filePath: { type: "text", description: "文件路径", required: true } },
  outputs: { total: { type: "text" } },
};

export async function run(inputs, outputs, dirs) {
  const text = await fs.readFile(inputs.filePath, "utf-8");
  await fs.writeFile(outputs.total, String(text.split("\n").length));
  console.log(`共 ${text.split("\n").length} 行`);   // 进度日志，不会盖掉 outputs.total
}
```

## Why the declaration must be a pure literal

`export default` is read by **acorn static parse** — listing the palette, rendering the
canvas, and validating slots never execute package code. Running third-party code during a
directory scan is both slow and unsafe, so this is a hard constraint, not a style choice.

The cost is that the declaration cannot contain variable references, function calls, or
spreads. Violations fail with a located error:

```
export default.id: 只允许字面量，不允许 Identifier
```

rather than silently degrading to an empty manifest that makes the node vanish from the
palette.

`node.yaml` still works as a fallback, so already-published packages are unaffected.

Publishing reads the manifest the same way: `agentflow marketplace publish-node <dir>` accepts an
`index.mjs` package, with no separate `node.yaml` to keep in sync.

## Slots

`inputs` / `outputs` are **ordered maps**: slot order equals declaration order, with the
control slot (`prev` / `next`) prepended automatically. This matters — graph edges use
positional handles (`input-0`, `output-1`), so reordering the declaration rewires the graph.

Types: `text`, `file`, `bool`, `node`, `image`, `json`. Anything else is an error.

## `run(inputs, outputs, dirs)`

| Argument | Contents |
|----------|----------|
| `inputs` | slot name → value from upstream |
| `outputs` | slot name → **absolute path to write** (not a value) |
| `dirs` | `workspaceRoot` / `nodeRunDir` / `nodeTmpDir` / `outputsDir` |

`outputs.total` is a path, not a value — the single easiest thing to get wrong.

Failure is a thrown error or a non-zero exit; there is no other protocol.

## How outputs reach the slots

Every declared output slot gets its own file; whatever you write lands in that slot. The
**first non-control output slot** carries the node's result body — first *non-control*, not
index 0: the canonical order is `[next, total]`, so index 0 is the control slot. That rule
used to be written six times across ui-server, each spelled `index === 0`, so an output slot
not named `result` / `content` was treated as the result when writing files and not
recognised as the result when filling slots — the value fell between the two. It is one
function now.

**stdout only becomes the result body when the result slot has no file.** Writing a file is a
deliberate act while `console.log` is often just progress; letting a print clobber a write is
surprising, and the example above does both.

Whether a downstream node sees the **content** or the **path** depends on the target slot
type: `text` slots read the file, `file` / `image` slots keep the path.

## Why a bootstrap is needed

`index.mjs` is a **module**, not a script. Running `node index.mjs` evaluates the
declaration and exits — `run` is never called.

So packages whose manifest carries `runtime.mode = "module"` get this command instead:

```
node bin/lib/node-package-bootstrap.mjs <packageDir>/index.mjs
```

The bootstrap translates the runtime's environment contract
(`AGENTFLOW_INPUTS_JSON` / `AGENTFLOW_OUTPUTS_ABS_JSON` / `AGENTFLOW_NODE_RUN_DIR` …) into
the three `run()` arguments. The entry-path containment check runs before this branch, so
an out-of-package `entry` is still rejected.

## Resolution order

When resolving `marketplace:<id>@<version>`:

1. `<flowDir>/nodes/*/` — the flow's own implementation
2. `<workspace>/marketplace/packages/nodes/<id>/<version>/` — published packages
3. Dependent collections

**A flow's local implementation is never shadowed by a same-named published package.**
Conversely, a version pinned in `agentflow.lock.json` still wins: on a version mismatch the
local package is skipped rather than wrongly matched.

## See also

- Single source of truth for builtin node definitions: [node-definitions.en.md](node-definitions.en.md)
- Tests: `test/node-package-runtime.test.mjs` (static parse + bootstrap execution),
  `test/node-package-graph-hydration.test.mjs` (full HTTP path)
