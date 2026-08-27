#!/usr/bin/env node
/**
 * 把 `check_imports.mjs` 接到 Workspace 运行时上。
 *
 * 用法（由 tool_nodejs 的 script 调用）：
 *   node static-check.mjs <repoRoot> <beforeList> <afterList> <okPath> <reportPath>
 *
 * `<beforeList>` / `<afterList>` 是**清单正文**（每行一个仓库相对路径），不是文件路径——
 * 上游 agent 的回复正文直接作为引脚值传进来。这里落成临时文件再喂给 check_imports。
 *
 * `check_imports.mjs` 是旧执行栈的产物，stdout 吐一行
 * `{"err_code":0|1,"message":{"result":"…"}}`。Workspace 运行时不认这个信封，所以在这里
 * 拆开：结果写 `<reportPath>`，通过与否写 `<okPath>`（`true` / `false`）。
 *
 * **总是 exit 0**：查出问题不是这一步失败，是下一步要修的事。真失败只有「脚本跑不起来」。
 * 缺 tree-sitter 依赖时也走 `false` + 明确的报告，绝不静默跳过。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [repoRoot, beforeText, afterText, okPath, reportPath] = process.argv.slice(2);

if (!repoRoot || !okPath || !reportPath) {
  console.error("用法: node static-check.mjs <repoRoot> <beforeList> <afterList> <okPath> <reportPath>");
  process.exit(1);
}

const finish = (ok, report) => {
  fs.writeFileSync(reportPath, report, "utf-8");
  fs.writeFileSync(okPath, ok ? "true" : "false", "utf-8");
  console.log(ok ? "静态检查通过" : "静态检查有问题，交给下游修");
  process.exit(0);
};

if (!fs.existsSync(path.join(HERE, "node_modules", "tree-sitter"))) {
  finish(false, [
    "# 静态检查未运行",
    "",
    "`check_imports.mjs` 依赖 tree-sitter，当前 `scripts/node_modules` 里没有。先执行：",
    "",
    "```bash",
    `cd ${HERE} && npm install`,
    "```",
    "",
    "装完重跑本节点。**这一轮的 false 不代表代码有问题，只代表没查。**",
  ].join("\n"));
}

const tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "static-check-"));
const beforeFile = path.join(tmpDir, "before.txt");
const afterFile = path.join(tmpDir, "after.txt");
fs.writeFileSync(beforeFile, String(beforeText || ""), "utf-8");
fs.writeFileSync(afterFile, String(afterText || ""), "utf-8");

const r = spawnSync("node", [
  path.join(HERE, "check_imports.mjs"),
  "--root", repoRoot,
  "--before-list", beforeFile,
  "--after-list", afterFile,
], { encoding: "utf-8" });

if (r.error) {
  console.error(`执行 check_imports.mjs 失败：${r.error.message}`);
  process.exit(1);
}

let payload = null;
try {
  payload = JSON.parse(String(r.stdout || "").trim().split("\n").pop() || "");
} catch {
  payload = null;
}

if (!payload) {
  finish(false, `# 静态检查输出无法解析\n\n\`\`\`\n${(r.stdout || "") + (r.stderr || "")}\n\`\`\`\n`);
}

const detail = String(payload?.message?.result || "").trim();
finish(payload.err_code === 0 && !detail, `# 静态引用检查\n\n${detail || "未发现主模块直接引用被迁类。"}\n`);
