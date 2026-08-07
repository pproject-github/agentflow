#!/usr/bin/env node
/**
 * 代码节点包的执行入口。
 *
 * 由 `workspaceMarketplaceRuntimeCommand` 生成的命令调用：
 *
 *     node <此文件> <entryAbs>
 *
 * 节点包的 `index.mjs` 是个 **模块**，不是脚本——直接 `node index.mjs` 只会定义完就退出。
 * 这里负责把 Workspace 运行时的环境契约翻译成 `run()` 的三个参数：
 *
 *   inputs   来自 AGENTFLOW_INPUTS_JSON，按槽位名取值
 *   outputs  来自 AGENTFLOW_OUTPUTS_ABS_JSON，槽位名 -> 该写入的绝对路径
 *   dirs     workspaceRoot / nodeRunDir / nodeTmpDir / outputsDir
 *
 * 约定与 tool_nodejs 一致：退出码即成败，stdout 即节点 result，不做 JSON 包装。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const entry = process.argv[2];
if (!entry) {
  console.error("node-package-bootstrap: 缺少入口文件参数");
  process.exit(2);
}

const entryAbs = path.resolve(entry);
let mod;
try {
  mod = await import(pathToFileURL(entryAbs).href);
} catch (e) {
  console.error(`节点包入口加载失败 ${entryAbs}: ${(e && e.stack) || e}`);
  process.exit(1);
}

const run = typeof mod.run === "function"
  ? mod.run
  : typeof mod.default?.run === "function"
    ? mod.default.run
    : null;
if (!run) {
  console.error(`节点包 ${entryAbs} 没有导出 run()；请 \`export async function run(inputs, outputs, dirs)\``);
  process.exit(1);
}

const inputs = parseJsonEnv("AGENTFLOW_INPUTS_JSON");
const outputs = parseJsonEnv("AGENTFLOW_OUTPUTS_ABS_JSON");
const dirs = {
  workspaceRoot: process.env.AGENTFLOW_WORKSPACE_ROOT || process.cwd(),
  nodeRunDir: process.env.AGENTFLOW_NODE_RUN_DIR || process.cwd(),
  nodeTmpDir: process.env.AGENTFLOW_NODE_TMP_DIR || process.cwd(),
  outputsDir: process.env.AGENTFLOW_OUTPUTS_DIR || process.cwd(),
};

try {
  await run(inputs, outputs, dirs);
} catch (e) {
  // 节点靠抛错来失败；把栈打到 stderr，退出码非零
  console.error((e && e.stack) || String(e));
  process.exit(1);
}
