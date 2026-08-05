import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

import {
  advanceJenkinsBuild,
  jenkinsCredentialEnv,
  normalizeJenkinsBuildConfig,
} from "../bin/lib/jenkins.mjs";
import { writeResult } from "../bin/pipeline/write-result.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function runNodeScript(scriptName, args, env = {}) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "bin", "pipeline", scriptName), ...args], {
    cwd: args[0],
    env: { ...process.env, ...env, FORCE_COLOR: "0" },
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null;
}

test("Jenkins Build advances trigger, queue, running and completion without retriggering", () => {
  const config = normalizeJenkinsBuildConfig({
    job: "android/package",
    parameters: '{"BRANCH":"story/123"}',
    pollInterval: "5s",
    timeout: "30m",
  });
  const calls = [];
  const responses = {
    trigger: [{ ok: true, resource: { queue_id: "81" } }],
    queue: [{ ok: true, resource: { item: { executable: { number: 49244, url: "https://jenkins/job/android/49244/" } } } }],
    build: [
      { ok: true, resource: { build: { building: true, result: null, number: 49244, url: "https://jenkins/job/android/49244/" } } },
      { ok: true, resource: { build: {
        building: false,
        result: "SUCCESS",
        number: 49244,
        url: "https://jenkins/job/android/49244/",
        artifacts: [
          { relativePath: "outputs/app-release.apk" },
          { relativePath: "outputs/qrcode.png" },
        ],
      } } },
    ],
  };
  const invoke = (operation, args) => {
    calls.push({ operation, args });
    return responses[operation].shift();
  };
  const persisted = [];
  const run = (state, nowMs) => advanceJenkinsBuild({
    state,
    config,
    invoke,
    nowMs,
    persistState: (value) => persisted.push(value),
  });

  const first = run(null, 1_000_000);
  assert.equal(first.kind, "waiting");
  assert.equal(first.state.phase, "queued");
  assert.equal(first.state.queueId, "81");
  assert.equal(persisted[0].phase, "triggering", "checkpoint must be stored before non-idempotent trigger");

  const second = run(first.state, 1_005_000);
  assert.equal(second.state.phase, "running");
  assert.equal(second.state.buildNumber, "49244");

  const third = run(second.state, 1_010_000);
  assert.equal(third.kind, "waiting");
  assert.equal(third.state.status, "RUNNING");

  const fourth = run(third.state, 1_015_000);
  assert.equal(fourth.kind, "complete");
  assert.deepEqual(fourth.outputs, {
    status: "SUCCESS",
    url: "https://jenkins/job/android/49244/artifact/outputs/app-release.apk",
    qrUrl: "https://jenkins/job/android/49244/artifact/outputs/qrcode.png",
  });
  assert.deepEqual(calls.map((item) => item.operation), ["trigger", "queue", "build", "build"]);
});

test("Jenkins business failure completes the node so notification can continue", () => {
  const config = normalizeJenkinsBuildConfig({ job: "android/package", pollInterval: "5s", timeout: "30m" });
  const result = advanceJenkinsBuild({
    state: {
      version: 1,
      job: config.job,
      phase: "running",
      buildNumber: "9",
      startedAt: new Date(0).toISOString(),
      deadlineAt: new Date(60 * 60 * 1000).toISOString(),
    },
    config,
    nowMs: 10_000,
    invoke: () => ({ ok: true, resource: { build: { building: false, result: "FAILURE", url: "https://jenkins/job/a/9/" } } }),
  });
  assert.equal(result.kind, "complete");
  assert.equal(result.outputs.status, "FAILURE");
  assert.equal(result.outputs.url, "https://jenkins/job/a/9/");
});

test("Jenkins trigger checkpoint is never retriggered after an uncertain process exit", () => {
  const config = normalizeJenkinsBuildConfig({ job: "android/package" });
  let invoked = false;
  const result = advanceJenkinsBuild({
    state: {
      version: 1,
      job: config.job,
      phase: "triggering",
      startedAt: new Date(0).toISOString(),
      deadlineAt: new Date(60 * 60 * 1000).toISOString(),
    },
    config,
    nowMs: 10_000,
    invoke: () => {
      invoked = true;
      return { ok: true };
    },
  });
  assert.equal(invoked, false);
  assert.equal(result.kind, "failed");
  assert.match(result.message, /避免重复构建/);
});

test("Jenkins credentialRef selects deployment-scoped environment variables", () => {
  assert.deepEqual(
    jenkinsCredentialEnv({
      JENKINS_BASE_URL: "https://fallback/",
      JENKINS_TEAM_CI_BASE_URL: "https://team-ci/",
      JENKINS_TEAM_CI_USERNAME: "builder",
      JENKINS_TEAM_CI_TOKEN: "secret",
    }, "team-ci"),
    { baseUrl: "https://team-ci/", username: "builder", token: "secret" },
  );
});

