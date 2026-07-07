import fs from "fs";
import os from "os";
import path from "path";

import {
  AGENTFLOW_HOME_CONFIG_PATH,
  expandAgentflowHomePath,
  getAgentflowDataRoot,
  getAgentflowDataRootOverride,
  writeAgentflowDataRootOverride,
} from "./paths.mjs";

function defaultAgentflowDataRoot() {
  return path.join(os.homedir(), "agentflow");
}

function pathInside(parent, candidate) {
  const base = path.resolve(parent);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(base + path.sep);
}

function normalizeDataRoot(raw) {
  const dataRoot = expandAgentflowHomePath(raw);
  if (dataRoot && !path.isAbsolute(dataRoot)) {
    throw new Error("dataRoot must be an absolute path");
  }
  return dataRoot;
}

function copyEntry(src, dest) {
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) {
    if (!fs.existsSync(dest)) fs.symlinkSync(fs.readlinkSync(src), dest);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyEntry(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function migrateDataRoot(oldRoot, newRoot) {
  const from = path.resolve(oldRoot);
  const to = path.resolve(newRoot);
  if (from === to) return { migrated: false, copied: false };
  if (pathInside(from, to)) {
    throw new Error("dataRoot target cannot be inside the current data root");
  }
  if (pathInside(to, from)) {
    throw new Error("dataRoot target cannot be a parent of the current data root");
  }
  fs.mkdirSync(to, { recursive: true });
  if (!fs.existsSync(from)) return { migrated: true, copied: false };
  for (const name of fs.readdirSync(from)) {
    copyEntry(path.join(from, name), path.join(to, name));
  }
  return { migrated: true, copied: true };
}

export function readAdminStorageConfig() {
  const envDataRoot = normalizeDataRoot(process.env.AGENTFLOW_HOME || "");
  const configuredDataRoot = getAgentflowDataRootOverride();
  return {
    version: 1,
    dataRoot: getAgentflowDataRoot(),
    configuredDataRoot,
    defaultDataRoot: defaultAgentflowDataRoot(),
    envDataRoot,
    envLocked: Boolean(envDataRoot),
    configPath: AGENTFLOW_HOME_CONFIG_PATH,
  };
}

export function writeAdminStorageConfig(config = {}) {
  const current = readAdminStorageConfig();
  if (current.envLocked) {
    throw new Error("AGENTFLOW_HOME is set; update the environment variable instead of Admin Settings");
  }
  const nextRoot = normalizeDataRoot(config.dataRoot ?? "");
  if (!nextRoot) throw new Error("dataRoot is required");
  const migration = migrateDataRoot(current.dataRoot, nextRoot);
  writeAgentflowDataRootOverride(nextRoot);
  return {
    ...readAdminStorageConfig(),
    migration,
  };
}
