import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createWorkspaceDraftId,
  isWorkspaceDraftDir,
  listExpiredWorkspaceDrafts,
  normalizeWorkspaceDraftTtlMs,
  readWorkspaceDraftMetadata,
  safeWorkspaceDraftId,
  writeWorkspaceDraftMetadata,
} from "../bin/lib/workspace-draft.mjs";

test("workspace draft metadata is private, bounded, and discoverable for cleanup", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-workspace-draft-")));
  try {
    const id = createWorkspaceDraftId();
    assert.match(id, /^draft_[a-f0-9]{20}$/);
    assert.equal(safeWorkspaceDraftId(id), id);
    assert.equal(safeWorkspaceDraftId("../draft_bad"), "");
    assert.equal(normalizeWorkspaceDraftTtlMs(1), 60_000);
    assert.equal(normalizeWorkspaceDraftTtlMs(99 * 60 * 60 * 1000), 24 * 60 * 60 * 1000);

    const flowDir = path.join(root, id);
    fs.mkdirSync(flowDir);
    writeWorkspaceDraftMetadata(flowDir, {
      version: 1,
      flowId: id,
      ownerId: "owner",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      expiresAt: new Date(1).toISOString(),
    });
    assert.equal(isWorkspaceDraftDir(flowDir), true);
    assert.equal(readWorkspaceDraftMetadata(flowDir).ownerId, "owner");
    assert.equal(listExpiredWorkspaceDrafts(root, 2).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
