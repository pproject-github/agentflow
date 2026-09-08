import fs from "node:fs";
import path from "node:path";

import { getAgentflowDataRoot } from "./paths.mjs";
import {
  RELEASE_PROJECTS_FILENAME,
  defaultReleaseProjectsSeedDocument,
  emptyReleaseProjectsDocument,
  normalizeReleaseProjectsDocument,
  readReleaseDeploymentConfig,
  resolveReleaseProjectsFilePath,
  shouldSeedReleaseProjectsFile,
  writeReleaseProjectsDocument,
} from "../../shared/release-deployment-config.js";

function text(value) {
  return String(value ?? "").trim();
}

export function getReleaseProjectsConfigPath() {
  return resolveReleaseProjectsFilePath(getAgentflowDataRoot());
}

export function releaseProjectsEnvLocked(env = process.env) {
  return Boolean(text(env.AGENTFLOW_RELEASE_PROJECTS_JSON) || text(env.AGENTFLOW_RELEASE_PROJECTS_FILE));
}

/**
 * 用户需求点: 缺省时自动创建 release-projects.json（仅一次）；已存在或 env 覆盖时不改。
 */
export function ensureReleaseProjectsFileSeeded(env = process.env) {
  const dataRoot = getAgentflowDataRoot();
  const configPath = resolveReleaseProjectsFilePath(dataRoot);
  if (!configPath) return { created: false, path: "", reason: "no-data-root" };
  if (releaseProjectsEnvLocked(env)) return { created: false, path: configPath, reason: "env-locked" };
  if (fs.existsSync(configPath)) return { created: false, path: configPath, reason: "exists" };
  if (!shouldSeedReleaseProjectsFile(dataRoot, env)) {
    return { created: false, path: configPath, reason: "seed-disabled" };
  }
  writeReleaseProjectsDocument(configPath, defaultReleaseProjectsSeedDocument());
  return { created: true, path: configPath, reason: "seeded" };
}

export function readReleaseDeploymentConfigWithDataRoot(env = process.env) {
  ensureReleaseProjectsFileSeeded(env);
  return readReleaseDeploymentConfig(env, { defaultFilePath: getReleaseProjectsConfigPath() });
}

/**
 * 用户需求点: 管理员在设置页读写发版工程配置；env 覆盖时只读提示，避免和运维挂载冲突。
 */
export function readAdminReleaseProjectsConfig() {
  const configPath = getReleaseProjectsConfigPath();
  const envLocked = releaseProjectsEnvLocked();
  const deployment = readReleaseDeploymentConfigWithDataRoot();
  let document = emptyReleaseProjectsDocument();
  let exists = false;
  if (!envLocked && fs.existsSync(configPath)) {
    exists = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      document = normalizeReleaseProjectsDocument(parsed).document;
    } catch {
      document = {
        projects: deployment.projects.map((entry) => ({
          id: entry.id,
          businessLine: entry.businessLine,
          platform: entry.platform,
          workspaceRoot: entry.workspaceRoot,
          ...(entry.skillRoots?.length ? { skillRoots: [...entry.skillRoots] } : {}),
          ...(entry.tapd ? { tapd: { ...entry.tapd } } : {}),
        })),
        operators: deployment.operators || emptyReleaseProjectsDocument().operators,
      };
    }
  } else if (deployment.projects.length) {
    document = {
      projects: deployment.projects.map((entry) => ({
        id: entry.id,
        businessLine: entry.businessLine,
        platform: entry.platform,
          workspaceRoot: entry.workspaceRoot,
          ...(entry.skillRoots?.length ? { skillRoots: [...entry.skillRoots] } : {}),
          ...(entry.tapd ? { tapd: { ...entry.tapd } } : {}),
      })),
      operators: deployment.operators || emptyReleaseProjectsDocument().operators,
    };
  }
  return {
    configPath,
    filename: RELEASE_PROJECTS_FILENAME,
    envLocked,
    exists,
    source: deployment.projectsSource || "none",
    configError: deployment.configError || "",
    document,
  };
}

export function writeAdminReleaseProjectsConfig(payload = {}) {
  if (releaseProjectsEnvLocked()) {
    throw new Error("已设置 AGENTFLOW_RELEASE_PROJECTS_JSON 或 AGENTFLOW_RELEASE_PROJECTS_FILE，请改环境变量或清空后再用设置页保存");
  }
  const configPath = getReleaseProjectsConfigPath();
  const body = payload?.document && typeof payload.document === "object" ? payload.document : payload;
  const document = writeReleaseProjectsDocument(configPath, body);
  return {
    configPath,
    filename: RELEASE_PROJECTS_FILENAME,
    envLocked: false,
    exists: true,
    source: "data-root-file",
    configError: "",
    document,
  };
}

export function releaseProjectsPathHint() {
  return path.join(getAgentflowDataRoot(), RELEASE_PROJECTS_FILENAME);
}
