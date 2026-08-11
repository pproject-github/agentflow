# What makes a directory a flow

## The old answer: `flow.yaml` exists

Once the Start/End Pipeline execution stack was retired, the *contents* of `flow.yaml` were
dead. Its *existence* was still load-bearing:

```js
// catalog-flows.mjs
.filter((e) => fs.existsSync(path.join(dirPath, e.name, "flow.yaml")))
```

That line was written out about a dozen times — in `auth.mjs`, `paths.mjs`, `workspace.mjs`,
`flow-write.mjs`, `marketplace.mjs`, `catalog-agents.mjs`, `admin-builtin-pipelines.mjs`,
`ui-server.mjs`. A directory without `flow.yaml` did not exist as far as listing, path
resolution, rename or archive were concerned — even with a complete `workspace.flow.js` in it.

Which is why creating a flow still wrote a hollow yaml, purely so the directory would
"exist". That is not a design; that is a legacy artifact grown into a load-bearing wall.

## The new answer: any one of three marker files

One judge in `paths.mjs`, nowhere else:

```js
export const FLOW_MARKER_FILENAMES = ["workspace.flow.js", "workspace.graph.json", "flow.yaml"];
export function isFlowDir(dir) { return flowMarkerPath(dir) !== ""; }
```

The order is the authority order: code > read-only legacy JSON > retired yaml.

## Two couplings undone along the way

**Directory resolution vs. yaml resolution.** `getFlowYamlAbs` used to be the only entry
point: it walked user → workspace → legacy looking for a directory, then appended
`/flow.yaml`. But most callers immediately did `path.dirname(...)` to strip the filename back
off — the directory was what they wanted all along. So "rename this flow", an operation with
nothing to do with yaml, was gated on yaml existing.

Now there are two:

- `resolveFlowDirAbs(...)` → the directory, existence judged by `isFlowDir`
- `getFlowYamlAbs(...)` → directory + `/flow.yaml`, **only for callers that really read yaml**

Rename, archive, delete and schedule resolution all moved to the former.

**The list description.** It could previously only be read from `ui.description` in
`flow.yaml`. In a code-based graph, `ui.description` is passed through by `extractLayout` to
the top level of `workspace.layout.json` on every round trip, so
`readPipelineListDescription` checks layout first and falls back to yaml. When both exist,
code wins.

## Result: new flows are born as code

`createEmptyFlow` replaces `buildEmptyUserFlowYaml` + `writeFlowYaml`. Creating a flow gives
you:

```
workspace.flow.js      an empty graph — one import line
workspace.layout.json  { version, description }
```

No `flow.yaml`. The two built-in templates dropped their shells too.

## The Hub side is untouched

The wire format still requires `flow.yaml` in the package — `flow-import.mjs` rejects a
package without it, and the download side keys on it too. So `agentflow publish`
**synthesizes a description-only yaml shell** when packaging a code-based flow; the real
graph still ships as `workspace.flow.js`, and `isFlowDir` prefers the code on the way back in.

That is a bridge, not a destination. Making yaml disappear entirely means changing both ends
of the Hub protocol.

## Where flow.yaml is still read

These genuinely read yaml *content* rather than using it as a sentinel, so they stay:

| Place | What for | Behaviour for a code-based flow |
|-------|----------|---------------------------------|
| `flow-import.mjs` / `hub-remote.mjs` | Hub package format | See above — publish synthesizes a shell |
| `marketplace.mjs` install-node | Writes node deps into flow.yaml | No effect on code flows; should write an import instead |
| ~~`main.mjs` `flow preview`~~ | Old static preview | **Removed** — it injected raw flow.yaml into the page and code flows have no yaml to inject; the web `/api/workspace/preview` takes a graph object and was already format-agnostic |
| `catalog-flows.mjs` `readFlowJson` | Reads the legacy graph | Only reached when there is no Workspace graph |
