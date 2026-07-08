import fs from "fs";
import os from "os";
import path from "path";

import {
  AGENTFLOW_HOME_CONFIG_PATH,
  expandAgentflowHomePath,
  getAgentflowDataRoot,
  getAgentflowDataRootOverride,
  getAgentflowSkillsRoot,
  getAgentflowSkillsRootOverride,
  writeAgentflowDataRootOverride,
  writeAgentflowSkillsRootOverride,
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

function normalizeSkillsRoot(raw) {
  const skillsRoot = expandAgentflowHomePath(raw);
  if (skillsRoot && !path.isAbsolute(skillsRoot)) {
    throw new Error("skillsRoot must be an absolute path");
  }
  return skillsRoot;
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

function copyEntryIfMissing(src, dest) {
  if (fs.existsSync(dest)) return false;
  copyEntry(src, dest);
  return true;
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

function legacyCodexSkillsRoot() {
  return path.join(os.homedir(), ".codex", "skills");
}

function migrateSkillsRoot(oldRoot, newRoot) {
  const from = path.resolve(oldRoot);
  const to = path.resolve(newRoot);
  if (from === to) return { migrated: false, copied: false };
  if (pathInside(from, to)) {
    throw new Error("skillsRoot target cannot be inside the current skills root");
  }
  if (pathInside(to, from)) {
    throw new Error("skillsRoot target cannot be a parent of the current skills root");
  }
  fs.mkdirSync(to, { recursive: true });
  if (!fs.existsSync(from)) return { migrated: true, copied: false };
  for (const name of fs.readdirSync(from)) {
    copyEntry(path.join(from, name), path.join(to, name));
  }
  return { migrated: true, copied: true };
}

function migrateLegacyCodexSkills(targetRoot) {
  const from = legacyCodexSkillsRoot();
  const to = path.resolve(targetRoot);
  const source = path.resolve(from);
  if (source === to || !fs.existsSync(source)) return { migrated: false, copied: 0, source };
  if (pathInside(source, to) || pathInside(to, source)) return { migrated: false, copied: 0, source };
  fs.mkdirSync(to, { recursive: true });
  let copied = 0;
  for (const name of fs.readdirSync(source)) {
    if (copyEntryIfMissing(path.join(source, name), path.join(to, name))) copied += 1;
  }
  return { migrated: copied > 0, copied, source };
}

export function readAdminStorageConfig() {
  const envDataRoot = normalizeDataRoot(process.env.AGENTFLOW_HOME || "");
  const envSkillsRoot = normalizeSkillsRoot(process.env.AGENTFLOW_SKILLS_ROOT || "");
  const configuredDataRoot = getAgentflowDataRootOverride();
  const configuredSkillsRoot = getAgentflowSkillsRootOverride();
  const skillsRoot = getAgentflowSkillsRoot();
  const legacySkillsRoot = legacyCodexSkillsRoot();
  return {
    version: 1,
    dataRoot: getAgentflowDataRoot(),
    configuredDataRoot,
    defaultDataRoot: defaultAgentflowDataRoot(),
    envDataRoot,
    envLocked: Boolean(envDataRoot),
    skillsRoot,
    configuredSkillsRoot,
    defaultSkillsRoot: path.join(getAgentflowDataRoot(), "skills"),
    envSkillsRoot,
    skillsEnvLocked: Boolean(envSkillsRoot),
    legacySkillsRoot,
    legacySkillsRootExists: fs.existsSync(legacySkillsRoot),
    configPath: AGENTFLOW_HOME_CONFIG_PATH,
  };
}

export function writeAdminStorageConfig(config = {}) {
  const current = readAdminStorageConfig();
  const nextRoot = normalizeDataRoot(config.dataRoot ?? "");
  if (!nextRoot) throw new Error("dataRoot is required");
  let migration = { migrated: false, copied: false };
  if (current.envLocked) {
    if (path.resolve(nextRoot) !== path.resolve(current.dataRoot)) {
      throw new Error("AGENTFLOW_HOME is set; update the environment variable instead of Admin Settings");
    }
  } else {
    migration = migrateDataRoot(current.dataRoot, nextRoot);
    writeAgentflowDataRootOverride(nextRoot);
  }
  const afterDataRoot = readAdminStorageConfig();
  if (afterDataRoot.skillsEnvLocked) {
    return {
      ...afterDataRoot,
      migration,
      skillsMigration: { skipped: true, reason: "AGENTFLOW_SKILLS_ROOT is set" },
    };
  }
  const nextSkillsRoot = normalizeSkillsRoot(config.skillsRoot ?? afterDataRoot.defaultSkillsRoot);
  if (!nextSkillsRoot) throw new Error("skillsRoot is required");
  const skillsMigration = migrateSkillsRoot(current.skillsRoot, nextSkillsRoot);
  writeAgentflowSkillsRootOverride(nextSkillsRoot);
  const legacySkillsMigration = config.migrateLegacySkills === false
    ? { migrated: false, copied: 0, source: legacyCodexSkillsRoot(), skipped: true }
    : migrateLegacyCodexSkills(nextSkillsRoot);
  return {
    ...readAdminStorageConfig(),
    migration,
    skillsMigration,
    legacySkillsMigration,
  };
}
