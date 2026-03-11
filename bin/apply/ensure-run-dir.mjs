#!/usr/bin/env node
/**
 * 生成本次运行 uuid（未传时）并创建 run 目录，避免由 Agent 每次生成。
 * 用法：node ensure-run-dir.mjs <workspaceRoot> [uuid] <flowName>
 * uuid 须为 14 位数字（YYYYMMDDhhmmss），否则视为未传并自动生成。
 * flowName 必传；run 目录为 .workspace/agentflow/runBuild/<flowName>/<uuid>/，其下创建 intermediate/、output/。
 * 若传入合法 uuid：仅确保上述目录存在。
 * 输出（stdout JSON）：{ "ok": true, "uuid": "..." }
 */

import fs from "fs";
import path from "path";

/** 合法 uuid：14 位数字 YYYYMMDDhhmmss，避免误传 flow name 等当作 uuid */
function isValidUuid(value) {
  return typeof value === "string" && /^\d{14}$/.test(value);
}

function generateUuid() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${y}${m}${d}${h}${min}${s}`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "Usage: node ensure-run-dir.mjs <workspaceRoot> [uuid] <flowName>",
      }),
    );
    process.exit(1);
  }

  const workspaceRoot = path.resolve(args[0]);
  const uuid = isValidUuid(args[1]) ? args[1] : generateUuid();
  const flowName = typeof args[2] === "string" && args[2].trim() !== "" ? args[2].trim() : null;
  if (!flowName) {
    console.error(
      JSON.stringify({ ok: false, error: "Usage: node ensure-run-dir.mjs <workspaceRoot> [uuid] <flowName> (flowName required)" }),
    );
    process.exit(1);
  }

  const runDir = path.join(workspaceRoot, ".workspace", "agentflow", "runBuild", flowName, uuid);
  const intermediateDir = path.join(runDir, "intermediate");
  const outputDir = path.join(runDir, "output");

  try {
    fs.mkdirSync(intermediateDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (e) {
    console.error(
      JSON.stringify({ ok: false, error: e.message || "Failed to create run dir" }),
    );
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, uuid }));
}

main();
