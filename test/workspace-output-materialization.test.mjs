import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  workspaceMaterializeAgentResultFile,
  workspacePublishAgentOutputFiles,
  workspaceStructuredAgentOutput,
} from "../bin/lib/ui-server.mjs";

function createRunPackage(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-output-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nodeRunDir = path.join(root, "node");
  const workspaceOutputsDir = path.join(root, "workspace", "outputs");
  fs.mkdirSync(path.join(nodeRunDir, "outputs"), { recursive: true });
  fs.mkdirSync(workspaceOutputsDir, { recursive: true });
  return {
    nodeId: "subAgent_5",
    nodeRunDir,
    workspaceOutputsDir,
    resultFileRel: "outputs/result.md",
    outParamFiles: {},
  };
}

function createDurableRunPackage(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-durable-output-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nodeRunDir = path.join(root, "node");
  const workspaceRoot = path.join(root, "workspace");
  const workspaceOutputsDir = path.join(workspaceRoot, "outputs");
  const outputsDir = path.join(workspaceOutputsDir, "subAgent_5");
  fs.mkdirSync(path.join(nodeRunDir, "outputs"), { recursive: true });
  fs.mkdirSync(outputsDir, { recursive: true });
  return {
    nodeId: "subAgent_5",
    nodeRunDir,
    workspaceRoot,
    workspaceOutputsDir,
    outputsDir,
    outputsRel: "outputs/subAgent_5",
    directWorkspaceOutputs: true,
    resultFileRel: "outputs/result.md",
    resultFileAbs: path.join(outputsDir, "result.md"),
    outParamFiles: {},
  };
}

test("materializes a plain agent reply and publishes it", (t) => {
  const runPackage = createRunPackage(t);
  const structured = workspaceStructuredAgentOutput("# 查询结果\n\n- uid: 123");
  const materialized = workspaceMaterializeAgentResultFile(structured, runPackage);
  assert.equal(materialized.resultFile, "outputs/result.md");
  assert.equal(
    fs.readFileSync(path.join(runPackage.nodeRunDir, "outputs", "result.md"), "utf-8"),
    "# 查询结果\n\n- uid: 123",
  );

  const published = workspacePublishAgentOutputFiles(materialized, runPackage);
  assert.equal(published.resultFile, "outputs/subAgent_5/result.md");
  assert.equal(
    fs.readFileSync(path.join(runPackage.workspaceOutputsDir, "subAgent_5", "result.md"), "utf-8"),
    "# 查询结果\n\n- uid: 123",
  );
});

test("recovers a missing legacy resultFile when inline result is present", (t) => {
  const runPackage = createRunPackage(t);
  const structured = workspaceStructuredAgentOutput([
    "---agentflow",
    "result: |",
    "  uid-1",
    "  uid-2",
    "resultFile: outputs/result.md",
    "---end",
  ].join("\n"));
  const materialized = workspaceMaterializeAgentResultFile(structured, runPackage);
  assert.equal(materialized.resultFile, "outputs/result.md");
  assert.equal(
    fs.readFileSync(path.join(runPackage.nodeRunDir, "outputs", "result.md"), "utf-8"),
    "uid-1\nuid-2",
  );
});

test("keeps an already-written legacy resultFile compatible", (t) => {
  const runPackage = createRunPackage(t);
  fs.writeFileSync(
    path.join(runPackage.nodeRunDir, "outputs", "result.md"),
    "legacy result",
    "utf-8",
  );
  const structured = workspaceStructuredAgentOutput([
    "---agentflow",
    "resultFile: outputs/result.md",
    "---end",
  ].join("\n"));
  const materialized = workspaceMaterializeAgentResultFile(structured, runPackage);
  const published = workspacePublishAgentOutputFiles(materialized, runPackage);
  assert.equal(published.resultFile, "outputs/subAgent_5/result.md");
  assert.equal(
    fs.readFileSync(path.join(runPackage.workspaceOutputsDir, "subAgent_5", "result.md"), "utf-8"),
    "legacy result",
  );
});

test("materializes inline file outParams", (t) => {
  const runPackage = {
    ...createRunPackage(t),
    outParamFiles: { "report.md": "outputs/report.md" },
  };
  const structured = workspaceStructuredAgentOutput([
    "---agentflow",
    "result: 完成",
    "outParams:",
    "  report.md: |",
    "    # Report",
    "    ok",
    "---end",
  ].join("\n"));
  const materialized = workspaceMaterializeAgentResultFile(structured, runPackage);
  assert.equal(materialized.outParams["report.md"], undefined);
  assert.equal(materialized.outParams["report.mdFile"], "outputs/report.md");
  assert.equal(
    fs.readFileSync(path.join(runPackage.nodeRunDir, "outputs", "report.md"), "utf-8"),
    "# Report\nok",
  );
});

test("keeps every file written to the durable downloads directory", (t) => {
  const runPackage = createDurableRunPackage(t);
  fs.writeFileSync(
    path.join(runPackage.outputsDir, "top100_uid_detail.csv"),
    "uid,cnt\n1266468052,32\n",
    "utf-8",
  );

  const structured = workspaceStructuredAgentOutput("查询完成，明细见下载文件。");
  const materialized = workspaceMaterializeAgentResultFile(structured, runPackage);
  const published = workspacePublishAgentOutputFiles(materialized, runPackage);

  assert.equal(published.resultFile, "outputs/subAgent_5/result.md");
  assert.deepEqual(
    published.outputFiles.map((file) => file.path),
    [
      "outputs/subAgent_5/result.md",
      "outputs/subAgent_5/top100_uid_detail.csv",
    ],
  );
  assert.equal(
    fs.readFileSync(path.join(runPackage.outputsDir, "top100_uid_detail.csv"), "utf-8"),
    "uid,cnt\n1266468052,32\n",
  );

  fs.rmSync(runPackage.nodeRunDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(path.join(runPackage.outputsDir, "top100_uid_detail.csv")), true);
});
