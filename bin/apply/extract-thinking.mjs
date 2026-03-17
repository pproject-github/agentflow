#!/usr/bin/env node
/**
 * 从 agentflow 某次运行的 logs/log.txt 中：
 * 1. 提取 [cursor-stdout-raw] 里 type=thinking、subtype=delta 的 text，按 session_id 聚合
 * 2. 保留节点执行情况（node-start / node-done / result status）
 * 输出写入该次 run 的 logs/thinking_by_session_and_nodes.md
 *
 * 用法（apply -ai 步骤）：
 *   agentflow apply -ai extract-thinking <workspaceRoot> <flowName> <uuid>
 * 用法（顶层命令由 CLI 调用）：
 *   agentflow extract-thinking <flowName> <uuid>
 * 等价于在工作区根目录执行上述 -ai 步骤。
 *
 * 输入：<runDir>/logs/log.txt
 * 输出：<runDir>/logs/thinking_by_session_and_nodes.md
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RUN_BUILD_REL = ".workspace/agentflow/runBuild";
const LOG_REL = "logs/log.txt";
const OUT_REL = "logs/thinking_by_session_and_nodes.md";

function getRunDir(workspaceRoot, flowName, uuid) {
  return path.join(path.resolve(workspaceRoot), RUN_BUILD_REL, flowName, uuid);
}

function extractThinking(logContent) {
  const lines = logContent.split(/\r?\n/);
  const thinkingBySession = Object.create(null);
  const nodeRuns = [];
  const resultStatus = Object.create(null);

  const jsonMatch = (line) => {
    const i = line.indexOf("{");
    if (i === -1) return null;
    return line.slice(i);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const raw = jsonMatch(line);
    if (!raw) continue;

    try {
      const tag = line.includes("[cursor-stdout-raw]")
        ? "cursor-stdout-raw"
        : line.includes("[cli]")
          ? "cli"
          : line.includes("[result]")
            ? "result"
            : null;

      if (tag === "cursor-stdout-raw") {
        const obj = JSON.parse(raw);
        if (obj.type === "thinking" && obj.subtype === "delta" && obj.text != null && obj.session_id) {
          const sid = obj.session_id;
          if (!thinkingBySession[sid]) thinkingBySession[sid] = [];
          thinkingBySession[sid].push(obj.text);
        }
        continue;
      }

      if (tag === "cli") {
        const obj = JSON.parse(raw);
        if (obj.event === "node-start" && obj.instanceId) {
          const start = {
            instanceId: obj.instanceId,
            label: obj.label || obj.instanceId,
            startTime: line.slice(0, 30),
            elapsed: null,
            total: null,
            status: null,
            message: null,
          };
          nodeRuns.push(start);
        } else if (obj.event === "node-done" && obj.instanceId) {
          const last = nodeRuns[nodeRuns.length - 1];
          if (last && last.instanceId === obj.instanceId) {
            last.elapsed = obj.elapsed ?? null;
            last.total = obj.total ?? null;
          }
          const res = resultStatus[obj.instanceId];
          if (res && last && last.instanceId === obj.instanceId) {
            last.status = res.status;
            last.message = res.message;
          }
        }
        continue;
      }

      if (tag === "result") {
        const obj = JSON.parse(raw);
        if (obj.instanceId) {
          resultStatus[obj.instanceId] = { status: obj.status, message: obj.message || "" };
        }
      }
    } catch (_) {
      // 非 JSON 或解析失败忽略
    }
  }

  for (const run of nodeRuns) {
    if (run.status == null && resultStatus[run.instanceId]) {
      run.status = resultStatus[run.instanceId].status;
      run.message = resultStatus[run.instanceId].message;
    }
  }

  return { thinkingBySession, nodeRuns };
}

function toMarkdown(thinkingBySession, nodeRuns) {
  const parts = [];

  parts.push("# 节点执行情况\n");
  parts.push("| instanceId | label | elapsed | total | status | message |\n");
  parts.push("|------------|-------|---------|-------|--------|--------|\n");
  for (const r of nodeRuns) {
    const msg = (r.message || "").replace(/\|/g, "\\|").slice(0, 60);
    parts.push(`| ${r.instanceId} | ${r.label || ""} | ${r.elapsed ?? "-"} | ${r.total ?? "-"} | ${r.status ?? "-"} | ${msg} |\n`);
  }

  parts.push("\n---\n# Thinking 按 session_id 聚合\n");
  const sessionIds = Object.keys(thinkingBySession).sort();
  for (const sid of sessionIds) {
    const texts = thinkingBySession[sid];
    const full = texts.join("");
    parts.push(`## session_id: ${sid}\n`);
    parts.push(full.trim() || "(无文本)");
    parts.push("\n\n");
  }

  return parts.join("");
}

function main() {
  const args = process.argv.slice(2);
  const workspaceRoot = args[0] ? path.resolve(args[0]) : process.cwd();
  const flowName = args[1];
  const uuid = args[2];

  if (!flowName || !uuid) {
    process.stderr.write("Usage: agentflow apply -ai extract-thinking <workspaceRoot> <flowName> <uuid>\n");
    process.exit(1);
  }

  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const logPath = path.join(runDir, LOG_REL);
  const outPath = path.join(runDir, OUT_REL);

  if (!existsSync(logPath)) {
    process.stderr.write(`Log file not found: ${logPath}\n`);
    process.exit(1);
  }

  const logContent = readFileSync(logPath, "utf8");
  const { thinkingBySession, nodeRuns } = extractThinking(logContent);
  const md = toMarkdown(thinkingBySession, nodeRuns);

  const outDir = path.dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, md, "utf8");

  process.stdout.write(`Written: ${outPath}\n`);
  process.stdout.write(`Nodes: ${nodeRuns.length} Sessions: ${Object.keys(thinkingBySession).length}\n`);
}

main();
