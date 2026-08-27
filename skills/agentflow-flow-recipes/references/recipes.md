# AgentFlow Workspace Graph Recipes

These recipes are written in `workspace.flow.js` form — the authoritative representation of a
Workspace graph. Syntax reference: **agentflow-flow-dsl**. The old
`control_start → … → control_end` pipeline recipes are retired; see the note at the end.

Every pin name below comes from `builtin/nodes/*.md`; the full call table is
[node-calls.md](../../agentflow-flow-dsl/references/node-calls.md). Run
`agentflow flow dsl lint <flowDir>` after editing — a wrong pin name is an error, not a warning.

## Git Project Analysis

Clone/pull a repository, enter it, ask an agent what it does, show the result.

```js
import { agent, control, display, flow, tool } from "agentflow/flow";

const checkout = tool.gitCheckout("拉取仓库", {
  repoUrl: "https://example.com/team/repo.git",
  pullIfExists: "true",
});

const cd = control.cdWorkspace("进入仓库", {
  path: ".",
  workspaceContext: checkout.workspaceContext,
});

const skills = control.loadSkills("加载 Skills", {
  skillKeys: `["global-codex:code-reading"]`,
});

const analyse = agent.subAgent("解读仓库", {
  workspaceContext: cd.workspaceContext,
  skillsContext: skills.skillsContext,
}, `读 README、构建文件、源码目录和入口，说明这个仓库是做什么的、怎么跑起来。`);

const report = display.markdown("分析结果", { content: analyse.result });

export const run = flow("Run", checkout, cd, skills, analyse, report);
```

What the data edges do:

- `checkout.workspaceContext → cd.workspaceContext` — hands the checked-out path to CD
- `cd.workspaceContext → analyse.workspaceContext` — tells the agent which directory it is in
- `skills.skillsContext → analyse.skillsContext` — injects the selected skills

Watch out:

- `control.cdWorkspace` takes `path`, not `target`; `control.loadSkills` takes `skillKeys`
  (a JSON array of `collection:skill`), not `source`
- `control.loadSkills` has no `workspaceContext` input — do not try to chain context through
  it; feed the agent from `cd` directly
- Do not wire `checkout.repoPath` (a `file`) into `cd.path` (a `text`)
- Private repositories need working local credentials

## Show A Result

Feed the producing pin into a `display.*` node:

```js
const shown = display.markdown("结论", { content: analyse.result });
```

Pick the type that matches the payload: `display.markdown`, `.html`, `.table`, `.chart`,
`.mermaid`, `.ascii`, `.image`, `.reactApp`.

An agent with an extra output pin must be declared by destructuring, and its prompt must emit
the output envelope:

```js
const { storyId } = breakdown;
const notify = tool.wecomSendAppMarkdown("通知", { markdown: breakdown.result, toUser: storyId });
```

## Branching

`control.if` is the branch primitive. Its `prediction` input is a `bool`:

```js
const passed = provide.bool("是否发布", { value: "true" });
const gate = control.if("是否发布", { prediction: passed.value },
  flow(publish, notifySuccess),
  flow(rollback, notifyFail),
);
export const run = flow("Run", passed, gate);
```

The taken branch runs and the other is skipped. **Branches cannot rejoin** — fan-in is
forbidden and `control_anyOne` has no runtime implementation. Let each branch finish on its own.

`control.agentToBool` also produces a `prediction`, but it is `runtime: degraded`: nothing
constrains the model's answer and `parse-bool` accepts only exactly `true` / `1` / `yes` / `on`.
If you use it, the prompt must say "只回 true 或 false，多一个字都会被判成 false".

## No Loops

The run planner rejects cyclic graphs (`Workspace run graph contains a cycle`). Express
"check → fix → re-check" as forward steps, or put the retry loop **inside** one node — the
agent's body, a `tool.nodejs` script, or a code node under `nodes/<name>/index.mjs`. Never
draw an edge from a downstream node back to an upstream one.

## Edit The Graph

- Structure, nodes, edges, full syntax and node calls: **agentflow-flow-dsl**
- Node implementations in code: `nodes/<name>/index.mjs`, see **agentflow-flow-dsl**

Saving is handled by the Workspace API; there is no separate canvas-sync step.

## Retired

`control_start`, `control_end`, `control_anyOne`, `control_toBool`, `control_interval_loop`,
`control_delay`, `control_wait_until`, `control_cancelled`, `tool_user_check`, `tool_user_ask`,
`tool_print`, `tool_load_key`, `tool_save_key`, `tool_get_env` and `tool_jenkins_build` only
ever ran under the retired Start/End runtime. They are not in the node palette and lint
rejects them — do not generate them.
