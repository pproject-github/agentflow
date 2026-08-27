/**
 * 代码化的流程能发布到平台。
 *
 * 发布通道两端以前都只认 `flow.yaml`：CLI 只读 yaml 文件，`/api/flows/import` 找不到
 * `flow.yaml` 就直接拒收。而代码化早就是权威存储格式，于是「把本地流程发到平台」这条路对新
 * 流程是断的——`agentflow flow dsl migrate` 之后反而发不出去了。
 *
 * 两端都改成认 `FLOW_MARKER_FILENAMES`。这条从 CLI 一路跑到磁盘，确认发上去的确实是那份代码，
 * 并且读回来是同一张图。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SOURCE = `import { display, flow, provide } from "agentflow/flow";

const greeting = provide.str("问候语", { value: "hello" });
const show = display.markdown("展示", { content: greeting.value });

export const run = flow("Run", show);
`;

test("publish-flow 能发布代码化的流程目录，落到平台上还是同一张图", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-publish-code-")));
  const workspaceRoot = path.join(tempRoot, "project");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }, store] = await Promise.all([
      import(`../bin/lib/auth.mjs?publish-code=${nonce}`),
      import(`../bin/lib/ui-server.mjs?publish-code=${nonce}`),
      import("../bin/lib/workspace-flow-store.mjs"),
    ]);
    const user = loginOrCreateUser("code-publisher", "publisher-password");
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

    // 只有代码的流程目录——一行 yaml 都没有
    const flowDir = path.join(tempRoot, "my-code-flow");
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(flowDir, "workspace.flow.js"), SOURCE, "utf-8");

    const { stdout } = await cli(
      "publish-flow", "--flow-id", "code-flow", "--file", flowDir, "--target-space", "workspace",
    );
    const result = JSON.parse(stdout);
    assert.equal(result.success, true, stdout);
    assert.equal(result.action, "created");

    // 平台侧落盘的就是那份代码，读回来是同一张图
    const landed = path.join(workspaceRoot, ".workspace", "agentflow", "pipelines", "code-flow");
    assert.ok(fs.existsSync(path.join(landed, "workspace.flow.js")), "发上去的应当是代码本身");
    assert.ok(!fs.existsSync(path.join(landed, "flow.yaml")), "不该再凭空补一个 yaml 外壳");
    const read = store.readWorkspaceGraphFiles(landed);
    assert.equal(read.format, "dsl");
    assert.deepEqual(Object.keys(read.graph.instances).sort(), ["greeting", "run", "show"]);

    // 单独指一个 workspace.flow.js 也行
    const { stdout: single } = await cli(
      "publish-flow", "--flow-id", "code-flow-2",
      "--file", path.join(flowDir, "workspace.flow.js"), "--target-space", "workspace",
    );
    assert.equal(JSON.parse(single).success, true, single);

    // --replace 走 Workspace 图那条路，而不是把代码退回成 yaml
    fs.writeFileSync(
      path.join(flowDir, "workspace.flow.js"),
      SOURCE.replace('value: "hello"', 'value: "hello again"'),
      "utf-8",
    );
    const { stdout: replaced } = await cli(
      "publish-flow", "--flow-id", "code-flow", "--file", flowDir,
      "--target-space", "workspace", "--replace",
    );
    assert.equal(JSON.parse(replaced).action, "replaced", replaced);
    assert.ok(!fs.existsSync(path.join(landed, "flow.yaml")), "更新之后也不该冒出 yaml");
    const after = store.readWorkspaceGraphFiles(landed);
    assert.equal(after.format, "dsl", "更新之后仍然是代码化存储");
    assert.match(
      fs.readFileSync(path.join(landed, "workspace.flow.js"), "utf-8"),
      /hello again/,
      "改动要真的落到平台上",
    );

    // 带不走的东西要当场拒绝，而不是悄悄发一个残缺的流程上去
    fs.mkdirSync(path.join(flowDir, "nodes", "say"), { recursive: true });
    fs.writeFileSync(path.join(flowDir, "nodes", "say", "index.mjs"), "export default {};\n", "utf-8");
    await assert.rejects(
      () => cli("publish-flow", "--flow-id", "code-flow-3", "--file", flowDir, "--target-space", "workspace"),
      (e) => /single-file upload cannot carry/.test(String(e?.stderr || e?.message || "")),
      "目录里有 nodes/ 时必须报错——单文件上传带不走代码节点包",
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
