import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  advanceJenkinsBuild,
  createJenkinsHttpInvoker,
  jenkinsBuildStatePath,
  jenkinsCredentialEnv,
  normalizeJenkinsBuildConfig,
  readJenkinsBuildState,
} from "../bin/lib/jenkins.mjs";
import { pollWorkspaceDeferredRuns, readWorkspaceDeferredRunRegistry, runWorkspaceGraph } from "../bin/lib/workspace-server.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

test("Jenkins state machine checkpoints trigger, queue and build without retriggering", async () => {
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
      { ok: true, resource: { build: { building: true, number: 49244, url: "https://jenkins/job/android/49244/" } } },
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
  const invoke = async (operation, args) => {
    calls.push({ operation, args });
    return responses[operation].shift();
  };
  const persisted = [];
  const advance = (state, nowMs) => advanceJenkinsBuild({
    state,
    config,
    invoke,
    nowMs,
    persistState: (value) => persisted.push(value),
  });

  const queued = await advance(null, 1_000_000);
  assert.equal(queued.kind, "waiting");
  assert.equal(queued.state.queueId, "81");
  assert.equal(persisted[0].phase, "triggering");
  const running = await advance(queued.state, 1_005_000);
  const polling = await advance(running.state, 1_010_000);
  const complete = await advance(polling.state, 1_015_000);

  assert.deepEqual(complete.outputs, {
    status: "SUCCESS",
    url: "https://jenkins/job/android/49244/artifact/outputs/app-release.apk",
    qrUrl: "https://jenkins/job/android/49244/artifact/outputs/qrcode.png",
  });
  assert.deepEqual(calls.map((item) => item.operation), ["trigger", "queue", "build", "build"]);
});

test("Jenkins uncertain trigger checkpoint is never retried", async () => {
  const config = normalizeJenkinsBuildConfig({ job: "android/package" });
  let invoked = false;
  const result = await advanceJenkinsBuild({
    state: {
      version: 1,
      job: config.job,
      parametersHash: "44136fa355b3678a",
      phase: "triggering",
      startedAt: new Date(0).toISOString(),
      deadlineAt: new Date(60 * 60 * 1000).toISOString(),
    },
    config,
    nowMs: 10_000,
    invoke: async () => {
      invoked = true;
      return { ok: true };
    },
  });
  assert.equal(invoked, false);
  assert.equal(result.kind, "failed");
  assert.equal(result.state.phase, "triggering", "unknown trigger outcome must remain a permanent no-retry checkpoint");
  assert.match(result.message, /避免重复构建/);
});

test("Jenkins credentialRef and native HTTP client use scoped credentials and folder job paths", async () => {
  const env = {
    JENKINS_BASE_URL: "https://fallback.example/",
    JENKINS_TEAM_CI_BASE_URL: "https://ci.example/",
    JENKINS_TEAM_CI_USERNAME: "builder",
    JENKINS_TEAM_CI_TOKEN: "secret",
  };
  assert.deepEqual(jenkinsCredentialEnv(env, "team-ci"), {
    baseUrl: "https://ci.example",
    username: "builder",
    token: "secret",
  });
  const requests = [];
  const invoke = createJenkinsHttpInvoker({
    credentialRef: "team-ci",
    env,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response("", { status: 201, headers: { location: "/queue/item/7/" } });
    },
  });
  const result = await invoke("trigger", { job: "mobile/android", parameters: { BRANCH: "main" } });
  assert.equal(result.resource.queue_id, "7");
  assert.equal(requests[0].url, "https://ci.example/job/mobile/job/android/buildWithParameters");
  assert.equal(requests[0].options.body, "BRANCH=main");
  assert.equal(requests[0].options.headers.Authorization, `Basic ${Buffer.from("builder:secret").toString("base64")}`);
});

