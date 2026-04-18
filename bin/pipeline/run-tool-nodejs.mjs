#!/usr/bin/env node
/**
 * 运行 tool_nodejs 脚本并将结果写入流水线。
 *
 * 成败判定（Unix 哲学）：
 *   - 进程 exit code 0 → success，非 0 → failed
 *   - 若 stdout 为合法 JSON 且含 err_code，err_code 优先（向后兼容旧脚本）
 *
 * stdout 内容 → result 槽位：
 *   - JSON 模式：提取 message.result
 *   - 纯文本模式：整段 stdout 作为 result
 *
 * 用法：node run-tool-nodejs.mjs <workspaceRoot> <flowName> <uuid> <instanceId> [execId] -- <scriptCmd> [args...]
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { getRunDir } from "../lib/paths.mjs";
import { validateAndParse } from "./validate-script-output.mjs";
import { writeResult } from "./write-result.mjs";
import { backupResolvedOutputsIfExist } from "./backup-resolved-output.mjs";
import { loadExecId, outputNodeBasename, outputDirForNode } from "./get-exec-id.mjs";
import { nodeToolCommandToArgv } from "../lib/normalize-node-tool-command.mjs";
import { buildPipelineScriptPathHint } from "../lib/flow-normalize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function runOnce(workspaceRoot, flowName, uuid, instanceId, execId, scriptArgs) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const outputDir = path.join(runDir, outputDirForNode(instanceId));

  const rawLine = scriptArgs.join(" ");
  const { argv, commandLine: normalizedCmd } = nodeToolCommandToArgv(rawLine);
  const child =
    /^node\s/i.test(String(normalizedCmd).trim()) && argv.length >= 1
      ? spawnSync(process.execPath, argv, {
          cwd: workspaceRoot,
          shell: false,
          stdio: ["inherit", "pipe", "pipe"],
        })
      : spawnSync(normalizedCmd, [], {
          cwd: workspaceRoot,
          shell: true,
          stdio: ["inherit", "pipe", "pipe"],
        });

  const stdout = child.stdout?.toString("utf-8") ?? "";
  const stderr = child.stderr?.toString("utf-8") ?? "";
  const exitCode = child.status ?? 1;

  if (child.signal) {
    persistStderr(outputDir, instanceId, execId, stderr);
    return { success: false, fatal: true, detail: `Script killed: ${child.signal}` };
  }

  const { ok, errors, payload } = validateAndParse(stdout);

  if (!ok) {
    const baseDetail = exitCode !== 0
      ? `脚本退出码 ${exitCode}` + (stderr.trim() ? `：${stderr.trim().slice(0, 200)}` : "")
      : (errors.length ? errors.join("; ") : "脚本无输出");
    const detail = baseDetail + buildPipelineScriptPathHint(stderr);
    writeResult(workspaceRoot, flowName, uuid, instanceId, {
      status: "failed",
      message: detail,
    }, { preserveBody: true, execId });
    persistStderr(outputDir, instanceId, execId, stderr);
    return { success: false, fatal: false, detail };
  }

  const isSynthetic = Boolean(payload._synthetic);
  const success = isSynthetic ? exitCode === 0 : (payload.err_code === 0);
  const message = payload.message;

  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const slotsToWrite = [...new Set([...Object.keys(message), "stderr"])];
    backupResolvedOutputsIfExist(runDir, instanceId, execId, slotsToWrite);
    for (const slot of Object.keys(message)) {
      if (slot === "_synthetic") continue;
      const content = message[slot];
      if (content == null) continue;
      fs.writeFileSync(
        path.join(outputDir, outputNodeBasename(instanceId, execId, slot)),
        String(content),
        "utf-8",
      );
    }
    writeResult(workspaceRoot, flowName, uuid, instanceId, {
      status: success ? "success" : "failed",
      message: success ? "执行完成" : "执行未通过",
    }, { preserveBody: true, execId });
  } catch (e) {
    writeResult(workspaceRoot, flowName, uuid, instanceId, {
      status: "failed",
      message: e.message || "写入 output/result 异常",
    }, { preserveBody: true, execId });
    persistStderr(outputDir, instanceId, execId, stderr);
    return { success: false, fatal: false, detail: e.message };
  }

  persistStderr(outputDir, instanceId, execId, stderr);
  return { success, fatal: false, detail: success ? "" : `脚本退出码 ${exitCode}` };
}

function persistStderr(outputDir, instanceId, execId, stderr) {
  if (!stderr) return;
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, outputNodeBasename(instanceId, execId, "stderr")),
      stderr,
      "utf-8",
    );
  } catch (_) {}
}

function main() {
  const args = process.argv.slice(2);
  const sep = args.indexOf("--");
  if (sep < 0 || args.length < sep + 2) {
    console.error(
      "Usage: node run-tool-nodejs.mjs <workspaceRoot> <flowName> <uuid> <instanceId> [execId] -- <scriptCmd> [args...]",
    );
    process.exit(2);
  }

  const workspaceRoot = path.resolve(args[0]);
  const flowName = args[1];
  const uuid = args[2];
  const instanceId = args[3];
  const execId =
    sep >= 5 && args[4] !== "--"
      ? (parseInt(String(args[4]), 10) || 1)
      : loadExecId(workspaceRoot, flowName, uuid, instanceId);
  const scriptArgs = args.slice(sep + 1);

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const result = runOnce(workspaceRoot, flowName, uuid, instanceId, execId, scriptArgs);
    if (result.success) {
      process.exit(0);
    }
    if (result.fatal) {
      console.error(result.detail);
      process.exit(1);
    }
    if (attempt <= MAX_RETRIES) {
      console.error(`[tool_nodejs 自愈] ${instanceId} 第 ${attempt}/${MAX_RETRIES} 次重试：${result.detail?.slice(0, 200) || "unknown"}`);
      spawnSync("sleep", [String(RETRY_DELAY_MS / 1000)], { stdio: "ignore" });
    } else {
      console.error(result.detail);
      process.exit(1);
    }
  }
}

main();
