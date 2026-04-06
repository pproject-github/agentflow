/**
 * apply 运行期间在 run 目录写入 PID 锁，供「最近运行」严格区分 running / interrupted。
 */
import fs from "fs";
import path from "path";
import { getRunDir } from "./paths.mjs";

export const RUN_APPLY_ACTIVE_FILENAME = "run-apply-active.json";

/**
 * @param {string} workspaceRoot
 * @param {string} flowName
 * @param {string} uuid
 */
export function writeApplyActiveLock(workspaceRoot, flowName, uuid) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  fs.mkdirSync(runDir, { recursive: true });
  const payload = {
    pid: process.pid,
    flowName,
    uuid,
    workspaceRoot: path.resolve(String(workspaceRoot)),
    startedAt: Date.now(),
  };
  fs.writeFileSync(path.join(runDir, RUN_APPLY_ACTIVE_FILENAME), JSON.stringify(payload, null, 2), "utf-8");
}

/**
 * @param {string} workspaceRoot
 * @param {string} flowName
 * @param {string} uuid
 */
export function clearApplyActiveLock(workspaceRoot, flowName, uuid) {
  try {
    const lockPath = path.join(getRunDir(workspaceRoot, flowName, uuid), RUN_APPLY_ACTIVE_FILENAME);
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

/**
 * 锁存在且 PID 仍存活 → apply 主进程仍在跑。
 * 锁存在但 PID 已死 → 删除陈旧锁并返回 false。
 * @param {string} runDir
 * @returns {boolean}
 */
export function isApplyProcessAlive(runDir) {
  const lockPath = path.join(runDir, RUN_APPLY_ACTIVE_FILENAME);
  if (!fs.existsSync(lockPath)) return false;
  let pid;
  try {
    const j = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    pid = typeof j.pid === "number" ? j.pid : parseInt(String(j.pid), 10);
  } catch {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    return false;
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    return false;
  }
}
