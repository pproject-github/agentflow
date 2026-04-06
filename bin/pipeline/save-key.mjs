#!/usr/bin/env node
/**
 * tool_save_key 执行脚本：按 key 将 value 写入 run 目录下 memory 存储，stdout 输出 tool_nodejs 约定 JSON。
 * 存储路径与格式由本脚本内部实现，节点不感知。key/value 由命令行参数传入，不读 flow。
 * value 若为 run 目录内相对路径则读取文件内容后写入。
 * 用法：node save-key.mjs <workspaceRoot> <flowName> <uuid> <key> [value]
 * 输出（stdout 一行 JSON）：成功时 result 为写入的 value；err_code 0=成功 1=失败，无 next。
 */

import fs from "fs";
import path from "path";

import { getRunDir } from "../lib/paths.mjs";

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

function serializeMemory(map) {
  return (
    Array.from(map.entries())
      .map(([k, v]) => `${k}: ${String(v).replace(/\r?\n/g, " ")}`)
      .join("\n") + (map.size ? "\n" : "")
  );
}

function main() {
  const [root, flowName, uuid, keyArg, valueArg] = process.argv.slice(2);
  if (!root || !flowName || !uuid) {
    console.log(
      JSON.stringify({
        err_code: 1,
        message: { result: "" },
      }),
    );
    process.exit(0);
  }

  const key = keyArg != null ? String(keyArg).trim() : "";
  let value = valueArg != null ? String(valueArg).trim() : "";

  const workspaceRoot = path.resolve(root);
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const memoryPath = path.join(runDir, MEMORY_FILENAME);

  if (!key) {
    console.log(
      JSON.stringify({
        err_code: 0,
        message: { result: "" },
      }),
    );
    process.exit(0);
  }

  if (
    value &&
    (value.includes("/") || value.startsWith("output") || value.startsWith("intermediate"))
  ) {
    const valuePath = path.join(runDir, value);
    if (fs.existsSync(valuePath)) {
      try {
        value = fs.readFileSync(valuePath, "utf-8").trim();
      } catch (_) {}
    }
  }

  const existing = fs.existsSync(memoryPath)
    ? parseMemory(fs.readFileSync(memoryPath, "utf-8"))
    : new Map();
  existing.set(key, value);
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
  fs.writeFileSync(memoryPath, serializeMemory(existing), "utf-8");

  console.log(
    JSON.stringify({
      err_code: 0,
      message: { result: value },
    }),
  );
}

main();
