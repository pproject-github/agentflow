# Splitting PRD workflow out of ui-server

## Why

`ui-server.mjs` was 20,000 lines holding **two unrelated products**:

| | Lines | Top-level symbols |
|---|---|---|
| Workspace runtime | ~3,900 | 169 `workspace*` |
| PRD workflow | ~4,900 | 197 `prd*` / `workflow*` |
| HTTP routing (one `startUiServer` function) | ~7,000 | 142 routes |
| The rest (auth, teams, model config, terminal…) | remainder | |

The two subsystems share nothing but HTTP routing and auth, yet they shared one diff
surface: changing the Workspace runtime meant navigating 20k lines, and PRD changes rode
along into the same review.

## The coupling was already one-directional

Measure first. The PRD block depended on exactly **4** ui-server internals:

```
htmlEscapeAttribute   used by 11 prd functions
execFileBuffered      1
runtimeEnvForUser     1
readUserWorkspaces    1 (workflowBindableWorkspaces)
```

The other direction had 74, but **almost all called from `startUiServer` alone** — that is
the routing layer, which is supposed to call into subsystems.

So this was not decoupling. It was moving.

## What happened to those 4

- `htmlEscapeAttribute` / `execFileBuffered` each became a small module
  (`html-escape.mjs`, `exec-buffered.mjs`) that both sides import
- `runtimeEnvForUser` moved into `user-env.mjs` — it is a thin wrapper over
  `readMergedEnvObject`, which is where it belonged
- `readUserWorkspaces` is a ui-server state accessor and stayed. Its only PRD consumer,
  `workflowBindableWorkspaces`, is 4 lines and stays behind as the adapter

## The move was scripted, not hand-edited

4,800 lines moved by hand loses things. Instead:

1. Parse the top-level symbol table; each symbol's range **absorbs the comment block
   directly above it** (otherwise JSDoc stays behind)
2. Seed = symbols named `prd*` / `workflow*`, plus `runPrdWorkflowCommand`
3. Take the closure: pull in symbols referenced only by the moving set (0 this time — the
   boundary was already clean)
4. Compute which imports the new file needs and which symbols ui-server must import back
5. Copy the ranges verbatim, adding `export` only where needed

Then verify equivalence: **all 197 symbols compared byte for byte against the original,
allowing only an added `export` prefix**. Result: 0 differences, 0 missing, 0 left behind.

### Two traps along the way

**Multi-line import boundaries.** Both scripts used "last line starting with `import `" as
the end of the import block — but a multi-line import's `import {` line starts that way too.
Once that put the insertion point inside a statement (syntax error, caught immediately);
once it dropped the second half of the import list, leaving
`materializeWorkflowGlobalState` undefined in the new file (HTTP 500, caught by tests). The
anchor has to be a **statement end**: `^(import .* from |\} from )"…";$`.

**Strings while scanning references.** `"x.cache.json"` makes `json` look like a dependency.
Strip quoted strings before scanning; the two survivors (an object key `json: ""` and a
`--json` flag inside a template) were each read before being whitelisted.

## Result

```
ui-server.mjs          20,609 -> 15,789   (-23%)
prd-workflow-server.mjs         4,884
html-escape.mjs / exec-buffered.mjs   19 + 32
```

Plus 13 imports that nobody used after the move (two of them,`getFlowYamlAbs` and
`FLOW_YAML_FILENAME`, left over from the previous directory-marker change).

## Second cut: the routes follow

With the implementation gone, `startUiServer` still held the subsystem's 31 routes — 2,765
lines, 40% of that 7,000-line request callback. This cut moves them into
`prd-workflow-routes.mjs`.

The difficulty is that route bodies are **closure code**: they reference `url` / `userCtx`
from the request callback and call `json(res, …)` directly. Moving them naively means either
rewriting every line or giving up byte-for-byte verifiability. Two conventions avoid that:

**Whether a route matched is read from `res.headersSent`.** Every `return;` in a route body
stays exactly as written — in place it already meant "response sent, stop here". Outside:

```js
export async function handlePrdWorkflowRoutes(req, res, ctx) {
  await prdWorkflowRoutes(req, res, ctx);
  return res.headersSent;
}
```

Rewriting `return;` into `return true` would require deciding, one by one, which `return`s
sit inside nested callbacks — exactly where this kind of move goes wrong.

**Closure variables are destructured back into identically named identifiers.**

```js
async function prdWorkflowRoutes(req, res, ctx) {
  const { url, authUser, userCtx, root, host, uiPort, resolveWorkspaceScopeRoot, … } = ctx;
```

So the bodies read the same as before. That destructuring line is the route layer's **real
coupling surface** to ui-server — 18 names: 6 request-context values (`url`, `authUser`,
`userCtx`, `root`, `host`, `uiPort`) and 12 functions both sides use. `json` / `readBody` are
not among them; they became `http-util.mjs`, imported under the same names on both sides.

18 is a lot, but it is the coupling that exists today, and spelled out beats hidden in a
closure — whoever wants to shrink it can read that one line to see what to attack.

### Ordering safety has to be proven first

The move hoists 31 routes scattered across positions 5–36 up to position 5. That changes
match precedence unless:

- no non-PRD route in between matches by prefix or regex (checked: 0)
- no (method, path) pair is duplicated across the PRD and non-PRD groups (checked: 4
  duplicates among 140 routes, all within a group)

Both hold, so hoisting is safe.

### Result

```
ui-server.mjs          15,789 -> 12,780
prd-workflow-routes.mjs         2,949
startUiServer           7,010 ->  4,251
```

All 31 route blocks compared byte for byte: 31/31 appear verbatim in the new file, 0 left in
ui-server. Plus 95 imports nobody used after the move.

Seven helpers used only by these routes travelled with them (119 lines). Four more could
have: `serverPublicBaseUrl`, `resolvePrdWorkflowScope`, `workflowBindableWorkspaces` and
`prepareWorkflowKnowledgeWorktrees` themselves use ctx-provided dependencies, and a moved
helper sits at module top level where the destructuring inside the route function is not
visible. That rule lives in the script, not in someone's memory — the first run without it
produced a `normalizePublicBaseUrl is not defined` 500.

`startUiServer` is down to 4,251 lines and 121 routes — the 27 `/api/workspace` routes are
the next candidate.

## Keeping the boundary

`test/module-boundaries.test.mjs`, five assertions:

1. Neither the implementation nor the routes module imports ui-server (a cycle still runs
   thanks to function hoisting, but initialization order becomes luck)
2. No PRD path literal is left in ui-server and there is exactly one dispatch point — a
   second one means routes are creeping back
3. ui-server declares no more `prd*` / `workflow*` top-level symbols
4. The three shared helpers are declared exactly once repo-wide — the classic split mistake
   is leaving a copy on both sides
5. Neither file keeps an unused import

Writing the last one hit its own trap: stripping strings also eats the real call inside the template
`` `href="${htmlEscapeAttribute(x)}"` ``, reporting it as dead. It now does not strip strings
— counting "appears only inside a string" as used is fine, because the assertion is meant to
catch imports that appear *nowhere*, not to do precise reachability analysis.
