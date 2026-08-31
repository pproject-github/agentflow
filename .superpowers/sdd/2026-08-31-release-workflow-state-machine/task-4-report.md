# Task 4 Report

Status: DONE

## Changes

- `seedNextRecommendations()` now writes `workflowId` and `workflowVersion` to the state snapshot and generated pending records.
- The shared state machine exposes workflow identity at both snapshot and workflow metadata levels; configured nodes inherit the same identity.
- `selectWorkflowProcessNodes()` returns only nodes in the selected business/platform/batch workflow, while repeated custom selection remains supported.
- Panel hydration preserves workflow/process/scope metadata for timeline, pending, and custom records. Historical timeline nodes remain viewable with a read-only fallback inspector, while they are not used as current candidates.
- Runtime completion persistence keeps the matching `workflowId` plus process/scope metadata on failed and completed records.
- Added integration and panel contract coverage for configured candidate filtering, config removal behavior, and persistence round trips.

## Verification

```text
node --test test/release-runtime-integration.test.mjs test/release-workflow-panel-contract.test.mjs
8 passed, 0 failed

node_modules/.bin/esbuild builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx --loader:.jsx=jsx --outfile=/tmp/ReleaseWorkflowPanel.js
success
```

## Commit

`2654ede fix(release): constrain workflows and persist action metadata`

## Cross-file adaptation

The brief listed panel/model/store/tests. The shared workflow config and state-machine adapter were also updated because workflow identity must originate from the shared machine and be copied into candidate records; no unrelated files were changed by this task.

## Concerns

- Existing dirty changes in other files and generated frontend assets were left untouched.
- Legacy migration and `workflowVersion` persistence are intentionally deferred while the workflow feature is still under development.
