# AgentFlow Placeholder Reference

> Generated from `builtin/web-ui/src/bodyPlaceholders.js` by `scripts/generate-agentflow-skill-references.mjs`.

## Runtime Placeholders

- `${workspaceRoot}`: Current execution workspace. After CD Workspace, this is the target project workspace.
- `${pipelineWorkspace}`: Original AgentFlow pipeline workspace. Use this to access pipeline-owned files after CD Workspace.
- `${cwd}`: Alias-like current working directory for the runtime workspace context.
- `${flowName}`: Current pipeline id/name.
- `${runDir}`: Current run directory, relative to pipeline workspace.
- `${flowDir}`: Absolute directory containing the current flow.yaml.

## Slot Placeholders

- `${input.<slotName>}`: input slot value by name.
- `${output.<slotName>}`: output slot path by name.
- `${<slotName>}`: shorthand for input or output slot when unambiguous.

Do not wrap placeholders in extra quotes inside `script`; AgentFlow shell-quotes substituted values.
