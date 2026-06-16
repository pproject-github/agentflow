#!/usr/bin/env node
/**
 * 节点每轮执行进入 pre-process 时，统一把「上一轮遗留的当前文件」快照到
 *   <name>_<priorExecId>.<ext>
 * 形式。这是唯一的备份入口，替代分散在 write-result / build-node-prompt /
 * pre-process 内多种辅助 prompt / get-env / run-tool-nodejs 中的 rename 调用。
 *
 * 不变量：
 *   1. 文件后缀 `_K` 严格对应「第 K 轮结束时的文件内容」，无错位。
 *   2. unsuffixed（无 `_N` 后缀）= 当前最新版本，永远存在；snapshot 用 copy
 *      生成 `_K` 历史快照，不破坏 unsuffixed。下游运行时只 resolve unsuffixed，
 *      不应也不需要 fallback 到 `_K`。
 *   3. 幂等：目标 `_K.ext` 已存在或源文件已经是 `_K.ext` 形态，直接跳过。
 *
 * 调用方：bin/pipeline/pre-process-node.mjs 在计算 execId 后、任何 write 前。
 */
import fs from "fs";
import path from "path";

import { intermediateDirForNode, outputDirForNode } from "./get-exec-id.mjs";

const BACKUP_SUFFIX_RE = /_\d+$/;

/**
 * @param {string} runDir - .workspace/agentflow/runBuild/<flowName>/<uuid>
 * @param {string} instanceId
 * @param {number} priorExecId - memory 里记录的「上一轮已完成 execId」，首轮传 0/undefined 直接返回
 */
export function snapshotPriorRoundIfNeeded(runDir, instanceId, priorExecId) {
  const prior = Number(priorExecId);
  if (!Number.isFinite(prior) || prior < 1) return;
  const suffix = `_${prior}`;

  const interDir = path.join(runDir, intermediateDirForNode(instanceId));
  snapshotDir(interDir, (f) => f.startsWith(instanceId + "."), suffix);

  const outDir = path.join(runDir, outputDirForNode(instanceId));
  snapshotDir(outDir, (f) => f.startsWith(`node_${instanceId}_`), suffix);
}

/**
 * @param {string} dir
 * @param {(filename: string) => boolean} predicate
 * @param {string} suffix - `_<N>`
 */
function snapshotDir(dir, predicate, suffix) {
  if (!fs.existsSync(dir)) return;
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const f of files) {
    if (!predicate(f)) continue;
    const ext = path.extname(f);
    const base = path.basename(f, ext);
    // 已是备份文件（以 _\d+ 结尾），跳过
    if (BACKUP_SUFFIX_RE.test(base)) continue;
    const to = base + suffix + ext;
    if (to === f) continue;
    const toPath = path.join(dir, to);
    if (fs.existsSync(toPath)) continue; // 幂等
    try {
      fs.copyFileSync(path.join(dir, f), toPath);
    } catch {
      // 并发或权限错误：放弃该文件，其它继续。unsuffixed 保留不动。
    }
  }
}
