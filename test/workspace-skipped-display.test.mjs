/**
 * 被 `control_if` 跳过的那一支，展示节点不该有内容。
 *
 * 回填原来是在**上游完成时**做的：谁产出了内容，就顺手写进它直接下游的所有展示节点。问题是
 * 那一刻分支还没判——`control_if` 未选中的那一支上的展示节点也被灌上了新内容，几步之后才被
 * 标记跳过。于是画布和 `workspace.state.json` 里，没走的分支显示着新鲜内容，和真跑过的看不
 * 出区别。
 *
 * 修法不是「跳过时再擦掉」，而是**根本不提前写**：在执行计划里的展示节点轮到自己时会写一遍，
 * 被跳过就什么都不写。提前回填只保留给不在计划里的那一类——只连数据边、没有 `prev` 的展示
 * 节点永远轮不到自己，必须靠上游推。
 *
 * 两头都得测：少写了，旁挂的展示节点就永远空着。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const FLOW_SOURCE = `import { control, display, flow, provide, tool } from "agentflow/flow";

const src = tool.nodejs("源", {}, \`echo hello\`);
const flag = provide.bool("开关", { value: true });

const pass = display.markdown("走到的分支", { content: src.result });
const fail = display.markdown("没走的分支", { content: src.result });

// 只有数据边、没有 prev：不在执行计划里，只能靠上游推过来
const side = display.markdown("旁挂", { content: src.result });

const gate = control.if("判断", { prediction: flag.value }, flow(pass), flow(fail));

export const run = flow("Run", src, gate);
`;

test("跳过的分支不留内容，旁挂的展示节点照常回填", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-skip-display-"));
  const workspaceRoot = path.join(tempRoot, "project");
  const flowDir = path.join(workspaceRoot, ".workspace", "agentflow", "pipelines", "skip-flow");
  fs.mkdirSync(flowDir, { recursive: true });
  fs.writeFileSync(path.join(flowDir, "workspace.flow.js"), FLOW_SOURCE, "utf-8");

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?skip-display=${Date.now()}`),
      import(`../bin/lib/ui-server.mjs?skip-display=${Date.now()}`),
    ]);
    const user = loginOrCreateUser("runner", "runner-password");
    assert.equal(user.ok, true);
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const request = (pathname, init = {}) => fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${user.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
    const flowParams = { flowId: "skip-flow", flowSource: "workspace" };

    const graphRes = await request("/api/workspace/graph?flowId=skip-flow&flowSource=workspace");
    const { graph } = await graphRes.json();
    assert.equal(graphRes.status, 200);

    const runRes = await request("/api/workspace/run", {
      method: "POST",
      body: JSON.stringify({ ...flowParams, runNodeId: "run", graph }),
    });
    const runJson = await runRes.json();
    assert.equal(runRes.status, 200, JSON.stringify(runJson).slice(0, 400));

    const events = Array.isArray(runJson.events) ? runJson.events : [];
    const skipped = events.find((e) => e.type === "node-done" && e.nodeId === "fail" && e.skipped === true);
    assert.ok(skipped, "fail 应当被 control_if 跳过");

    const state = JSON.parse(fs.readFileSync(path.join(flowDir, "workspace.state.json"), "utf-8"));
    const bodies = state.displayBodies || {};
    assert.equal(bodies.pass, "hello", "走到的分支要有内容");
    assert.equal(bodies.side, "hello", "旁挂的展示节点不在计划里，必须靠上游回填");
    assert.ok(
      !("fail" in bodies),
      `没走的分支不该留下内容，实际：${JSON.stringify(bodies)}`,
    );

    // 画布侧同理：任何一条事件都不该把 fail 报成「内容更新了」
    for (const event of events) {
      const ids = Array.isArray(event?.displayNodeIds) ? event.displayNodeIds : [];
      assert.ok(!ids.includes("fail"), `事件把 fail 报成内容已更新：${JSON.stringify(event.displayNodeIds)}`);
    }
    // 而 side 必须被报出来，否则画布上那张卡片不会刷新
    assert.ok(
      events.some((event) => (event?.displayNodeIds || []).includes("side")),
      "旁挂展示节点要出现在某条 graph 事件里，画布才会刷新",
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
