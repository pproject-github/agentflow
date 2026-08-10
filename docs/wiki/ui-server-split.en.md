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

`startUiServer` is still 7,010 lines and 142 routes — that is the next cut; this one only
moved subsystem implementation.

## Keeping the boundary

`test/module-boundaries.test.mjs`, four assertions:

1. The PRD module does not import ui-server (a cycle still runs thanks to function hoisting,
   but initialization order becomes luck)
2. ui-server declares no more `prd*` / `workflow*` top-level symbols
3. The three shared helpers are declared exactly once repo-wide — the classic split mistake
   is leaving a copy on both sides
4. Neither file keeps an unused import

Writing #4 hit its own trap: stripping strings also eats the real call inside the template
`` `href="${htmlEscapeAttribute(x)}"` ``, reporting it as dead. It now does not strip strings
— counting "appears only inside a string" as used is fine, because the assertion is meant to
catch imports that appear *nowhere*, not to do precise reachability analysis.
