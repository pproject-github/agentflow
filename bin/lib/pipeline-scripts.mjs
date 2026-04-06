import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { PIPELINE_SCRIPTS_DIR } from "./paths.mjs";

/** 脚本路径：从 agentflow 包内 bin/pipeline 目录加载 */
export function getScriptPath(_workspaceRoot, name) {
  return path.join(PIPELINE_SCRIPTS_DIR, name);
}

export function runNodeScript(workspaceRoot, scriptName, args, options = {}) {
  const scriptPath = getScriptPath(workspaceRoot, scriptName);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Script not found: ${scriptPath}. Reinstall the agentflow package.`);
  }
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: workspaceRoot,
    encoding: "utf-8",
    stdio: options.captureStdout ? ["inherit", "pipe", "inherit"] : ["inherit", "inherit", "inherit"],
    ...options,
  });
  return result;
}

export function parseJsonStdout(result) {
  if (result.status !== 0) {
    const err = (result.stdout || "").trim() || result.stderr || "unknown";
    throw new Error(`Script failed: ${err}`);
  }
  const out = (result.stdout || "").trim();
  if (!out) throw new Error("Script produced no stdout");
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`Invalid JSON from script: ${out.slice(0, 200)}`);
  }
}

export function isValidUuid(value) {
  return typeof value === "string" && /^\d{14}$/.test(value);
}
