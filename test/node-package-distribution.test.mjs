/**
 * 节点包的真实分发闭环：多文件目录 -> ZIP 上传 -> 平台不可变存储 -> 另一工作区下载安装
 * -> DSL 静态解析 -> 本地运行。这里故意让服务端和客户端使用两个独立根目录，避免“下载”
 * 实际上只是碰巧读到了发布端文件。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { zipSync } from "fflate";
import { lintFlowDir } from "../bin/lib/flow-dsl/lint.mjs";
import { readWorkspaceGraphFiles } from "../bin/lib/workspace-flow-store.mjs";
import { resolveMarketplaceNodePackage } from "../bin/lib/marketplace.mjs";

const execFileAsync = promisify(execFile);

const ENTRY = `import fs from "node:fs/promises";
import { decorate } from "./scripts/decorate.mjs";

export default {
  id: "portable_greeting",
  version: "1.0.0",
  name: "可移植问候",
  description: "验证多文件节点包分发",
  inputs: { name: { type: "text", required: true } },
  outputs: { result: { type: "text" } },
};

export async function run(inputs, outputs) {
  const template = await fs.readFile(new URL("./templates/greeting.txt", import.meta.url), "utf-8");
  await fs.writeFile(outputs.result, decorate(template.replace("{{name}}", inputs.name)));
}
`;

const FLOW = `import { display, flow } from "agentflow/flow";
import portableGreeting from "marketplace:portable_greeting@1.0.0";

const greeting = portableGreeting("问候", { name: "AgentFlow" });
const result = display.markdown("结果", { content: greeting.result });
export const run = flow("Run", greeting);
`;

test("多文件 ZIP 节点包能跨工作区发布、安装、编排并执行", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-node-distribution-")));
  const serverRoot = path.join(tempRoot, "server-project");
  const clientRoot = path.join(tempRoot, "client-project");
  const packageDir = path.join(tempRoot, "portable-greeting");
  fs.mkdirSync(path.join(packageDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "templates"), { recursive: true });
  fs.mkdirSync(serverRoot, { recursive: true });
  fs.mkdirSync(clientRoot, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "index.mjs"), ENTRY, "utf-8");
  fs.writeFileSync(path.join(packageDir, "scripts", "decorate.mjs"), "export const decorate = (text) => `<<${text.trim()}>>`;\n", "utf-8");
  fs.writeFileSync(path.join(packageDir, "templates", "greeting.txt"), "你好，{{name}}！\n", "utf-8");

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?node-distribution=${nonce}`),
      import(`../bin/lib/ui-server.mjs?node-distribution=${nonce}`),
    ]);
    const user = loginOrCreateUser("node-publisher", "publisher-password");
    assert.equal(user.ok, true);
    server = await startUiServer({
      workspaceRoot: serverRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    // 模拟 SkillHub 安装：skill 本身在源码树外，命令从干净 workspace 运行，直接使用
    // Skill 自带 Runtime，不依赖 npm 包、源码相对路径或 PATH 中的 agentflow。
    const installedSkillDir = path.join(tempRoot, "installed-skills", "agentflow-cli");
    fs.cpSync(path.resolve("skills/agentflow-cli"), installedSkillDir, { recursive: true });
    const cliPath = path.join(installedSkillDir, "scripts", "agentflow-cli.mjs");
    const cliEnv = { ...process.env };
    delete cliEnv.AGENTFLOW_PACKAGE_ROOT;
    const cli = (...extra) => execFileAsync(process.execPath, [
      cliPath,
      ...extra,
      "--base-url", baseUrl,
      "--token", user.token,
    ], { cwd: clientRoot, env: cliEnv });

    const { stdout: configOut } = await cli("config");
    const config = JSON.parse(configOut);
    assert.equal(config.localRuntime.available, true, configOut);
    assert.equal(config.localRuntime.root, path.join(installedSkillDir, "runtime"));

    const { stdout: publishedOut } = await cli("node-package-publish", "--file", packageDir);
    const published = JSON.parse(publishedOut);
    assert.equal(published.ok, true, publishedOut);
    assert.deepEqual(published.fileList, ["index.mjs", "scripts/decorate.mjs", "templates/greeting.txt"]);

    const { stdout: listOut } = await cli("node-package-list");
    const listed = JSON.parse(listOut).nodes.find((node) => node.id === "portable_greeting");
    assert.ok(listed, listOut);
    assert.equal(listed.fileCount, 3);
    assert.match(listed.contentSha256, /^[a-f0-9]{64}$/);

    // 重复上传同一内容是幂等；相同 id@version 换内容则必须拒绝，防止下发结果不可复现。
    const { stdout: duplicateOut } = await cli("node-package-publish", "--file", packageDir);
    assert.equal(JSON.parse(duplicateOut).alreadyExists, true);
    fs.writeFileSync(path.join(packageDir, "templates", "greeting.txt"), "您好，{{name}}！\n", "utf-8");
    await assert.rejects(
      () => cli("node-package-publish", "--file", packageDir),
      (error) => /已存在且内容不同|HTTP 409/.test(String(error?.stderr || error?.message || "")),
    );

    const flowDir = path.join(clientRoot, ".workspace", "agentflow", "pipelines", "uses-portable-node");
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(flowDir, "workspace.flow.js"), FLOW, "utf-8");

    // 串联点：接收端只拿到 Flow，sync 从版本化 import 推导依赖并批量安装，不再逐个手输包名。
    const { stdout: installedOut } = await cli(
      "node-package-sync",
      "--flow", flowDir,
      "--workspace-root", clientRoot,
    );
    const installed = JSON.parse(installedOut);
    assert.equal(installed.ok, true, installedOut);
    assert.deepEqual(installed.installed.map((item) => item.specifier), ["marketplace:portable_greeting@1.0.0"]);
    const installedDir = path.join(
      clientRoot, ".workspace", "agentflow", "marketplace", "packages", "nodes", "portable_greeting", "1.0.0",
    );
    assert.equal(fs.readFileSync(path.join(installedDir, "templates", "greeting.txt"), "utf-8"), "你好，{{name}}！\n");
    assert.ok(fs.existsSync(path.join(installedDir, "scripts", "decorate.mjs")));
    const receipt = JSON.parse(fs.readFileSync(path.join(installedDir, ".agentflow-package.json"), "utf-8"));
    assert.equal(receipt.installedFrom, baseUrl);
    assert.match(receipt.installedAt, /^\d{4}-\d{2}-\d{2}T/);

    const { stdout: unchangedOut } = await cli(
      "node-package-sync", "--flow", flowDir, "--workspace-root", clientRoot,
    );
    const unchanged = JSON.parse(unchangedOut);
    assert.equal(unchanged.ok, true, unchangedOut);
    assert.deepEqual(unchanged.unchanged.map((item) => item.specifier), ["marketplace:portable_greeting@1.0.0"]);
    assert.deepEqual(unchanged.installed, []);

    assert.deepEqual(lintFlowDir(flowDir, { workspaceRoot: clientRoot }).errors, []);
    const graph = readWorkspaceGraphFiles(flowDir, { marketplaceRoot: clientRoot }).graph;
    assert.equal(graph.instances.greeting.marketplaceRef, "marketplace:portable_greeting@1.0.0");
    assert.deepEqual(graph.instances.greeting.output.map((slot) => slot.name), ["next", "result"]);

    // 本地 AI 产出的 DSL 可以直接上传；服务端用已上传的同版本节点包解析，不依赖客户端路径。
    const { stdout: flowPublishedOut } = await cli(
      "publish-flow",
      "--flow-id", "portable-node-flow",
      "--file", flowDir,
      "--target-space", "workspace",
      "--workspace-root", clientRoot,
    );
    assert.equal(JSON.parse(flowPublishedOut).success, true, flowPublishedOut);
    assert.deepEqual(JSON.parse(flowPublishedOut).nodeDependencies, ["marketplace:portable_greeting@1.0.0"]);
    const serverFlowDir = path.join(serverRoot, ".workspace", "agentflow", "pipelines", "portable-node-flow");
    const serverGraph = readWorkspaceGraphFiles(serverFlowDir, { marketplaceRoot: serverRoot }).graph;
    assert.equal(serverGraph.instances.greeting.marketplaceRef, "marketplace:portable_greeting@1.0.0");

    // 一键发布：本地 flow 仍 import ./nodes，CLI 自动上传整个包目录，并仅在上传产物中
    // 改成精确 marketplace import。远端流程因此不依赖发布者的本地路径。
    const bundledFlowDir = path.join(clientRoot, ".workspace", "agentflow", "pipelines", "bundled-local-node");
    const bundledPackageDir = path.join(bundledFlowDir, "nodes", "portable-greeting");
    fs.mkdirSync(bundledFlowDir, { recursive: true });
    fs.cpSync(packageDir, bundledPackageDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundledPackageDir, "index.mjs"),
      ENTRY.replace('version: "1.0.0"', 'version: "1.1.0"'),
      "utf-8",
    );
    const bundledLocalSource = FLOW.replace(
      '"marketplace:portable_greeting@1.0.0"',
      '"./nodes/portable-greeting"',
    );
    fs.writeFileSync(path.join(bundledFlowDir, "workspace.flow.js"), bundledLocalSource, "utf-8");
    const { stdout: bundledPublishedOut } = await cli(
      "publish-flow",
      "--flow-id", "bundled-local-node",
      "--file", bundledFlowDir,
      "--target-space", "workspace",
      "--with-dependencies",
      "--workspace-root", clientRoot,
    );
    const bundledPublished = JSON.parse(bundledPublishedOut);
    assert.equal(bundledPublished.success, true, bundledPublishedOut);
    assert.deepEqual(bundledPublished.nodeDependencies, ["marketplace:portable_greeting@1.1.0"]);
    assert.deepEqual(
      bundledPublished.publishedNodePackages.map((item) => item.specifier),
      ["marketplace:portable_greeting@1.1.0"],
    );
    assert.deepEqual(bundledPublished.rewrittenImports, [{
      specifier: "./nodes/portable-greeting",
      marketplaceRef: "marketplace:portable_greeting@1.1.0",
      line: 2,
    }]);
    assert.equal(
      fs.readFileSync(path.join(bundledFlowDir, "workspace.flow.js"), "utf-8"),
      bundledLocalSource,
      "发布不能改写 AI 的本地 DSL",
    );
    const bundledServerSource = fs.readFileSync(
      path.join(serverRoot, ".workspace", "agentflow", "pipelines", "bundled-local-node", "workspace.flow.js"),
      "utf-8",
    );
    assert.match(bundledServerSource, /from "marketplace:portable_greeting@1\.1\.0"/);
    assert.ok(!bundledServerSource.includes("./nodes/portable-greeting"));

    // create-only Flow 冲突必须发生在节点包上传之前，不能留下没有 Flow 引用的半次发布。
    fs.writeFileSync(
      path.join(bundledPackageDir, "index.mjs"),
      ENTRY.replace('version: "1.0.0"', 'version: "1.2.0"'),
      "utf-8",
    );
    await assert.rejects(
      () => cli(
        "publish-flow",
        "--flow-id", "bundled-local-node",
        "--file", bundledFlowDir,
        "--target-space", "workspace",
        "--with-dependencies",
      ),
      (error) => /已存在同名流水线/.test(String(error?.stderr || error?.message || "")),
    );
    const { stdout: afterConflictListOut } = await cli("node-package-list");
    assert.equal(
      JSON.parse(afterConflictListOut).nodes.some((node) => node.id === "portable_greeting" && node.version === "1.2.0"),
      false,
      "Flow 409 之前不应上传新节点版本",
    );

    // AI 的目录搜索返回可直接 import/install 的结构化结果。
    const { stdout: searchOut } = await cli("node-package-search", "--query", "多文件节点包分发");
    const search = JSON.parse(searchOut);
    const searchedNode = search.nodes.find((node) => node.specifier === "marketplace:portable_greeting@1.1.0");
    assert.ok(searchedNode, searchOut);
    assert.deepEqual(searchedNode.inputs.map((slot) => slot.name), ["prev", "name"]);
    assert.deepEqual(searchedNode.outputs.map((slot) => slot.name), ["next", "result"]);
    assert.equal(searchedNode.visibility, "public");
    assert.equal(typeof searchedNode.useCount, "number");
    assert.equal(typeof searchedNode.installCount, "number");
    assert.equal(typeof searchedNode.uniqueUserCount, "number");

    // 拉 Flow 会先同步精确节点版本，再生成本地 DSL；接收端不需要手工逐包下载。
    const pullRoot = path.join(tempRoot, "pulled-project");
    fs.mkdirSync(pullRoot, { recursive: true });
    const { stdout: pulledOut } = await cli(
      "pull-flow",
      "--flow-id", "bundled-local-node",
      "--flow-source", "workspace",
      "--workspace-root", pullRoot,
    );
    const pulled = JSON.parse(pulledOut);
    assert.equal(pulled.ok, true, pulledOut);
    assert.deepEqual(
      pulled.nodePackages.installed.map((item) => item.specifier),
      ["marketplace:portable_greeting@1.1.0"],
    );
    const pulledSource = fs.readFileSync(path.join(pulled.outputDir, "workspace.flow.js"), "utf-8");
    assert.match(pulledSource, /from "marketplace:portable_greeting@1\.1\.0"/);
    assert.equal(fs.existsSync(path.join(pulled.outputDir, "workspace.state.json")), false);
    assert.ok(fs.existsSync(path.join(
      pullRoot, ".workspace", "agentflow", "marketplace", "packages", "nodes", "portable_greeting", "1.1.0", "templates", "greeting.txt",
    )));
    await assert.rejects(
      () => cli(
        "pull-flow",
        "--flow-id", "bundled-local-node",
        "--flow-source", "workspace",
        "--workspace-root", pullRoot,
      ),
      (error) => /Pull target is not empty/.test(String(error?.stderr || error?.message || "")),
    );
    const { stdout: repulledOut } = await cli(
      "pull-flow",
      "--flow-id", "bundled-local-node",
      "--flow-source", "workspace",
      "--workspace-root", pullRoot,
      "--replace",
    );
    assert.equal(JSON.parse(repulledOut).ok, true, repulledOut);

    // 绕过 CLI 直接提交图，服务端仍要二次拦截缺包，不能只相信客户端预检。
    const currentGraphResponse = await fetch(
      `${baseUrl}/api/workspace/graph?flowId=portable-node-flow&flowSource=workspace`,
      { headers: { Authorization: `Bearer ${user.token}` } },
    );
    const currentGraphPayload = await currentGraphResponse.json();
    const graphWithMissingPackage = structuredClone(currentGraphPayload.graph);
    graphWithMissingPackage.instances.missing = {
      definitionId: "tool_nodejs",
      marketplaceRef: "marketplace:not_uploaded@9.9.9",
      label: "Missing",
      input: [{ type: "node", name: "prev", value: "" }],
      output: [{ type: "node", name: "next", value: "" }],
    };
    const graphWriteResponse = await fetch(`${baseUrl}/api/workspace/graph`, {
      method: "POST",
      headers: { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        flowId: "portable-node-flow",
        flowSource: "workspace",
        graph: graphWithMissingPackage,
        baseRevision: currentGraphPayload.revision,
      }),
    });
    assert.equal(graphWriteResponse.status, 422);
    const graphWriteError = await graphWriteResponse.json();
    assert.deepEqual(graphWriteError.missingNodePackages, ["marketplace:not_uploaded@9.9.9"]);

    const missingFlowDir = path.join(clientRoot, ".workspace", "agentflow", "pipelines", "missing-node");
    fs.mkdirSync(missingFlowDir, { recursive: true });
    fs.writeFileSync(
      path.join(missingFlowDir, "workspace.flow.js"),
      FLOW.replaceAll("portable_greeting@1.0.0", "not_uploaded@9.9.9"),
      "utf-8",
    );
    await assert.rejects(
      () => cli("node-package-sync", "--flow", missingFlowDir, "--workspace-root", clientRoot),
      (error) => {
        const result = JSON.parse(String(error?.stdout || "{}"));
        return error?.code === 2
          && result.ok === false
          && result.missing?.[0]?.specifier === "marketplace:not_uploaded@9.9.9";
      },
    );
    await assert.rejects(
      () => cli("publish-flow", "--flow-id", "missing-node", "--file", missingFlowDir, "--target-space", "workspace"),
      (error) => /server is missing node packages marketplace:not_uploaded@9\.9\.9/.test(String(error?.stderr || error?.message || "")),
    );

    const resolved = resolveMarketplaceNodePackage(clientRoot, flowDir, "marketplace:portable_greeting@1.0.0");
    assert.equal(resolved?.packageDir, installedDir);
    const runDir = path.join(tempRoot, "run");
    fs.mkdirSync(runDir, { recursive: true });
    const output = path.join(runDir, "result");
    await execFileAsync(process.execPath, [path.resolve("bin/lib/node-package-bootstrap.mjs"), path.join(installedDir, "index.mjs")], {
      cwd: runDir,
      env: {
        ...process.env,
        AGENTFLOW_INPUTS_JSON: JSON.stringify({ name: "AgentFlow" }),
        AGENTFLOW_OUTPUTS_ABS_JSON: JSON.stringify({ result: output }),
        AGENTFLOW_WORKSPACE_ROOT: runDir,
        AGENTFLOW_NODE_RUN_DIR: runDir,
        AGENTFLOW_NODE_TMP_DIR: runDir,
        AGENTFLOW_OUTPUTS_DIR: runDir,
      },
    });
    assert.equal(fs.readFileSync(output, "utf-8"), "<<你好，AgentFlow！>>");

    // 上传入口也要直接拦截 ZIP 路径穿越。
    const unsafe = Buffer.from(zipSync({
      "../escape.txt": new TextEncoder().encode("escape"),
      "index.mjs": new TextEncoder().encode(ENTRY),
    }));
    const form = new FormData();
    form.set("file", new Blob([unsafe], { type: "application/zip" }), "unsafe.zip");
    const unsafeResponse = await fetch(`${baseUrl}/api/node-packages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${user.token}` },
      body: form,
    });
    assert.equal(unsafeResponse.status, 400);
    assert.match(JSON.stringify(await unsafeResponse.json()), /非法或敏感路径/);
    assert.equal(fs.existsSync(path.join(tempRoot, "escape.txt")), false);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
