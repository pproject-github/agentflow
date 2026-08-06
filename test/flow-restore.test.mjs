import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { restoreArchivedFlowPipeline } from "../bin/lib/flow-write.mjs";

test("restores an archived workspace Flow without dropping scripts", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-flow-restore-")));
  const archived = path.join(root, ".workspace", "agentflow", "pipelines", "_archived", "demo");
  try {
    fs.mkdirSync(path.join(archived, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(archived, "flow.yaml"), "instances: {}\nedges: []\n", "utf8");
    fs.writeFileSync(path.join(archived, "scripts", "keep.mjs"), "export default true;\n", "utf8");

    assert.deepEqual(restoreArchivedFlowPipeline(root, "demo", "workspace"), { success: true });
    assert.equal(fs.existsSync(archived), false);
    assert.equal(
      fs.readFileSync(path.join(root, ".workspace", "agentflow", "pipelines", "demo", "scripts", "keep.mjs"), "utf8"),
      "export default true;\n",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not restore over an existing active Flow", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-flow-restore-")));
  const archived = path.join(root, ".workspace", "agentflow", "pipelines", "_archived", "demo");
  const active = path.join(root, ".workspace", "agentflow", "pipelines", "demo");
  try {
    fs.mkdirSync(archived, { recursive: true });
    fs.mkdirSync(active, { recursive: true });
    fs.writeFileSync(path.join(archived, "flow.yaml"), "instances: {}\nedges: []\n", "utf8");
    assert.deepEqual(restoreArchivedFlowPipeline(root, "demo", "workspace"), {
      success: false,
      error: "活动目录已存在同名流水线",
    });
    assert.equal(fs.existsSync(path.join(archived, "flow.yaml")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
