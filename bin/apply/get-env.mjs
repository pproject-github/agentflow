#!/usr/bin/env node
/**
 * apply -ai get-env：按 key 从系统环境变量与 ~/.cursor/config.json 读取 value。
 * 优先级：先查 process.env[key]，若无则查 ~/.cursor/config.json（支持点号路径如 openai.apiKey）。
 *
 * 用法（apply 步骤，由 CLI 调用）：
 *   agentflow apply -ai get-env <workspaceRoot> <flowName> <uuid> <instanceId> <execId> <key>
 * 将 value 写入当前 run 的 output 并写 result。
 *
 * 用法（仅 key，兼容/测试）：
 *   agentflow apply -ai get-env <key>
 * 或 node get-env.mjs <key>
 * 仅向 stdout 输出 JSON，不写文件。
 */

import fs from "fs";
import path from "path";
import os from "os";

import { writeResult } from "./write-result.mjs";
import { outputDirForNode, outputNodeBasename } from "./get-exec-id.mjs";

const RUN_BASE_REL = ".workspace/agentflow/runBuild";

function getFromConfig(config, keyStr) {
  if (!config || typeof config !== "object" || !keyStr) return undefined;
  const parts = String(keyStr).trim().split(".");
  let cur = config;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur != null ? String(cur) : undefined;
}

function resolveValue(keyStr) {
  let value = "";
  if (!keyStr) return value;
  value = process.env[keyStr] ?? "";
  if (value === "") {
    const configPath = path.join(os.homedir(), ".cursor", "config.json");
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw);
        const fromConfig = getFromConfig(config, keyStr);
        if (fromConfig !== undefined) value = fromConfig;
      } catch (_) {}
    }
  }
  return value;
}

function main() {
  const argv = process.argv.slice(2);
  const keyStr = (argv[argv.length - 1] != null ? String(argv[argv.length - 1]).trim() : "") || "";
  const value = resolveValue(keyStr);

  if (argv.length >= 6) {
    const [workspaceRoot, flowName, uuid, instanceId, execIdStr] = argv;
    const execId = parseInt(String(execIdStr), 10) || 1;
    const runDir = path.join(path.resolve(workspaceRoot), RUN_BASE_REL, flowName, uuid);
    const outputDir = path.join(runDir, outputDirForNode(instanceId));
    fs.mkdirSync(outputDir, { recursive: true });
    const valueFile = path.join(outputDir, outputNodeBasename(instanceId, execId, "value"));
    const resultFile = path.join(outputDir, outputNodeBasename(instanceId, execId, "result"));
    fs.writeFileSync(valueFile, value, "utf-8");
    fs.writeFileSync(resultFile, value, "utf-8");
    writeResult(workspaceRoot, flowName, uuid, instanceId, {
      status: "success",
      message: "执行完成",
    }, { preserveBody: true, execId });
  } else {
    console.log(
      JSON.stringify({
        err_code: 0,
        message: { result: value, value },
      }),
    );
  }
}

main();
