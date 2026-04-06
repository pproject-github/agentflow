#!/usr/bin/env node
/**
 * 汇总还原计划与资源导出结果，输出交付摘要 JSON。
 *
 * 用法：
 *   node finalize.mjs --restore-plan <path> --export-result <text>
 *
 * 输出（stdout JSON）：
 *   { stage, restorePlanPath, dfsStepsCount, exportAssetsCount, exportReport, done }
 */

import fs from "node:fs";

// ── CLI 参数解析 ─────────────────────────────────────────────

function parseArgs(argv) {
  const args = { restorePlan: "", exportResult: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--restore-plan" && argv[i + 1]) args.restorePlan = argv[++i];
    else if (argv[i] === "--export-result" && argv[i + 1]) args.exportResult = argv[++i];
  }
  return args;
}

// ── 主逻辑 ───────────────────────────────────────────────────

export function finalize({ restorePlan, exportResult }) {
  let plan = null;
  let exp = null;

  if (restorePlan) {
    try {
      if (fs.existsSync(restorePlan)) {
        plan = JSON.parse(fs.readFileSync(restorePlan, "utf8"));
      }
    } catch (e) {
      plan = { error: "bad_restore_plan", message: e.message };
    }
  }

  if (exportResult) {
    try {
      exp = JSON.parse(exportResult);
    } catch {
      exp = { raw: exportResult.slice(0, 2000) };
    }
  }

  const dfsLen = plan && Array.isArray(plan.dfsOrder) ? plan.dfsOrder.length : 0;
  const exported = exp && Array.isArray(exp.exported) ? exp.exported.length : 0;

  return {
    stage: "finalize_figma_restore",
    restorePlanPath: restorePlan || null,
    dfsStepsCount: dfsLen,
    exportAssetsCount: exported,
    exportReport: exp,
    done: !!(plan && Array.isArray(plan.dfsOrder) && plan.dfsOrder.length > 0),
  };
}

// ── 入口 ─────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = finalize(args);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (isMain) main();
