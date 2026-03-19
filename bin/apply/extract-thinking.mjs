#!/usr/bin/env node
/**
 * 从 agentflow 某次运行的 logs/log.txt 中：
 * 1. 提取 [cursor-stdout-raw] 里 type=thinking、subtype=delta 的 text，按 session_id 聚合
 * 2. 每个 session 下附带 node-id（instanceId）以及传给该节点的 prompt（路径 + 完整内容或前 800 字）
 * 3. 保留节点执行情况（node-start / node-done / result status）
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

/** 从 log 行提取 [tag] 后的 message 部分（用于 cli-raw 等非 JSON 行） */
function getMessageAfterTag(line, tag) {
  const marker = `[${tag}]`;
  const idx = line.indexOf(marker);
  if (idx === -1) return null;
  const after = line.slice(idx + marker.length).replace(/^\s+/, "");
  return after || null;
}

/** 判断是否为新的一条 log 行（以 [ISO 时间] 开头） */
function isNewLogLine(line) {
  return /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line.trim());
}

function extractThinking(logContent) {
  const lines = logContent.split(/\r?\n/);
  /** session_id -> { texts: string[], instanceId?, label?, promptPath?, promptPreview? } */
  const thinkingBySession = Object.create(null);
  const nodeRuns = [];
  const resultStatus = Object.create(null);

  let currentInstanceId = null;
  let currentLabel = null;
  let currentPromptPath = null;
  let currentPromptPreview = null;
  let currentPromptFull = null;

  const jsonMatch = (line) => {
    const i = line.indexOf("{");
    if (i === -1) return null;
    return line.slice(i);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const tag = line.includes("[cursor-stdout-raw]")
      ? "cursor-stdout-raw"
      : line.includes("[cli]")
        ? "cli"
        : line.includes("[result]")
          ? "result"
          : line.includes("[cli-raw]")
            ? "cli-raw"
            : null;

    if (tag === "cli-raw") {
      const msg = getMessageAfterTag(line, "cli-raw");
      if (msg && msg.startsWith("Prompt: ")) {
        currentPromptPath = msg.slice(8).trim();
      } else if (msg && (msg.startsWith("Cursor CLI prompt 完整") || msg.startsWith("Cursor CLI prompt 前 800 字"))) {
        const isFull = msg.startsWith("Cursor CLI prompt 完整");
        const afterPrefix = msg.startsWith("Cursor CLI prompt 完整")
          ? msg.slice("Cursor CLI prompt 完整".length).replace(/^[:\s]*\n?/, "")
          : msg.slice("Cursor CLI prompt 前 800 字".length).replace(/^[:\s]*\n?/, "");
        const rest = [afterPrefix];
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j];
          if (isNewLogLine(next)) break;
          rest.push(next);
        }
        const content = rest.join("\n").trim();
        if (isFull) currentPromptFull = content;
        else currentPromptPreview = content;
      }
      continue;
    }

    const raw = jsonMatch(line);
    if (!raw) continue;

    try {
      if (tag === "cursor-stdout-raw") {
        const obj = JSON.parse(raw);
        if (obj.type === "thinking" && obj.subtype === "delta" && obj.text != null && obj.session_id) {
          const sid = obj.session_id;
          if (!thinkingBySession[sid]) {
            thinkingBySession[sid] = {
              texts: [],
              instanceId: currentInstanceId ?? undefined,
              label: currentLabel ?? undefined,
              promptPath: currentPromptPath ?? undefined,
              promptPreview: currentPromptPreview ?? undefined,
              promptFull: currentPromptFull ?? undefined,
            };
          }
          thinkingBySession[sid].texts.push(obj.text);
        }
        continue;
      }

      if (tag === "cli") {
        const obj = JSON.parse(raw);
        if (obj.event === "node-start" && obj.instanceId) {
          currentInstanceId = obj.instanceId;
          currentLabel = obj.label || obj.instanceId;
          currentPromptPath = null;
          currentPromptPreview = null;
          currentPromptFull = null;
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
    const entry = thinkingBySession[sid];
    const texts = entry.texts || [];
    const full = texts.join("");
    parts.push(`## session_id: ${sid}\n`);
    if (entry.instanceId != null) {
      parts.push(`- **node-id**: ${entry.instanceId}${entry.label != null && entry.label !== entry.instanceId ? ` (${entry.label})` : ""}\n`);
    }
    if (entry.promptPath != null) {
      parts.push(`- **prompt 路径**: ${entry.promptPath}\n`);
    }
    if (entry.promptFull != null && entry.promptFull.length > 0) {
      parts.push(`- **prompt 完整内容**:\n\`\`\`\n${entry.promptFull}\n\`\`\`\n`);
    } else if (entry.promptPreview != null && entry.promptPreview.length > 0) {
      parts.push(`- **prompt 前 800 字**:\n\`\`\`\n${entry.promptPreview}\n\`\`\`\n`);
    }
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
