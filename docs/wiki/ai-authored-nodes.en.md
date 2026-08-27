# Getting AI to author custom nodes

## Why it did not work before

Two halves, each broken.

**The reference AI reads was wrong.** Older `skills/agentflow-node-dsl` versions had long taught
`node.yaml` + `runtime.entry` + `scripts/run.mjs`, and told you to run the retired
`agentflow run` and `marketplace install-node` (which has no effect on code flows). The runtime
had moved to `index.mjs` — declaration and implementation in one file, parsed statically by
acorn. The wiki was updated; the skill was not.

The consequence is worse than "docs are stale": **AI writes whichever format it reads**, and the
resulting package is never scanned, never appears in the palette, and raises no error at all —
the directory simply is not recognised as a node package.

**Node Studio was a complete mockup.** `POST /api/node-studio/draft` stored the prompt and
replied with a hard-coded "requirement recorded, a node Agent will update the manifest, script
and UI schema next"; Test was a 900 ms `setTimeout`; Publish had an empty onClick; the test input
fields were hard-coded `project` / `date` and `readOnly`. Across the whole workspace route table
only two places actually spawn an Agent (`/api/workspace/generate` for display content and
`/api/workspace/node-chat` for editing it). Node generation was not wired at all.

## The loop now

```
describe → Agent writes index.mjs → acorn parses it back → run it for real → publish
```

All four stages sit on **the same path the runtime uses**. No second implementation:

| Stage | Uses |
|---|---|
| Parse the manifest | `readNodePackageManifest` — same as the palette, canvas and cache fingerprint |
| Run the test | `node-package-bootstrap.mjs` — same as executing a node in a Workspace run |
| Publish | `publishNodePackage` — same as `agentflow marketplace publish-node` |

A test that passes in Node Studio but fails on the canvas is worse than no test, so none of the
three is reimplemented.

### Draft layout

```
<userDataRoot>/node-studio/drafts/<id>/
  draft.json        conversation, manifest projection, test record
  package/          the actual package directory
    index.mjs
```

The package lives in a `package/` subdirectory rather than beside `draft.json` because
`publishNodePackage` does a whole-directory `cpSync` — as siblings, draft metadata would ship
inside the published package.

The Agent's `cliWorkspace` *is* that package directory: its working directory is the place it
must write, so no absolute path appears in the prompt and it cannot write elsewhere.

### The manifest is a projection, not a second source of truth

`draft.manifest` is re-parsed from `index.mjs` every time. The draft never keeps a hand-written
copy — a copy would drift from the declaration, and the palette, canvas and runtime all read the
declaration.

On a parse failure the **previous manifest is not kept**; the error goes into `draft.parseError`
and is shown in the preview pane. Keeping the stale manifest would mean debugging against a
contract that no longer exists.

## Publishing requires a clean parse

```
POST /api/node-studio/publish
  → no index.mjs             400 "no index.mjs yet, let the Agent generate one"
  → export default unreadable 400 "export default.inputs.a: literals only, not Identifier"
  → otherwise                 publishNodePackage
```

Publishing a package whose declaration cannot be read means putting an entry in the marketplace
that never shows up in the palette — the failure surfaces when somebody else installs it, far
from the scene.

## Two things the test stage now catches

**Declared output slots that were never written.** Downstream receives nothing and the node says
nothing.

**A `file` slot holding a path instead of content.** A genuinely generated node hit this: asked
for a "dedupe a CSV by column" node, it wrote the result to a path of its own choosing and then
wrote that path as a string into `outputs.outputFile`:

```js
await fs.writeFile(outputPath, csvText);            // written somewhere of its own choosing
await fs.writeFile(outputs.outputFile, outputPath); // slot holds only a path
```

It looks fine in the test — the path does exist. But the slot file is what gets managed as a
product, and in a real run the self-chosen path sits in a temp directory that gets cleaned, so
the product is lost.

Two fixes: the generation prompt states this explicitly, and the test log warns when a `file`
slot's content is an absolute path.

## How the skill is kept from drifting again

`test/node-dsl-skill.test.mjs` does not compare strings — it **feeds the skill's own
example to the real parser**:

1. The first ```js block is written to a temp directory; `readNodePackageManifest` must yield
   `count_lines@1.0.0` with slots `[prev, filePath]` / `[next, total]`, and `run` must be exported
2. The three wrong forms the skill demonstrates (variable reference, spread, member access) must
   actually throw, with a message starting `export default` — a location, not "parse failed"
3. The prose before "别做的事" must not contain a required `node.yaml`, `runtime.entry`,
   `agentflow run` or `install-node`; the "别做的事" section must name all four

Splitting assertion 3 in two matters: scanning the whole file would flag the sentence "do not use
`agentflow run`" as a violation — which amounts to forbidding the skill from warning anyone.

## Still a mockup

These are not wired, and no longer pretend to be:

- **Multi-draft management.** Only a switcher; no create/delete/rename
- **Versions.** Publishing the same `id@version` overwrites, with no conflict warning

Node UI Kit is now wired: code nodes can compose `binding`, `code`, `decision`, `metrics`,
`summary`, and `history` in a literal declaration, and Node Studio and Workspace use the same safe
renderer.
