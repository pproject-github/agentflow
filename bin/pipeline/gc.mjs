#!/usr/bin/env node
/**
 * 清理 <workspaceRoot>/.workspace/agentflow/runBuild/ 下各 flowName 的 uuid 临时 run 目录。
 * 用法：
 *   agentflow apply -ai gc <workspaceRoot> [--list]                   仅列出 flowName/uuid 目录
 *   agentflow apply -ai gc <workspaceRoot> --dry-run [--keep N] [--older-than N]  预览将删除的
 *   agentflow apply -ai gc <workspaceRoot> --delete [--keep N] [--older-than N]   执行删除
 * 输出（stdout 一行 JSON）：{ "err_code": 0|1, "message": { "result": "<文本>" } }
 */

import fs from "fs";
import path from "path";

import { getWorkspaceRunBuildRoot } from "../lib/paths.mjs";

const UUID_DIR_PATTERN = /^\d{14}$/;

function parseArgs(args) {
  const workspaceRoot = args[0] ? path.resolve(args[0]) : "";
  const rest = args.slice(1);
  const opts = { list: false, delete: false, dryRun: false, keep: null, olderThan: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--list") opts.list = true;
    else if (rest[i] === "--delete") opts.delete = true;
    else if (rest[i] === "--dry-run") opts.dryRun = true;
    else if (rest[i] === "--keep" && rest[i + 1] != null) {
      opts.keep = Math.max(0, parseInt(rest[++i], 10));
      if (Number.isNaN(opts.keep)) opts.keep = null;
    } else if (rest[i] === "--older-than" && rest[i + 1] != null) {
      opts.olderThan = Math.max(0, parseInt(rest[++i], 10));
      if (Number.isNaN(opts.olderThan)) opts.olderThan = null;
    }
  }
  return { workspaceRoot, opts };
}

/** 收集 runBuild 下所有 flowName/uuid 目录，每项 { flowName, uuid, path, mtime }，按 mtime 倒序 */
function getAllRunDirs(workspaceRoot) {
  const runBuildDir = getWorkspaceRunBuildRoot(workspaceRoot);
  if (!fs.existsSync(runBuildDir) || !fs.statSync(runBuildDir).isDirectory()) {
    return [];
  }
  const dirs = [];
  const flowEntries = fs.readdirSync(runBuildDir, { withFileTypes: true });
  for (const fe of flowEntries) {
    if (!fe.isDirectory()) continue;
    const flowName = fe.name;
    const flowPath = path.join(runBuildDir, flowName);
    try {
      const uuidEntries = fs.readdirSync(flowPath, { withFileTypes: true });
      for (const ue of uuidEntries) {
        if (!ue.isDirectory() || !UUID_DIR_PATTERN.test(ue.name)) continue;
        const full = path.join(flowPath, ue.name);
        const stat = fs.statSync(full);
        dirs.push({ flowName, uuid: ue.name, path: full, mtime: stat.mtimeMs });
      }
    } catch (_) {}
  }
  dirs.sort((a, b) => b.mtime - a.mtime);
  return dirs;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 1) {
    const payload = {
      err_code: 1,
      message: {
        result:
          "Usage: agentflow apply -ai gc <workspaceRoot> [--list] | ... --dry-run [--keep N] [--older-than N] | ... --delete [--keep N] [--older-than N]",
      },
    };
    console.log(JSON.stringify(payload));
    process.exit(1);
  }

  const { workspaceRoot, opts } = parseArgs(argv);
  const allDirs = getAllRunDirs(workspaceRoot);

  // 默认仅列出
  if (!opts.delete && !opts.dryRun) {
    opts.list = true;
  }

  if (opts.list) {
    const lines = [`共 ${allDirs.length} 个 run 目录：`, ""];
    for (const d of allDirs) {
      const mtime = new Date(d.mtime).toISOString();
      lines.push(`  ${d.flowName}/${d.uuid}  (mtime: ${mtime})`);
    }
    const payload = { err_code: 0, message: { result: lines.join("\n") } };
    console.log(JSON.stringify(payload));
    process.exit(0);
  }

  // 计算待删除列表
  let toDelete = [...allDirs];
  if (opts.keep != null && opts.keep > 0) {
    toDelete = allDirs.slice(opts.keep);
  }
  if (opts.olderThan != null && opts.olderThan > 0) {
    const cutoff = Date.now() - opts.olderThan * 24 * 60 * 60 * 1000;
    toDelete = toDelete.filter((d) => d.mtime < cutoff);
  }

  if (opts.dryRun) {
    const msg =
      toDelete.length === 0
        ? "无符合条件的目录需要删除。"
        : `以下 ${toDelete.length} 个目录将被删除（dry-run）：\n${toDelete.map((d) => `  ${d.flowName}/${d.uuid}`).join("\n")}`;
    const payload = { err_code: 0, message: { result: msg } };
    console.log(JSON.stringify(payload));
    process.exit(0);
  }

  // --delete：实际删除
  const deleted = [];
  const failed = [];
  for (const d of toDelete) {
    try {
      fs.rmSync(d.path, { recursive: true });
      deleted.push(`${d.flowName}/${d.uuid}`);
    } catch (e) {
      failed.push({ label: `${d.flowName}/${d.uuid}`, error: e.message || String(e) });
    }
  }

  const parts = [`已删除 ${deleted.length} 个 run 目录：${deleted.join(", ") || "无"}`];
  if (failed.length > 0) {
    parts.push(`删除失败 ${failed.length} 个：`);
    failed.forEach((f) => parts.push(`  ${f.label}: ${f.error}`));
  }
  const payload = {
    err_code: failed.length > 0 ? 1 : 0,
    message: { result: parts.join("\n") },
  };
  console.log(JSON.stringify(payload));
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
