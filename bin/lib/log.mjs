import chalk from "chalk";

/** 日志等级：debug 最低优先级（仅 --debug 时输出灰色），info / warn / error 依次升高 */
export const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLogLevel = LOG_LEVELS.info;

/** --machine-readable 时向 stdout 输出 JSON 行事件 */
export let machineReadable = false;

export function setLogLevel(level) {
  currentLogLevel = level;
}

export function setMachineReadable(v) {
  machineReadable = Boolean(v);
}

export const log = {
  debug: (msg) => {
    if (currentLogLevel <= LOG_LEVELS.debug) process.stderr.write(chalk.dim(msg) + "\n");
  },
  /** machine-readable 时 stdout 仅用于一行一条 JSON 事件；人类可读信息走 stderr，避免与 UI 解析打架 */
  info: (msg) => {
    if (currentLogLevel <= LOG_LEVELS.info) {
      const line = msg + "\n";
      if (machineReadable) process.stderr.write(line);
      else process.stdout.write(line);
    }
  },
  warn: (msg) => {
    if (currentLogLevel <= LOG_LEVELS.warn) process.stderr.write(chalk.yellow(msg) + "\n");
  },
  error: (msg) => {
    if (currentLogLevel <= LOG_LEVELS.error) process.stderr.write(chalk.red(msg) + "\n");
  },
};