test("Jenkins empty parameters use parameterized endpoint when the job has defaults", async () => {
  const requests = [];
  const invoke = createJenkinsHttpInvoker({
    env: { JENKINS_BASE_URL: "https://ci.example" },
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method || "GET", body: options.body || "" });
      if ((options.method || "GET") === "GET") {
        return Response.json({ actions: [{ parameterDefinitions: [{ name: "BRANCH" }] }] });
      }
      return new Response("", { status: 201, headers: { location: "/queue/item/8/" } });
    },
  });
  const result = await invoke("trigger", { job: "like-android", parameters: {} });
  assert.equal(result.resource.queue_id, "8");
  assert.equal(requests[0].method, "GET");
  assert.match(requests[0].url, /job\/like-android\/api\/json/);
  assert.equal(requests[1].url, "https://ci.example/job/like-android/buildWithParameters");
  assert.equal(requests[1].body, "");
});

test("Workspace native Jenkins handler advances once per invocation and exposes final outputs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-workspace-jenkins-"));
  const oldBaseUrl = process.env.JENKINS_BASE_URL;
  process.env.JENKINS_BASE_URL = "https://ci.test";
  try {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method || "GET" });
      if (options.method === "POST") {
        return new Response("", { status: 201, headers: { location: "https://ci.test/queue/item/7/" } });
      }
      if (String(url).includes("/job/demo/api/json")) {
        return Response.json({ actions: [] });
      }
      if (String(url).includes("/queue/item/7/")) {
        return Response.json({ executable: { number: 8, url: "https://ci.test/job/demo/8/" } });
      }
      return Response.json({
        building: false,
        result: "SUCCESS",
        number: 8,
        url: "https://ci.test/job/demo/8/",
        artifacts: [{ relativePath: "outputs/demo.apk" }, { relativePath: "outputs/qrcode.png" }],
      });
    };
    const graph = {
      version: 1,
      instances: {
        run: { definitionId: "workspace_run", label: "Run", input: [], output: [{ type: "node", name: "next" }] },
        build: {
          definitionId: "tool_jenkins_build",
          label: "Jenkins Build",
          input: [
            { type: "node", name: "prev" },
            { type: "text", name: "job", value: "demo" },
            { type: "text", name: "parameters", value: "{}" },
            { type: "text", name: "credentialRef", value: "" },
            { type: "text", name: "pollInterval", value: "5s" },
            { type: "text", name: "timeout", value: "5m" },
          ],
          output: [
            { type: "node", name: "next" },
            { type: "text", name: "status", value: "" },
            { type: "text", name: "url", value: "" },
            { type: "text", name: "qrUrl", value: "" },
          ],
        },
      },
      edges: [{ source: "run", target: "build", sourceHandle: "output-0", targetHandle: "input-0" }],
      ui: { nodePositions: { run: { x: 0, y: 0 }, build: { x: 300, y: 0 } } },
    };
    let result = null;
    let currentGraph = graph;
    for (let step = 0; step < 3; step += 1) {
      result = await runWorkspaceGraph(root, root, { graph: currentGraph, runNodeId: "run", runId: "test-run" }, { userId: "jenkins-test" }, {
        runId: "test-run",
        jenkinsFetch: fetchImpl,
      });
      currentGraph = result.graph;
      if (step < 2) assert.equal(result.deferred?.kind, "jenkins", `step ${step + 1} must return without sleeping`);
    }
    assert.equal(result.deferred, null);
    const outputs = Object.fromEntries(result.graph.instances.build.output.map((slot) => [slot.name, slot.value || ""]));
    assert.equal(outputs.status, "SUCCESS");
    assert.equal(outputs.url, "https://ci.test/job/demo/8/artifact/outputs/demo.apk");
    assert.equal(outputs.qrUrl, "https://ci.test/job/demo/8/artifact/outputs/qrcode.png");
    assert.deepEqual(requests.map((request) => request.method), ["GET", "POST", "GET", "GET"]);
    assert.equal(readJenkinsBuildState(jenkinsBuildStatePath(root, "build")).phase, "complete");
  } finally {
    if (oldBaseUrl == null) delete process.env.JENKINS_BASE_URL;
    else process.env.JENKINS_BASE_URL = oldBaseUrl;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deferred Jenkins run survives UI server restart and never retriggers the build", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-jenkins-background-")));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const dataRoot = path.join(tempRoot, "data");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const previous = {
    home: process.env.AGENTFLOW_HOME,
    baseUrl: process.env.JENKINS_BASE_URL,
    username: process.env.JENKINS_USERNAME,
    token: process.env.JENKINS_TOKEN,
  };
  let agentflowServer = null;
  let jenkinsServer = null;
  let triggerCount = 0;
  try {
    jenkinsServer = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/job/demo/api/json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ actions: [] }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/job/demo/build") {
        triggerCount += 1;
        res.writeHead(201, { Location: "/queue/item/7/" });
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/queue/item/7/api/json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ executable: { number: 8, url: `${process.env.JENKINS_BASE_URL}/job/demo/8/` } }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/job/demo/8/api/json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ building: false, result: "SUCCESS", number: 8, url: `${process.env.JENKINS_BASE_URL}/job/demo/8/`, artifacts: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await listen(jenkinsServer);
    process.env.AGENTFLOW_HOME = dataRoot;
    process.env.JENKINS_BASE_URL = `http://127.0.0.1:${jenkinsServer.address().port}`;
    delete process.env.JENKINS_USERNAME;
    delete process.env.JENKINS_TOKEN;

    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?jenkins-background=${Date.now()}`),
      import(`../bin/lib/ui-server.mjs?jenkins-background=${Date.now()}`),
    ]);
    const user = loginOrCreateUser("jenkins-background-owner", "jenkins-background-password");
    const auth = { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" };
    const startAgentflow = async () => {
      const server = await startUiServer({ workspaceRoot, host: "127.0.0.1", port: 0, staticDir: path.join(tempRoot, "static"), enableWorkspaceScheduler: false });
      return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
    };
    let started = await startAgentflow();
    agentflowServer = started.server;
    const request = async (pathname, body = null) => {
      const response = await fetch(started.baseUrl + pathname, {
        method: body == null ? "GET" : "POST",
        headers: auth,
        ...(body == null ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await request("/api/flows", { flowId: "jenkins-restart", targetSpace: "user" })).status, 200);
    const graph = {
      version: 1,
      instances: {
        run: { definitionId: "workspace_run", label: "Run", input: [{ type: "node", name: "prev", value: "" }], output: [{ type: "node", name: "next", value: "" }] },
        build: {
          definitionId: "tool_jenkins_build",
          label: "Jenkins Build",
          input: [
            { type: "node", name: "prev", value: "" },
            { type: "text", name: "job", value: "demo" },
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
      },
      edges: [{ source: "run", sourceHandle: "output-0", target: "build", targetHandle: "input-0" }],
      ui: { nodePositions: {} },
    };
    const saved = await request("/api/workspace/graph", { flowId: "jenkins-restart", flowSource: "user", graph });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const run = await request("/api/workspace/run", { flowId: "jenkins-restart", flowSource: "user", runNodeId: "run", graph: saved.body.graph });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.deferred, true);
    assert.equal(triggerCount, 1);
    assert.equal(Object.keys(readWorkspaceDeferredRunRegistry().runs).length, 1);

    await closeServer(agentflowServer);
    agentflowServer = null;
    started = await startAgentflow();
    agentflowServer = started.server;

    pollWorkspaceDeferredRuns(workspaceRoot, Date.now() + 60_000);
    await waitFor(() => Object.values(readWorkspaceDeferredRunRegistry().runs)[0]?.phase === "running");
    pollWorkspaceDeferredRuns(workspaceRoot, Date.now() + 60_000);
    await waitFor(() => Object.keys(readWorkspaceDeferredRunRegistry().runs).length === 0);
    assert.equal(triggerCount, 1, "restart recovery must resume the checkpoint instead of triggering again");

    const stored = await request("/api/workspace/graph?flowId=jenkins-restart&flowSource=user");
    assert.equal(stored.body.graph.instances.build.output.find((slot) => slot.name === "status")?.value, "SUCCESS");
  } finally {
    await closeServer(agentflowServer);
    await closeServer(jenkinsServer);
    if (previous.home == null) delete process.env.AGENTFLOW_HOME; else process.env.AGENTFLOW_HOME = previous.home;
    if (previous.baseUrl == null) delete process.env.JENKINS_BASE_URL; else process.env.JENKINS_BASE_URL = previous.baseUrl;
    if (previous.username == null) delete process.env.JENKINS_USERNAME; else process.env.JENKINS_USERNAME = previous.username;
    if (previous.token == null) delete process.env.JENKINS_TOKEN; else process.env.JENKINS_TOKEN = previous.token;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
