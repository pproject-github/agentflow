# Free-Prompt Agent + Inspector Summary-First Layout

**Goal:** Add an insertable-anywhere `free-prompt-agent` capability, and make node details conclusion-first, markdown-readable.

## Capability: `free-prompt-agent`

- Not part of the auto-recommended state-machine stage nodes.
- Flag `insertableInAnyStage: true` — appears under every process group in「自定义添加阶段」.
- Inputs: `prompt` (required, textarea), optional `skill_hints`.
- Hybrid context: release context + skillRoot locked; user prompt drives work.
- Same JSON result contract as other capabilities.
- Server allows `processId` override when inserting into a non-default stage.

## Inspector layout (summary-first)

1. Hero markdown from `output.summary` / `details.summary` / message
2. Compact facts (status / run / operator)
3. Inputs (textarea for multiline)
4. Waiting / error callouts when present
5. Collapsible steps, records, artifacts, links
6. Raw JSON + logs collapsed by default

## Client fixes

- Do not persist AgentFlow `graph` as node `output`.
- Treat `status=waiting` as pending waiting, not completed.
