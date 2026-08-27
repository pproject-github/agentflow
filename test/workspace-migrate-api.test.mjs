/**
 * 平台上的 yaml 流程要能就地迁进 Workspace。
 *
 * 本地 `agentflow flow dsl migrate` 只能救本机磁盘上的流程。部署出去的那些——挂在别人账号
 * 下、只有列表里看得见的空图——需要一条走 HTTP 的同款出口，否则「摘掉 flow.yaml 哨兵」这
 * 件事永远缺一个前提。
 *
 * 这条从 CLI 一路跑到平台磁盘：迁之前画布是空的，迁之后读回来是同一张图。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LEGACY_YAML = `instances:
  start:
    definitionId: control_start
    label: Start
    input: []
    output: [{type: node, name: next}]
  work:
    definitionId: agent_subAgent
    label: 分析
    input: [{type: node, name: prev}]
    output: [{type: node, name: next}, {type: text, name: summary}]
    body: 写一份说明到 \${summary}
  show:
    definitionId: tool_print
    label: 展示
    input: [{type: node, name: prev}, {type: text, name: summary}]
    output: [{type: node, name: next}]
  done:
    definitionId: control_end
    input: [{type: node, name: prev}]
    output: []
edges:
  - {source: start, target: work, sourceHandle: output-0, targetHandle: input-0}
  - {source: work, target: show, sourceHandle: output-0, targetHandle: input-0}
  - {source: work, target: show, sourceHandle: output-1, targetHandle: input-1}
  - {source: show, target: done, sourceHandle: output-0, targetHandle: input-0}
ui:
  description: 平台上的老流程
  nodePositions: {start: {x: 100, y: 300}, work: {x: 380, y: 300}, show: {x: 660, y: 300}, done: {x: 940, y: 300}}
`;

/** control_anyOne 在 Workspace 里没有对等物——用来验默认拒绝有损。 */
const LOSSY_YAML = `instances:
  start: {definitionId: control_start, output: [{type: node, name: next}]}
  join:
    definitionId: control_anyOne
    input: [{type: node, name: prev1}, {type: node, name: prev2}]
    output: [{type: node, name: next}]
  work: {definitionId: agent_subAgent, input: [{type: node, name: prev}], output: [{type: node, name: next}]}
edges:
  - {source: start, target: join, sourceHandle: output-0, targetHandle: input-0}
  - {source: join, target: work, sourceHandle: output-0, targetHandle: input-0}
ui: {nodePositions: {}}
`;

