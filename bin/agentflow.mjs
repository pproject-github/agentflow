#!/usr/bin/env node
/**
 * AgentFlow CLI: drive apply/replay from command line.
 * Commands: agentflow apply <FlowName> [uuid], agentflow replay [flowName] <uuid> <instanceId>
 * Cursor agent execution uses --print --output-format stream-json.
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { initI18n, setLanguage, SUPPORTED_LANGUAGES } from "./lib/i18n.mjs";
import { main } from "./lib/main.mjs";
import { log } from "./lib/log.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// 提前解析 --lang 参数（需要在 update-notifier 和 main 之前）
const argv = process.argv.slice(2);
const langIdx = argv.indexOf("--lang");
if (langIdx >= 0 && argv[langIdx + 1]) {
  const requestedLang = argv[langIdx + 1];
  if (SUPPORTED_LANGUAGES.includes(requestedLang)) {
    initI18n(requestedLang);
  } else {
    console.warn(`Warning: Unsupported language "${requestedLang}". Supported: ${SUPPORTED_LANGUAGES.join(", ")}`);
  }
} else {
  // 从环境变量初始化
  initI18n();
}

const updateNotifier = require("update-notifier").default;
const pkg = require(path.join(__dirname, "..", "package.json"));
updateNotifier({ pkg }).notify();

/** 当 stderr 非 TTY（如被 desktop 管道捕获）时禁用 chalk，避免日志里出现 [90m 等 ANSI 转义码 */
if (process.stderr && !process.stderr.isTTY) {
  chalk.level = 0;
}

main().catch((err) => {
  log.error("Error: " + err.message);
  if (err.flowName && err.uuid) {
    log.info(chalk.bold.yellow("After fixing, use resume to continue: ") + `agentflow resume ${err.flowName} ${err.uuid}`);
  }
  process.exit(1);
});
