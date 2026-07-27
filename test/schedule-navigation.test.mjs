import assert from "node:assert/strict";
import test from "node:test";

import {
  scheduleTargetLabel,
  scheduleTargetUrl,
} from "../builtin/web-ui/src/scheduleNavigation.js";

test("workspace schedule targets its project and node", () => {
  assert.equal(
    scheduleTargetUrl({
      kind: "workspace",
      flowId: "daily task",
      flowSource: "user",
      scheduleNodeId: "scheduled/run 1",
    }),
    "/workspace?flowId=daily+task&flowSource=user&focusNodeId=scheduled%2Frun+1",
  );
  assert.equal(scheduleTargetLabel({ kind: "workspace", scheduleNodeId: "run-1" }), "打开节点");
});

test("shared workspace schedule preserves collaboration id", () => {
  assert.equal(
    scheduleTargetUrl({
      kind: "workspace",
      flowId: "daily_task",
      flowSource: "user",
      workspaceId: "workspace-123",
      scheduleNodeId: "scheduled-run",
    }),
    "/workspace?flowId=daily_task&flowSource=user&workspaceId=workspace-123&focusNodeId=scheduled-run",
  );
});

test("pipeline schedule opens its project without a node focus", () => {
  assert.equal(
    scheduleTargetUrl({ kind: "pipeline", flowId: "publish_resolution", flowSource: "user" }),
    "/workspace?flowId=publish_resolution&flowSource=user",
  );
  assert.equal(scheduleTargetLabel({ kind: "pipeline" }), "打开项目");
  assert.equal(scheduleTargetUrl({ kind: "workspace" }), "");
});
