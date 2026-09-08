import assert from "node:assert/strict";
import test from "node:test";

import { shouldPersistWorkspaceNodeHistory } from "../bin/lib/workspace-server.mjs";

test("release runtime does not persist agent node history into the release repository", () => {
  assert.equal(shouldPersistWorkspaceNodeHistory({ releaseRuntime: true }), false);
  assert.equal(shouldPersistWorkspaceNodeHistory({ releaseRuntime: false }), true);
});
