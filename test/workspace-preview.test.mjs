import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorkspacePreviewId,
  isWorkspacePreviewDir,
  listExpiredWorkspacePreviews,
  readWorkspacePreviewMetadata,
  writeWorkspacePreviewMetadata,
} from "../bin/lib/workspace-preview.mjs";

test("workspace preview metadata identifies and expires isolated projects", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-preview-test-"));
  try {
    const flowId = createWorkspacePreviewId();
    const flowDir = path.join(root, flowId);
    fs.mkdirSync(flowDir, { recursive: true });
    assert.match(flowId, /^preview_[a-f0-9]{20}$/);
    assert.equal(isWorkspacePreviewDir(flowDir), false);
    writeWorkspacePreviewMetadata(flowDir, {
      version: 1,
      flowId,
      ownerId: "user-1",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      expiresAt: new Date(1).toISOString(),
    });
    assert.equal(isWorkspacePreviewDir(flowDir), true);
    assert.equal(readWorkspacePreviewMetadata(flowDir).ownerId, "user-1");
    assert.equal(listExpiredWorkspacePreviews(root, 2).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

