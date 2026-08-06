import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listNodesJson } from "../bin/lib/catalog-flows.mjs";
import { getBuiltinNodeSchemas, _resetSchemaCache } from "../bin/lib/composer-node-schema.mjs";
import { getLanguage, setLanguage, translateNodeDef } from "../bin/lib/i18n.mjs";
import { listRecentRunsFromDisk } from "../bin/lib/recent-runs.mjs";
import { getRunNodeStatusesFromDisk } from "../bin/lib/run-node-statuses-from-disk.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("Jenkins Build has user-facing node catalog translations", () => {
  const previous = getLanguage();
  try {
    setLanguage("zh");
    assert.equal(translateNodeDef("tool_jenkins_build", "displayName"), "Jenkins 构建");
    assert.match(translateNodeDef("tool_jenkins_build", "description"), /触发 Jenkins 构建/);
    const catalogNode = listNodesJson(repoRoot).nodes.find((node) => node.id === "tool_jenkins_build");
    assert.equal(catalogNode?.displayName, "Jenkins 构建");
    assert.ok(Array.isArray(catalogNode?.guide?.steps));
    assert.match(catalogNode.guide.example, /job: like-android/);
    setLanguage("en");
    assert.equal(translateNodeDef("tool_jenkins_build", "displayName"), "Jenkins Build");
  } finally {
    setLanguage(previous);
  }
});

test("Composer exposes the durable Jenkins Build schema without installing a notification workflow", () => {
  _resetSchemaCache();
  const schema = getBuiltinNodeSchemas().tool_jenkins_build;
  assert.deepEqual(schema.input.map((slot) => slot.name), ["prev", "job", "parameters", "credentialRef", "pollInterval", "timeout"]);
  assert.deepEqual(schema.output.map((slot) => slot.name), ["next", "status", "url", "qrUrl"]);
  assert.equal(fs.existsSync(path.join(repoRoot, "builtin/pipelines/jenkins-build-notify")), false);
});

test("Jenkins disk state maps waiting and business failure separately from execution status", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-jenkins-status-"));
  try {
    const flowId = "jenkins-status-demo";
    const runId = "20260805183000";
    const flowDir = path.join(root, ".workspace", "agentflow", "pipelines", flowId);
    const runDir = path.join(flowDir, "runBuild", runId);
    fs.mkdirSync(path.join(runDir, "intermediate", "build"), { recursive: true });
    fs.mkdirSync(path.join(runDir, "state"), { recursive: true });
    fs.writeFileSync(path.join(flowDir, "flow.yaml"), "instances: {}\nedges: []\n", "utf-8");
    fs.writeFileSync(path.join(runDir, "intermediate", "flow.json"), JSON.stringify({
      ok: true,
      order: ["build"],
      nodeDefinitions: { build: "tool_jenkins_build" },
    }), "utf-8");
    const resultPath = path.join(runDir, "intermediate", "build", "build.result.md");
    const statePath = path.join(runDir, "state", "build.jenkins.json");
    fs.writeFileSync(resultPath, '---\nstatus: "pending"\nmessage: "waiting"\n---\n', "utf-8");
    fs.writeFileSync(statePath, JSON.stringify({
      phase: "running",
      status: "RUNNING",
      message: "Jenkins 构建中 · #9",
      buildNumber: "9",
      buildUrl: "https://jenkins/job/a/9/",
      startedAt: "2026-08-05T10:00:00.000Z",
      wakeAt: "2026-08-05T10:00:30.000Z",
    }), "utf-8");
    fs.writeFileSync(path.join(runDir, "wait-states.json"), JSON.stringify({
      version: 1,
      waits: [{ instanceId: "build", status: "waiting", resumeMode: "rerun", wakeAt: "2026-08-05T10:00:30.000Z" }],
    }), "utf-8");

    let statuses = getRunNodeStatusesFromDisk(root, flowId, runId);
    assert.equal(statuses.build.status, "waiting");
    assert.equal(statuses.build.phase, "running");
    assert.equal(statuses.build.buildNumber, "9");
    const recent = listRecentRunsFromDisk(root).find((run) => run.flowId === flowId && run.runId === runId);
    assert.equal(recent?.status, "running", "durably waiting run must remain active in Workflow UI");

    fs.writeFileSync(resultPath, '---\nstatus: "success"\nmessage: "Jenkins FAILURE"\n---\n', "utf-8");
    fs.writeFileSync(statePath, JSON.stringify({
      phase: "complete",
      status: "FAILURE",
      message: "Jenkins FAILURE · #9",
      buildNumber: "9",
      url: "https://jenkins/job/a/9/",
      startedAt: "2026-08-05T10:00:00.000Z",
      completedAt: "2026-08-05T10:05:00.000Z",
    }), "utf-8");
    statuses = getRunNodeStatusesFromDisk(root, flowId, runId);
    assert.equal(statuses.build.status, "outcome_failed");
    assert.equal(statuses.build.executionStatus, "success");
    assert.equal(statuses.build.jenkinsStatus, "FAILURE");
    assert.equal(statuses.build.elapsed, "5m 0s");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Workflow UI renders Jenkins waiting/outcome state and scheduler reruns the same node", () => {
  const flowNode = fs.readFileSync(path.join(repoRoot, "builtin/web-ui/src/FlowNode.jsx"), "utf-8");
  const editor = fs.readFileSync(path.join(repoRoot, "builtin/web-ui/src/pages/FlowEditorPage.jsx"), "utf-8");
  const scheduler = fs.readFileSync(path.join(repoRoot, "bin/lib/scheduler.mjs"), "utf-8");
  const uiServer = fs.readFileSync(path.join(repoRoot, "bin/lib/ui-server.mjs"), "utf-8");
  assert.match(flowNode, /nodeStatus === "waiting"/);
  assert.match(flowNode, /nodeStatus === "outcome_failed"/);
  assert.match(flowNode, /nodeRunDetail\.buildNumber/);
  assert.match(flowNode, /af-flow-node__guide-button/);
  assert.match(flowNode, /af-node-guide__panel/);
  assert.match(editor, /nodeRunDetail: nodeRunStatus\[n\.id\]/);
  assert.match(scheduler, /waitState\.resumeMode === "rerun"/);
  assert.match(scheduler, /rerunCurrentNode \? "apply" : "resume"/);
  assert.match(editor, /runId: currentRunUuid/);
  assert.match(uiServer, /url\.pathname === "\/api\/flow\/run\/stop"[\s\S]{0,800}const requestedRunId/);
  assert.match(uiServer, /cancelScheduledRun\(root, flowId, requestedRunId, userCtx\)/);
});
