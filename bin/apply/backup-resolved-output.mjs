#!/usr/bin/env node
/**
 * 在节点写入 output 前，若 resolved 输出文件已存在，则重命名为「原文件名_${execId}.扩展名」做备份，避免覆盖冲突。
 * 导出：backupResolvedOutputsIfExist(runDir, instanceId, execId, slotNames)
 */

import fs from "fs";
import path from "path";

import { outputDirForNode, outputNodeBasename } from "./get-exec-id.mjs";

/**
 * 对每个 slot 对应的 resolved 输出文件，若已存在则重命名为 主文件名_${execId}.扩展名。
 * @param {string} runDir - 本次 run 的根目录（.workspace/agentflow/runBuild/<flowName>/<uuid>）
 * @param {string} instanceId - 节点 instance id
 * @param {number} execId - 本轮 execId，用于备份文件名后缀
 * @param {string[]} slotNames - 本节点会写入的 output 槽位名列表
 */
export function backupResolvedOutputsIfExist(runDir, instanceId, execId, slotNames) {
  if (!slotNames || slotNames.length === 0) return;
  const outDir = path.join(runDir, outputDirForNode(instanceId));
  if (!fs.existsSync(outDir)) return;

  const execIdStr = String(execId);
  for (const slot of slotNames) {
    const fileName = outputNodeBasename(instanceId, execId, slot);
    const filePath = path.join(outDir, fileName);
    if (!fs.existsSync(filePath)) continue;

    const ext = path.extname(fileName);
    const baseWithoutExt = path.basename(filePath, ext);
    const backupFileName = baseWithoutExt + "_" + execIdStr + ext;
    const backupPath = path.join(outDir, backupFileName);
    try {
      fs.renameSync(filePath, backupPath);
    } catch (e) {
      // 若备份目标已存在则覆盖（同一 execId 重跑等）
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      fs.renameSync(filePath, backupPath);
    }
  }
}
