#!/usr/bin/env node
/**
 * 在写入 intermediate 固定文件名前做历史备份：
 *   <name>.<ext> -> <name>_<execId>.<ext>
 * 仅当当前文件存在时生效。
 */

import fs from "fs";
import path from "path";

/**
 * @param {string} filePath
 * @param {number} execId
 */
export function backupIntermediateFileIfExists(filePath, execId) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const id = Number(execId);
  if (!Number.isFinite(id) || id < 1) return;

  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const backupPath = path.join(path.dirname(filePath), `${base}_${id}${ext}`);
  try {
    fs.renameSync(filePath, backupPath);
  } catch (e) {
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    fs.renameSync(filePath, backupPath);
  }
}
