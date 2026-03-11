#!/usr/bin/env node
/**
 * tool_load_key 执行脚本：从 run 目录下 memory 存储按 key 读取 value，stdout 输出 tool_nodejs 约定 JSON。
 * 存储路径与格式由本脚本内部实现，节点不感知。key 由命令行参数传入，不读 flow。
 * 用法：node load-key.mjs <workspaceRoot> <flowName> <uuid> <key>
 * 输出（stdout 一行 JSON）：{ "err_code": 0, "message": { "result": "<value>" } }；err_code 0=成功 1=失败，无 next。
 */

import fs from "fs";
import path from "path";

const MEMORY_FILENAME = "memory.md";

function parseMemory(content) {
  const map = new Map();
  for (const line of (content || "").split(/\r?\n/)) {
    const idx = line.indexOf(": ");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 2).trim();
    if (k) map.set(k, v);
  }
  return map;
}

function main() {
  const [root, flowName, uuid, key] = process.argv.slice(2);
  if (!root || !flowName || !uuid) {
    console.log(
      JSON.stringify({
        err_code: 1,
        message: { result: "" },
      }),
    );
    process.exit(0);
  }

  const keyStr = key != null ? String(key).trim() : "";
  const workspaceRoot = path.resolve(root);
  const runDir = path.join(workspaceRoot, ".workspace", "agentflow", "runBuild", flowName, uuid);
  const memoryPath = path.join(runDir, MEMORY_FILENAME);

  let value = "";
  if (keyStr && fs.existsSync(memoryPath)) {
    try {
      const content = fs.readFileSync(memoryPath, "utf-8");
      const map = parseMemory(content);
      value = map.get(keyStr) ?? "";
    } catch (_) {}
  }

  console.log(
    JSON.stringify({
      err_code: 0,
      message: { result: value },
    }),
  );
}

main();
