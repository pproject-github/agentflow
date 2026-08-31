# Task 4 Report

Status: DONE

## Changes

- `seedNextRecommendations()` now writes `workflowId` to the state snapshot and generated pending records.
- The shared state machine exposes workflow identity in its snapshot; configured nodes inherit the same identity.
- Initialization records now retain matching `workflowId`, `scopeKey`, and `contextSnapshot` across frontend and runtime-store construction/merge paths.
- `selectWorkflowProcessNodes()` returns only nodes in the selected business/platform/batch workflow, while repeated custom selection remains supported.
- Panel hydration preserves workflow/process/scope metadata for timeline, pending, and custom records.
- Runtime completion persistence keeps the matching `workflowId` plus process/scope metadata on failed and completed records.
- Unmatched workflows expose no executable machine, catalog filter results, or custom candidates.
- Static fallback catalog now materializes action-level nodes referenced by the selected shared workflow.
- Static fallback now returns only configured action-level IDs; aggregate `release-setup`/`release-git` nodes are no longer exposed.
- Removed stale `release-localization:send-upload-notification`; Android/iOS approval stages are batch-scoped, and Android supplemental wiki records retain required `gray_percent` input.
- Added integration and panel contract coverage for configured candidate filtering, config removal behavior, and persistence round trips.

## Verification

```text
node --test test/release-workflow-model.test.mjs test/release-runtime-integration.test.mjs test/release-runtime-catalog.test.mjs test/release-workflow-state-machine.test.mjs test/release-workflow-panel-contract.test.mjs
56 passed, 0 failed

node_modules/.bin/esbuild builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx --loader:.jsx=jsx --outfile=/tmp/ReleaseWorkflowPanel.js
success
```

## Commit

`896fe04 fix(release): align static catalog with workflow actions`

## Cross-file adaptation

The brief listed panel/model/store/tests. The shared workflow config and state-machine adapter were also updated because workflow identity must originate from the shared machine and be copied into candidate records; no unrelated files were changed by this task.

## Concerns

- Existing dirty changes in other files and generated frontend assets were left untouched.
- Legacy migration and historical-data compatibility are intentionally deferred while the workflow feature is still under development.