test("migrate-flow 把平台上的 yaml 流程就地迁成 Workspace 图", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-migapi-")));
  const workspaceRoot = path.join(tempRoot, "project");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }, store] = await Promise.all([
      import(`../bin/lib/auth.mjs?migapi=${nonce}`),
      import(`../bin/lib/ui-server.mjs?migapi=${nonce}`),
      import("../bin/lib/workspace-flow-store.mjs"),
    ]);
    const user = loginOrCreateUser("migrator", "migrator-password");
    assert.equal(user.ok, true);
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const cliPath = path.resolve("skills/agentflow-cli/scripts/agentflow-cli.mjs");
    const cli = (...extra) => execFileAsync(process.execPath, [
      cliPath, ...extra, "--base-url", baseUrl, "--token", user.token,
    ]);

    const pipelines = path.join(workspaceRoot, ".workspace", "agentflow", "pipelines");
    const seed = (id, yamlText) => {
      const dir = path.join(pipelines, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "flow.yaml"), yamlText, "utf-8");
      return dir;
    };

    // ── 迁之前：列表里有，画布上是空的 ────────────────────────────────────
    const legacyDir = seed("legacy-flow", LEGACY_YAML);
    assert.equal(store.readWorkspaceGraphFiles(legacyDir).format, "empty", "yaml 流程读出来就是空图");

    const { stdout } = await cli(
      "migrate-flow", "--flow-id", "legacy-flow", "--flow-source", "workspace",
    );
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true, stdout);
    assert.equal(result.migrated, true, result.degradedReason || stdout);
    assert.equal(result.source, "flow.yaml");

    // 换词清单要如实回给调用方——这是这条命令唯一的卖点
    assert.deepEqual(
      result.remapped.map((r) => [r.from, r.to]).sort(),
      [["control_start", "workspace_run"], ["tool_print", "display_markdown"]],
    );
    assert.deepEqual(result.dropped.map((d) => [d.definitionId, d.benign]), [["control_end", true]]);

    // ── 迁之后：平台磁盘上是代码，读回来是同一张图 ────────────────────────
    assert.ok(fs.existsSync(path.join(legacyDir, "workspace.flow.js")));
    assert.ok(fs.existsSync(path.join(legacyDir, "flow.yaml")), "原文留着");
    const read = store.readWorkspaceGraphFiles(legacyDir);
    assert.equal(read.format, "dsl");
    assert.deepEqual(Object.keys(read.graph.instances).sort(), ["show", "start", "work"]);
    assert.equal(read.graph.instances.start.definitionId, "workspace_run");
    assert.equal(read.graph.instances.show.definitionId, "display_markdown");

    // 走 HTTP 也读得到同一张图了（之前这里是空的）
    const graphResp = await fetch(
      `${baseUrl}/api/workspace/graph?flowId=legacy-flow&flowSource=workspace`,
      { headers: { Authorization: `Bearer ${user.token}` } },
    );
    assert.equal(graphResp.status, 200);
    const graphBody = await graphResp.json();
    assert.deepEqual(Object.keys(graphBody.graph.instances).sort(), ["show", "start", "work"]);

    // ── 有损的默认拒绝，磁盘不动 ──────────────────────────────────────────
    const lossyDir = seed("lossy-flow", LOSSY_YAML);
    const { stdout: refusedOut } = await cli(
      "migrate-flow", "--flow-id", "lossy-flow", "--flow-source", "workspace",
    ).catch((e) => ({ stdout: e.stdout }));
    const refused = JSON.parse(refusedOut);
    assert.equal(refused.migrated, false);
    assert.match(refused.degradedReason, /--allow-loss/);
    assert.deepEqual(refused.dropped.map((d) => d.definitionId), ["control_anyOne"]);
    assert.deepEqual(fs.readdirSync(lossyDir), ["flow.yaml"], "拒绝时磁盘一个字节都不该动");

    // 看过清单认了，才落盘
    const { stdout: forcedOut } = await cli(
      "migrate-flow", "--flow-id", "lossy-flow", "--flow-source", "workspace", "--allow-loss",
    );
    assert.equal(JSON.parse(forcedOut).leftYaml, true, forcedOut);
    assert.notEqual(store.readWorkspaceGraphFiles(lossyDir).format, "empty");

    // ── 已经是代码的流程再迁一次，是个空操作 ──────────────────────────────
    const { stdout: againOut } = await cli(
      "migrate-flow", "--flow-id", "legacy-flow", "--flow-source", "workspace",
    );
    const again = JSON.parse(againOut);
    assert.equal(again.format, "dsl");
    assert.equal(again.migrated, false, "已经是代码形态就什么都不做");

    // ── builtin 只读，不能迁 ──────────────────────────────────────────────
    const builtinResp = await fetch(`${baseUrl}/api/workspace/migrate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ flowId: "legacy-flow", flowSource: "builtin" }),
    });
    assert.equal(builtinResp.status, 400);

    // ── migrate-all：无损的全做掉，有损的一个不碰 ─────────────────────────
    // 平台上的实际分布就是这样：大头是 graph.json（换格式无损），少数 yaml 需要人决定。
    const graphOnly = path.join(pipelines, "graph-flow");
    fs.mkdirSync(graphOnly, { recursive: true });
    fs.writeFileSync(path.join(graphOnly, "workspace.graph.json"), JSON.stringify({
      version: 1,
      instances: {
        run: {
          definitionId: "workspace_run",
          label: "Run",
          input: [{ type: "node", name: "prev", value: "" }],
          output: [{ type: "node", name: "next", value: "" }],
        },
        note: {
          definitionId: "display_markdown",
          label: "说明",
          input: [
            { type: "node", name: "prev", value: "" },
            { type: "text", name: "content", value: "hi", required: true, showOnNode: true },
          ],
          output: [
            { type: "text", name: "content", value: "hi", showOnNode: true },
            { type: "node", name: "next", value: "" },
          ],
        },
      },
      edges: [{ source: "run", target: "note", sourceHandle: "output-0", targetHandle: "input-0" }],
      ui: { nodePositions: { run: { x: 80, y: 180 }, note: { x: 380, y: 180 } }, nodeSizes: {} },
    }, null, 2), "utf-8");
    seed("still-lossy", LOSSY_YAML);

    const { stdout: allOut } = await cli("migrate-all");
    const all = JSON.parse(allOut);
    const rowOf = (id) => all.rows.find((r) => r.flow.startsWith(id));

    assert.equal(rowOf("graph-flow").result, "→ 代码", "graph.json 换格式无损，直接做掉");
    assert.equal(rowOf("legacy-flow").result, "已是代码，跳过", "重复跑要幂等");
    assert.match(rowOf("still-lossy").result, /^拒绝：有损/);
    assert.deepEqual(all.needsDecision, ["still-lossy [workspace]"], "要人决定的只该有这一个");
    assert.match(all.hint, /migrate-flow --allow-loss/);

    // 被拒绝的那个磁盘没动
    assert.deepEqual(fs.readdirSync(path.join(pipelines, "still-lossy")), ["flow.yaml"]);
    assert.equal(store.readWorkspaceGraphFiles(graphOnly).format, "dsl");

    // ── 归档流程要显式豁免才写 ────────────────────────────────────────────
    // 「归档 + 仅 yaml」恰恰是摘掉哨兵时会凭空消失的那种：没人会再打开保存，所以只会
    // 一直停在死格式上。默认不写，但必须给得出一条路。
    const archivedDir = path.join(pipelines, "_archived", "old-flow");
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(path.join(archivedDir, "flow.yaml"), LEGACY_YAML, "utf-8");
    const post = (body) => fetch(`${baseUrl}/api/workspace/migrate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const refusedArchived = await post({ flowId: "old-flow", flowSource: "workspace", archived: true });
    assert.equal(refusedArchived.status, 400);
    assert.match((await refusedArchived.json()).error, /allowArchived/);
    assert.deepEqual(fs.readdirSync(archivedDir), ["flow.yaml"], "没豁免就一个字节都不写");

    const okArchived = await post({
      flowId: "old-flow", flowSource: "workspace", archived: true, allowArchived: true,
    });
    assert.equal(okArchived.status, 200);
    assert.equal((await okArchived.json()).migrated, true);
    assert.equal(store.readWorkspaceGraphFiles(archivedDir).format, "dsl");

    // migrate-all 默认不碰归档，加了开关才连归档一起做
    const archivedYaml = path.join(pipelines, "_archived", "old-yaml");
    fs.mkdirSync(archivedYaml, { recursive: true });
    fs.writeFileSync(path.join(archivedYaml, "flow.yaml"), LEGACY_YAML, "utf-8");
    await cli("migrate-all");
    assert.deepEqual(fs.readdirSync(archivedYaml), ["flow.yaml"], "默认跳过归档");
    await cli("migrate-all", "--include-archived");
    assert.equal(store.readWorkspaceGraphFiles(archivedYaml).format, "dsl");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
