#!/usr/bin/env node
/**
 * postinstall：将包内 reference/ 复制到当前工作目录的 .workspace/agentflow/reference/。
 * 在项目内 npm install agentflow 时，cwd 为项目根，复制后 flow 中可引用 .workspace/agentflow/reference/*.md。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const REFERENCE_SRC = path.join(PACKAGE_ROOT, "reference");
const CWD = process.cwd();
const DEST = path.join(CWD, ".workspace", "agentflow", "reference");

if (!fs.existsSync(REFERENCE_SRC) || !fs.statSync(REFERENCE_SRC).isDirectory()) {
  process.exit(0);
}
if (CWD === PACKAGE_ROOT) {
  process.exit(0);
}

try {
  fs.mkdirSync(DEST, { recursive: true });
  const names = fs.readdirSync(REFERENCE_SRC);
  for (const name of names) {
    const srcFile = path.join(REFERENCE_SRC, name);
    if (fs.statSync(srcFile).isFile()) {
      fs.copyFileSync(srcFile, path.join(DEST, name));
    }
  }
} catch (_) {
  process.exit(0);
}