test("pre-process re-enters one Jenkins node across durable checkpoints", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-jenkins-node-"));
  try {
    const flowName = "jenkins-node-integration";
    const uuid = "20260805184500";
    const flowDir = path.join(root, ".workspace", "agentflow", "pipelines", flowName);
    const skillDir = path.join(root, "fake-jenkins-skill");
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "scripts", "jenkins_cli.py"), [
      "import json, sys",
      "op = sys.argv[1]",
      "if op == 'trigger': payload = {'ok': True, 'resource': {'queue_id': '7'}}",
      "elif op == 'queue': payload = {'ok': True, 'resource': {'item': {'executable': {'number': 8, 'url': 'https://jenkins/job/demo/8/'}}}}",
      "else: payload = {'ok': True, 'resource': {'build': {'building': False, 'result': 'SUCCESS', 'number': 8, 'url': 'https://jenkins/job/demo/8/', 'artifacts': [{'relativePath': 'app.apk'}, {'relativePath': 'qrcode.png'}]}}}",
      "print(json.dumps(payload))",
    ].join("\n") + "\n", "utf-8");
    const flow = {
      instances: {
        start: { definitionId: "control_start", label: "Start", input: [], output: [{ type: "node", name: "next", value: "" }] },
        job: { definitionId: "provide_str", label: "Job", input: [], output: [{ type: "text", name: "value", value: "demo" }] },
        build: {
          definitionId: "tool_jenkins_build",
          label: "Jenkins Build",
          input: [
            { type: "node", name: "prev", value: "" },
            { type: "text", name: "job", value: "" },
            { type: "text", name: "parameters", value: "{}" },
            { type: "text", name: "credentialRef", value: "" },
            { type: "text", name: "pollInterval", value: "5s" },
            { type: "text", name: "timeout", value: "5m" },
          ],
          output: [
            { type: "node", name: "next", value: "" },
            { type: "text", name: "status", value: "" },
            { type: "text", name: "url", value: "" },
            { type: "text", name: "qrUrl", value: "" },
          ],
        },
        end: { definitionId: "control_end", label: "End", input: [{ type: "node", name: "prev", value: "" }], output: [] },
      },
      edges: [
        { source: "start", target: "build", sourceHandle: "output-0", targetHandle: "input-0" },
        { source: "job", target: "build", sourceHandle: "output-0", targetHandle: "input-1" },
        { source: "build", target: "end", sourceHandle: "output-0", targetHandle: "input-0" },
      ],
      ui: { nodePositions: { start: { x: 0, y: 0 }, job: { x: 0, y: 150 }, build: { x: 250, y: 0 }, end: { x: 500, y: 0 } } },
    };
    fs.writeFileSync(path.join(flowDir, "flow.yaml"), yaml.dump(flow, { noRefs: true }), "utf-8");
    runNodeScript("ensure-run-dir.mjs", [root, uuid, flowName]);
    runNodeScript("parse-flow.mjs", [root, flowName, uuid, flowDir]);
    const env = { AGENTFLOW_JENKINS_SKILL_DIR: skillDir, AGENTFLOW_JENKINS_PYTHON: "python3", JENKINS_BASE_URL: "https://jenkins" };

    const first = runNodeScript("pre-process-node.mjs", [root, flowName, uuid, "build"], env);
    assert.equal(first.nodeLifecycle, "waiting");
    runNodeScript("post-process-node.mjs", [root, flowName, uuid, "build", String(first.execId)], env);
    writeResult(root, flowName, uuid, "build", { status: "cache_not_met", message: "wake" }, { execId: first.execId });

    const second = runNodeScript("pre-process-node.mjs", [root, flowName, uuid, "build"], env);
    assert.equal(second.nodeLifecycle, "waiting");
    runNodeScript("post-process-node.mjs", [root, flowName, uuid, "build", String(second.execId)], env);
    writeResult(root, flowName, uuid, "build", { status: "cache_not_met", message: "wake" }, { execId: second.execId });

    const third = runNodeScript("pre-process-node.mjs", [root, flowName, uuid, "build"], env);
    assert.equal(third.nodeLifecycle, "complete");
    const runDir = path.join(flowDir, "runBuild", uuid);
    assert.equal(fs.readFileSync(path.join(runDir, "output", "build", "node_build_status.md"), "utf-8").trim(), "SUCCESS");
    assert.equal(fs.readFileSync(path.join(runDir, "output", "build", "node_build_url.md"), "utf-8").trim(), "https://jenkins/job/demo/8/artifact/app.apk");
    assert.equal(fs.readFileSync(path.join(runDir, "output", "build", "node_build_qrUrl.md"), "utf-8").trim(), "https://jenkins/job/demo/8/artifact/qrcode.png");
    const state = JSON.parse(fs.readFileSync(path.join(runDir, "state", "build.jenkins.json"), "utf-8"));
    assert.equal(state.phase, "complete");
    assert.equal(state.queueId, "7");
    assert.equal(state.buildNumber, "8");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
