import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 代码节点包的输出要真的回到输出槽里。
 *
 * 以前「哪个槽是结果正文」这条规则在 ui-server 里写了 6 遍，判据都是 `index === 0`；
 * 而规范槽序是 `[next, <主输出>]`，下标 0 是控制槽。于是自定义名字的输出槽（`total`）
 * 在写文件那层被当成 result 写，在回填那层又不认它是 result，值卡在中间谁也拿不到。
 */
async function withFlow(run) {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-node-out-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?node-out=${nonce}`),
      import(`../bin/lib/ui-server.mjs?node-out=${nonce}`),
    ]);
    const user = loginOrCreateUser("node-out-owner", "node-out-password");
    server = await startUiServer({
      workspaceRoot: path.join(tempRoot, "workspace"),
      host: "127.0.0.1", port: 0, staticDir: path.join(tempRoot, "static"),
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const auth = { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" };
    const api = {
      get: async (p) => (await fetch(base + p, { headers: auth })).json(),
      post: async (p, body) => {
        const res = await fetch(base + p, { method: "POST", headers: auth, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
      },
    };
    await run(api);
  } finally {
    if (server) server.close();
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const packageSource = (outName, withLog) => `import fs from "node:fs/promises";
export default {
  id: "probe", version: "1.0.0", name: "探针",
  inputs: {},
  outputs: { ${outName}: { type: "text" } },
};
export async function run(inputs, outputs) {
  await fs.writeFile(outputs.${outName}, "文件里的值");
  ${withLog ? 'console.log("进度日志");' : ""}
}
`;

/** 建一个带代码节点包的流程，跑一次，返回主输出槽的值和下游展示节点的正文。 */
async function runPackageFlow(api, flowId, outName, withLog) {
  await api.post("/api/flows", { flowId, targetSpace: "user" });
  const seeded = await api.get(`/api/workspace/graph?flowId=${flowId}&flowSource=user`);
  fs.mkdirSync(path.join(seeded.root, "nodes", "probe"), { recursive: true });
  fs.writeFileSync(path.join(seeded.root, "nodes", "probe", "index.mjs"), packageSource(outName, withLog), "utf-8");

  const list = await api.get(`/api/nodes?flowId=${flowId}&flowSource=user`);
  const pkg = (Array.isArray(list) ? list : list.nodes || []).find((n) => String(n.id).includes("probe"));
  assert.ok(pkg, "流程目录里的代码节点包没有进面板");

  const graph = {
    version: 1,
    instances: {
      run_1: { definitionId: "workspace_run", label: "Run",
        input: [{ type: "node", name: "prev", value: "" }],
        output: [{ type: "node", name: "next", value: "" }] },
      probe_1: { definitionId: pkg.baseDefinitionId, label: "探针",
        marketplaceRef: pkg.marketplaceDefinitionId,
        marketplacePackageId: pkg.packageId, marketplaceVersion: pkg.version,
        input: [{ type: "node", name: "prev", value: "" }],
        output: [{ type: "node", name: "next", value: "" }, { type: "text", name: outName, value: "" }] },
      md_1: { definitionId: "display_markdown", label: "展示",
        input: [{ type: "node", name: "prev", value: "" }, { type: "text", name: "content", value: "" }],
        output: [{ type: "text", name: "content", value: "" }, { type: "node", name: "next", value: "" }] },
    },
    edges: [
      { source: "run_1", sourceHandle: "output-0", target: "probe_1", targetHandle: "input-0" },
      { source: "probe_1", sourceHandle: "output-0", target: "md_1", targetHandle: "input-0" },
      { source: "probe_1", sourceHandle: "output-1", target: "md_1", targetHandle: "input-1" },
    ],
    ui: { nodePositions: {} },
  };
  const saved = await api.post("/api/workspace/graph", { flowId, flowSource: "user", graph });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const run = await api.post("/api/workspace/run", { flowId, flowSource: "user", runNodeId: "run_1", graph: saved.body.graph });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.ok, true);
  const probe = run.body.graph.instances.probe_1;
  return {
    slot: String(probe.output.find((s) => s.name === outName)?.value ?? ""),
    display: String(run.body.graph.instances.md_1.body ?? ""),
  };
}

test("自定义名字的输出槽也能拿到值，下游读到的是内容", async () => {
  await withFlow(async (api) => {
    for (const [n, outName] of [[1, "result"], [2, "total"]]) {
      const out = await runPackageFlow(api, `p${n}`, outName, false);
      assert.ok(out.slot, `槽 ${outName} 没拿到值——这正是 index === 0 那条规则漏掉的情况`);
      assert.match(out.slot, new RegExp(`${outName}\\.txt$`), `槽里应当是自己那个输出文件`);
      assert.equal(out.display, "文件里的值", "下游拿到的应当是文件内容，不是路径");
    }
  });
});

test("节点打印进度日志，不会盖掉它明确写出来的输出文件", async () => {
  await withFlow(async (api) => {
    for (const [n, outName] of [[3, "result"], [4, "total"]]) {
      const out = await runPackageFlow(api, `p${n}`, outName, true);
      assert.equal(out.display, "文件里的值", `${outName}: console.log 把输出文件吃掉了`);
      assert.match(out.slot, new RegExp(`${outName}\\.txt$`));
    }
  });
});

test("只写了非主输出槽时，那个槽照样拿到值，不会被当成结果正文吞掉", async () => {
  await withFlow(async (api) => {
    const flowId = "partial";
    await api.post("/api/flows", { flowId, targetSpace: "user" });
    const seeded = await api.get(`/api/workspace/graph?flowId=${flowId}&flowSource=user`);
    fs.mkdirSync(path.join(seeded.root, "nodes", "partial"), { recursive: true });
    // 声明两个输出，只写后一个——分支里常见
    fs.writeFileSync(path.join(seeded.root, "nodes", "partial", "index.mjs"), `import fs from "node:fs/promises";
export default {
  id: "partial", version: "1.0.0", name: "只写一个",
  inputs: {},
  outputs: { total: { type: "text" }, extra: { type: "text" } },
};
export async function run(inputs, outputs) {
  await fs.writeFile(outputs.extra, "附带的值");
}
`, "utf-8");

    const list = await api.get(`/api/nodes?flowId=${flowId}&flowSource=user`);
    const pkg = (Array.isArray(list) ? list : list.nodes || []).find((n) => String(n.id).includes("partial"));
    const graph = {
      version: 1,
      instances: {
        run_1: { definitionId: "workspace_run", label: "Run",
          input: [{ type: "node", name: "prev", value: "" }],
          output: [{ type: "node", name: "next", value: "" }] },
        p_1: { definitionId: pkg.baseDefinitionId, label: "只写一个",
          marketplaceRef: pkg.marketplaceDefinitionId,
          marketplacePackageId: pkg.packageId, marketplaceVersion: pkg.version,
          input: [{ type: "node", name: "prev", value: "" }],
          output: [
            { type: "node", name: "next", value: "" },
            { type: "text", name: "total", value: "" },
            { type: "text", name: "extra", value: "" },
          ] },
      },
      edges: [{ source: "run_1", sourceHandle: "output-0", target: "p_1", targetHandle: "input-0" }],
      ui: { nodePositions: {} },
    };
    const saved = await api.post("/api/workspace/graph", { flowId, flowSource: "user", graph });
    const run = await api.post("/api/workspace/run", { flowId, flowSource: "user", runNodeId: "run_1", graph: saved.body.graph });
    assert.equal(run.body.ok, true, JSON.stringify(run.body).slice(0, 300));
    const slots = run.body.graph.instances.p_1.output;
    // extra 不是主输出槽，不能因为「它是唯一写出来的文件」就被当成结果正文
    assert.match(
      String(slots.find((s) => s.name === "extra")?.value ?? ""),
      /extra\.txt$/,
      "extra 应当拿到自己的输出文件",
    );
    assert.equal(String(slots.find((s) => s.name === "total")?.value ?? ""), "", "没写的主输出槽应当留空");
  });
});

test("没有写输出文件时，stdout 仍然是节点结果", async () => {
  await withFlow(async (api) => {
    const flowId = "plain";
    await api.post("/api/flows", { flowId, targetSpace: "user" });
    const graph = {
      version: 1,
      instances: {
        run_1: { definitionId: "workspace_run", label: "Run",
          input: [{ type: "node", name: "prev", value: "" }],
          output: [{ type: "node", name: "next", value: "" }] },
        say: { definitionId: "tool_nodejs", label: "打招呼",
          script: "node -e \"console.log('hi')\"",
          input: [{ type: "node", name: "prev", value: "" }],
          output: [{ type: "node", name: "next", value: "" }, { type: "text", name: "result", value: "" }] },
      },
      edges: [{ source: "run_1", sourceHandle: "output-0", target: "say", targetHandle: "input-0" }],
      ui: { nodePositions: {} },
    };
    const saved = await api.post("/api/workspace/graph", { flowId, flowSource: "user", graph });
    const run = await api.post("/api/workspace/run", { flowId, flowSource: "user", runNodeId: "run_1", graph: saved.body.graph });
    assert.equal(run.body.ok, true);
    assert.equal(run.body.graph.instances.say.output.find((s) => s.name === "result").value, "hi");
  });
});
