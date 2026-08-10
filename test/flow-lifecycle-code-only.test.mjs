/**
 * 只有 `workspace.flow.js` 的流程，走真实 HTTP 接口跑完整生命周期。
 *
 * 单测能覆盖到判据本身（见 flow-dir-marker.test.mjs），但「列表里看不看得见」「改名会不会
 * 404」这类问题只在接口层暴露——`flow.yaml` 当哨兵那阵子，正是这些路径把没有 yaml 的目录
 * 判成不存在。顺带钉住新建流程生下来就是代码。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-lifecycle-")));
const workspaceRoot = path.join(tempRoot, "workspace");
fs.mkdirSync(workspaceRoot, { recursive: true });
process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");

const { loginOrCreateUser } = await import("../bin/lib/auth.mjs");
const { startUiServer } = await import("../bin/lib/ui-server.mjs");
const { getUserPipelinesRoot } = await import("../bin/lib/paths.mjs");

const session = loginOrCreateUser("lifecycle", "lifecycle-password");
const server = await startUiServer({
  workspaceRoot,
  host: "127.0.0.1",
  port: 0,
  staticDir: path.join(tempRoot, "static"),
});
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" };
const userPipelines = getUserPipelinesRoot(session.user.userId);

const get = async (p) => {
  const r = await fetch(base + p, { headers });
  return { status: r.status, body: await r.json() };
};
const post = async (p, body) => {
  const r = await fetch(base + p, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 有些错误路径不回 JSON */ }
  return { status: r.status, body: parsed, text };
};

test.after(() => {
  server.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const FLOW_ID = "codeOnly";
const flowDir = path.join(userPipelines, FLOW_ID);
fs.mkdirSync(flowDir, { recursive: true });
fs.writeFileSync(path.join(flowDir, "workspace.flow.js"), `import { display, flow, provide } from "agentflow/flow";

const greeting = provide.str("问候语", { value: "hello" });
const show = display.markdown("展示", { content: greeting.value });

export const run = flow("Run", show);
`, "utf-8");
fs.writeFileSync(path.join(flowDir, "workspace.layout.json"), JSON.stringify({
  version: 1,
  description: "只有代码的流程",
  nodes: { greeting: { x: 80, y: 80 }, show: { x: 420, y: 80 }, run: { x: 80, y: 300 } },
}, null, 2), "utf-8");

test("列表里看得见，说明也读得到", async () => {
  const r = await get("/api/flows");
  const flow = (r.body || []).find((f) => f.id === FLOW_ID);
  assert.ok(flow, "没有 flow.yaml 的目录必须也能被列出来");
  assert.equal(flow.description, "只有代码的流程");
});

test("画布读得出图，也跑得起来", async () => {
  const read = await get(`/api/workspace/graph?flowId=${FLOW_ID}&flowSource=user`);
  assert.equal(read.status, 200);
  assert.equal(Object.keys(read.body.graph.instances).length, 3);

  const run = await post("/api/workspace/run", {
    flowId: FLOW_ID, flowSource: "user", runNodeId: "run", graph: read.body.graph,
  });
  assert.equal(run.status, 200, run.text);
  assert.equal(run.body.graph.instances.show.body, "hello");
});

test("保存回去仍然只有代码，不会凭空长出 flow.yaml", async () => {
  const read = await get(`/api/workspace/graph?flowId=${FLOW_ID}&flowSource=user`);
  const save = await post("/api/workspace/graph", {
    flowId: FLOW_ID, flowSource: "user", graph: read.body.graph,
  });
  assert.equal(save.status, 200, save.text);
  assert.ok(fs.existsSync(path.join(flowDir, "workspace.flow.js")));
  assert.ok(!fs.existsSync(path.join(flowDir, "flow.yaml")));
});

test("改名 / 归档 / 恢复都认这个目录", async () => {
  const renamed = "codeOnlyRenamed";
  const rename = await post("/api/flow/rename", { flowId: FLOW_ID, flowSource: "user", newFlowId: renamed });
  assert.equal(rename.status, 200, rename.text);
  assert.ok(fs.existsSync(path.join(userPipelines, renamed, "workspace.flow.js")));

  const archive = await post("/api/flow/archive", {
    flowId: renamed, flowSource: "user", confirmFlowId: renamed,
  });
  assert.equal(archive.status, 200, archive.text);
  assert.ok(!fs.existsSync(path.join(userPipelines, renamed)), "归档后活动目录该没了");

  const restore = await post("/api/flow/restore", { flowId: renamed, flowSource: "user" });
  assert.equal(restore.status, 200, restore.text);
  assert.ok(fs.existsSync(path.join(userPipelines, renamed, "workspace.flow.js")));
});

test("新建的流程生下来就是代码，不再写空 flow.yaml", async () => {
  const created = await post("/api/flows", {
    flowId: "brandNew", targetSpace: "user", description: "刚建的流程",
  });
  assert.equal(created.status, 200, created.text);

  const dir = path.join(userPipelines, "brandNew");
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    ["workspace.flow.js", "workspace.layout.json"],
    "新流程不该再带一个空的 flow.yaml",
  );

  const list = await get("/api/flows");
  assert.equal((list.body || []).find((f) => f.id === "brandNew")?.description, "刚建的流程");

  const read = await get("/api/workspace/graph?flowId=brandNew&flowSource=user");
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.graph.instances, {}, "空流程就该是空图，不是解析失败");
});
