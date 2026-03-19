#!/usr/bin/env node
/**
 * 运行 tool_nodejs 脚本，经 validate-script-output 校验并提取 message 后写入 output，并根据 err_code 直接写入 result（success/failed）。
 * 约定：脚本仅向 stdout 输出一行 JSON：{ "err_code": number, "message": { "result": "..." } }，无 message.next。
 * err_code 表示节点执行结果：0=成功，1=失败；本脚本直接写 result.status，不再写 meta。
 *
 * 用法：node run-tool-nodejs.mjs <workspaceRoot> <flowName> <uuid> <instanceId> [execId] -- <scriptCmd> [args...]
 * 可选 execId：本轮执行的 execId（与 pre-process 输出一致）。未传则从 memory 读取（仅首轮准确，第二轮起会写错文件，故调用方应传入）。
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { validateAndParse } from "./validate-script-output.mjs";
import { writeResult } from "./write-result.mjs";
import { backupResolvedOutputsIfExist } from "./backup-resolved-output.mjs";
import { loadExecId, outputNodeBasename, outputDirForNode } from "./get-exec-id.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 脚本必须返回的 message 槽位，仅 result */
const REQUIRED_SLOTS = ["result"];

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
  /** 本轮 execId：若调用方传入则用传入值，否则从 memory 读取（第二轮起会落后一轮，仅首轮准确） */
  const execId =
    sep >= 5 && args[4] !== "--"
      ? (parseInt(String(args[4]), 10) || 1)
      : loadExecId(workspaceRoot, flowName, uuid, instanceId);
  const scriptArgs = args.slice(sep + 1);
  const runDir = path.join(workspaceRoot, ".workspace", "agentflow", "runBuild", flowName, uuid);
  const outputDir = path.join(runDir, outputDirForNode(instanceId));

  let stdout = "";
  let stderr = "";

  const child = spawn(scriptArgs[0], scriptArgs.slice(1), {
    cwd: workspaceRoot,
    shell: true,
    stdio: ["inherit", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.on("close", (code, signal) => {
    if (signal) {
      console.error(`Script killed: ${signal}`);
      writeStderr();
      process.exit(signal === "SIGTERM" ? 143 : 1);
    }

    const { ok, errors, payload } = validateAndParse(stdout, { requireSlots: REQUIRED_SLOTS });

    if (!ok) {
      console.error("脚本输出校验失败: " + (errors && errors.length ? errors.join("; ") : ""));
      writeResult(workspaceRoot, flowName, uuid, instanceId, {
        status: "failed",
        message: "脚本输出校验失败: " + (errors && errors.length ? errors.join("; ") : "脚本未输出合法 JSON"),
      }, { preserveBody: true, execId });
      writeStderr();
      process.exit(1);
    }

    const message = payload.message;
    const errCode = typeof payload.err_code === "number" ? payload.err_code : 1;
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      const slotsToWrite = [...new Set([...Object.keys(message), "stderr"])];
      backupResolvedOutputsIfExist(runDir, instanceId, execId, slotsToWrite);
      for (const slot of Object.keys(message)) {
        const content = message[slot];
        if (content == null) continue;
        const fileName = outputNodeBasename(instanceId, execId, slot);
        const filePath = path.join(outputDir, fileName);
        fs.writeFileSync(filePath, String(content), "utf-8");
      }
      writeResult(workspaceRoot, flowName, uuid, instanceId, {
        status: errCode === 0 ? "success" : "failed",
        message: errCode === 0 ? "执行完成" : "执行未通过",
      }, { preserveBody: true, execId });
    } catch (e) {
      console.error(e.message);
      writeResult(workspaceRoot, flowName, uuid, instanceId, {
        status: "failed",
        message: e.message || "写入 output/result 异常",
      }, { preserveBody: true, execId });
      writeStderr();
      process.exit(1);
    }

    process.exit(0);
  });

  function writeStderr() {
    if (!stderr) return;
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      const stderrFileName = outputNodeBasename(instanceId, execId, "stderr");
      fs.writeFileSync(path.join(outputDir, stderrFileName), stderr, "utf-8");
    } catch (_) {}
  }
}

main();
