---
name: agentflow-author-flow
description: Generate or revise an AgentFlow flow locally from a natural-language request, validate its flow.yaml, open a single-file platform-style preview, and publish it to personal, workspace, or team scope after user confirmation. Use when a user asks Codex, Cursor, Claude Code, or another coding agent to create, draw, preview, sync, upload, or publish an AgentFlow flow without using AI Composer or manually dragging nodes.
---

# Author an AgentFlow

Turn the user's request into a locally reviewable Flow and handle the commands on their behalf. Do not ask the user to run preview or publish commands.

## Required references

Before creating or changing node schemas or edges, read:

- [Builtin node schemas](../agentflow-node-reference/references/builtin-nodes.md)
- [Control capabilities](../../reference/flow-control-capabilities.md)
- [Flow layout](../../reference/flow-layout.md)

Read [prompt and handler checks](../../reference/flow-prompt-handler-check.md) when the Flow contains agent nodes. Read [standard recipes](../agentflow-flow-recipes/references/recipes.md) when a recipe matches the request.

## Workflow

1. Convert the request into a short node plan. Ask only for a business choice that materially changes behavior; do not ask for YAML details.
2. Choose a stable lowercase flow ID using letters, digits, hyphens, or underscores.
3. Create the draft at `.workspace/agentflow/pipelines/<flow-id>/flow.yaml`. Start from the packaged `builtin/pipelines/new/flow.yaml` when available. Preserve any unrelated workspace files.
4. Build nodes from authoritative definitions. Never invent `definitionId`, slot order, slot type, handle index, or control semantics. Give every instance a unique position and keep the main path left-to-right.
5. Validate the draft with `agentflow validate <flow-id> --json`. In this repository, use `node bin/agentflow.mjs validate <flow-id> --json`. Fix all errors before continuing; surface warnings that affect behavior.
6. Generate and open the static preview with `agentflow flow preview <path-to-flow.yaml>`. In this repository, use `node bin/agentflow.mjs flow preview <path-to-flow.yaml>`. This command must exit after opening the generated `file://` HTML; do not start `agentflow ui` or another server.
7. Report the draft path and a compact node/edge summary, then wait for the user's visual confirmation. Do not write to the AgentFlow platform before confirmation unless the user explicitly requested direct publish without review.
8. Ask for `personal`, `workspace`, or `team` only if the user has not already chosen the destination. `team` means a workspace Flow shared as editor with the current account's active team.
9. Publish through the sibling `agentflow-cli` skill:

   ```bash
   node ../agentflow-cli/scripts/agentflow-cli.mjs publish-flow \
     --flow-id <flow-id> \
     --file <path-to-flow.yaml> \
     --target-space <personal|workspace|team>
   ```

   Resolve the script relative to this `SKILL.md`. Never expose the token.
10. If the server reports that the Flow already exists, stop and explain the conflict. Use `--replace` only after the user explicitly confirms updating that exact Flow and destination. The CLI reads the current revision before replacement.
11. Verify the published graph with `get-graph --flow-id <flow-id> --flow-source <user|workspace>` and report the platform Flow ID, scope, and result.

## Safety rules

- Treat local generation and preview as reversible; treat platform publish and replacement as external writes.
- Never silently convert a personal Flow into a shared Flow.
- Never create a temporary test Flow on the production platform merely to validate tooling. Use an isolated local AgentFlow server or mock API for integration tests.
- Do not run the Flow unless the user asks to execute it; publishing is not execution.
- Keep a failed draft on disk so it can be inspected and repaired.
