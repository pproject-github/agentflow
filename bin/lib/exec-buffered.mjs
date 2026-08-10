/**
 * 带超时和缓冲上限的 execFile。
 *
 * 失败时把 stdout / stderr 挂在 error 上再抛——调用方通常要靠子进程的输出判断出了什么事，
 * 只拿到一个 exit code 没法处理。
 */
import { execFile } from "child_process";

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeout?: number, maxBuffer?: number, cwd?: string, env?: object }} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function execFileBuffered(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: Number(options.timeout || 30000),
      maxBuffer: Number(options.maxBuffer || 2 * 1024 * 1024),
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
