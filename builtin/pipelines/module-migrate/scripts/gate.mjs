#!/usr/bin/env node
/**
 * 把「脚本判定」和「AI 判定」合成一个 bool，喂给 `control.if` 的 prediction。
 *
 * 用法（由 tool_nodejs 的 script 调用）：
 *   node gate.mjs <scriptOk> <aiVerdict> <okPath> <reportPath>
 *
 * - `<scriptOk>`：上游脚本节点写的 `true` / `false`
 * - `<aiVerdict>`：上游 agent 的回复正文，**第一行**必须是 true / false
 *
 * 为什么不用 `control.agentToBool`：那个节点没有任何东西约束模型输出，`parse-bool` 只认
 * `true` / `1` / `yes` / `on`，模型回「是」或「true（因为…）」都会静默变成 false。判定能
 * 用脚本做的时候就别交给模型。
 */
import fs from "node:fs";

const [scriptOk, aiVerdict, okPath, reportPath] = process.argv.slice(2);

if (!okPath || !reportPath) {
  console.error("用法: node gate.mjs <scriptOk> <aiVerdict> <okPath> <reportPath>");
  process.exit(1);
}

const scriptPassed = String(scriptOk || "").trim().toLowerCase() === "true";
const firstLine = String(aiVerdict || "").trim().split("\n")[0].trim().toLowerCase();
const aiPassed = firstLine === "true";
const ok = scriptPassed && aiPassed;

fs.writeFileSync(reportPath, [
  `脚本检查：${scriptPassed ? "通过" : "未通过"}`,
  `AI 检查：${aiPassed ? "通过" : `未通过（首行是 ${JSON.stringify(firstLine)}，期望 true）`}`,
  "",
  ok ? "两边都干净，进入编译。" : "有一边没过，进入修复。",
].join("\n"), "utf-8");
fs.writeFileSync(okPath, ok ? "true" : "false", "utf-8");

console.log(`脚本=${scriptPassed} AI=${aiPassed} -> ${ok}`);
