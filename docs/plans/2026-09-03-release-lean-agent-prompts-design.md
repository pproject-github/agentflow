# Lean release Agent prompts (Skill-owned capability)

## Decision

AgentFlow only triggers Skills with operator-guide-style intent. It must not inject CLI playbooks, recovery digests, or idempotency/rerun policy.

## Prompt contract

Keep only:

1. Locked release context (`businessLine` / `platform` / `version` / `batch`)
2. One business-intent sentence (aligned with each Skill `references/operator-guide.md` “向 Agent 说明什么”)
3. Explicit operator inputs when present
4. `skillRoot` / `repositoryRoot` + related Skill names
5. Short JSON result envelope requirement
6. One line: no `skillhub evolve`

Remove:

- `discoverReleaseSkillRecovery` injection
- Step-by-step `uv run` playbooks
- “勿重复 prepare/apply / 禁止 --rerun / 幂等勿重做” orchestration rules

Idempotency, resume, and force-rerun belong to Skill stdout / Skill confirm / `--rerun`.
