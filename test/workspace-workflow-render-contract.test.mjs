import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspacePagePath = new URL(
  "../builtin/web-ui/src/pages/WorkspacePage.jsx",
  import.meta.url,
);

test("Workflow timeline receives flow params without relying on an undeclared variable", async () => {
  const source = await readFile(workspacePagePath, "utf8");

  assert.match(
    source,
    /function PrdWorkflowTimelinePanel\(\{\s*flowParams = \{\},/,
    "PrdWorkflowTimelinePanel must declare a safe flowParams prop",
  );
  assert.match(
    source,
    /<PrdWorkflowTimelinePanel\s+flowParams=\{flowParams\}/,
    "WorkspacePageInner must pass its URL-derived flowParams to the Workflow timeline",
  );
});
