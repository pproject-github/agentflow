import fs from "fs";
import path from "path";
import { getAgentflowDataRoot } from "./paths.mjs";

const REGISTRY_VERSION = 1;
const PROJECTS = ["Likee", "Bigolive", "Hello"];
const PLATFORMS = ["iOS", "Android"];
let writeQueue = Promise.resolve();

function registryPath() { return path.join(getAgentflowDataRoot(), "release", "versions.json"); }
function readRegistry() {
  try {
    const value = JSON.parse(fs.readFileSync(registryPath(), "utf8"));
    if (!value || Array.isArray(value) || !value.releases || typeof value.releases !== "object" || Array.isArray(value.releases)) throw new Error("versions.json 格式无效");
    return { version: REGISTRY_VERSION, releases: value.releases };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: REGISTRY_VERSION, releases: {} };
    throw new Error(`读取发版数据失败：${error.message || error}`);
  }
}
function writeRegistry(registry) {
  const file = registryPath(); fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: REGISTRY_VERSION, releases: registry.releases || {} }, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
}
function normalizeProject(value) { const project = String(value || "").trim(); return PROJECTS.includes(project) ? project : ""; }
function normalizePlatform(value) { const platform = String(value || "").trim(); return PLATFORMS.includes(platform) ? platform : ""; }
function publicRelease(item) { return { ...item }; }

// 用户需求点: 版本必须按固定项目和平台归属，并持久化供页面真实读写。
export function listReleases({ project = "", platform = "", query = "", userId = "", isAdmin = false } = {}) {
  const p = normalizeProject(project), pf = normalizePlatform(platform), q = String(query || "").trim().toLowerCase();
  return Object.values(readRegistry().releases).filter((item) => (isAdmin || !item.ownerId || item.ownerId === userId) && (!p || item.project === p) && (!pf || item.platform === pf) && (!q || String(item.version || "").toLowerCase().includes(q))).sort((a, b) => String(b.releaseDate).localeCompare(String(a.releaseDate))).map(publicRelease);
}

// 用户需求点: 新建版本需要校验两级版本号、项目和平台，避免写入无效数据。
export function createRelease(input = {}) {
  const project = normalizeProject(input.project), platform = normalizePlatform(input.platform);
  const version = String(input.version || "").trim().replace(/^v/i, "");
  if (!project || !platform) return { error: "项目和平台必须是固定选项", status: 400 };
  if (!/^\d+\.\d+$/.test(version)) return { error: "版本号必须是两级格式，例如 5.64", status: 400 };
  const releaseDate = String(input.releaseDate || "").trim() || new Date().toISOString().slice(0, 10);
  const parsedDate = new Date(`${releaseDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== releaseDate) return { error: "发版时间格式无效", status: 400 };
  const id = `${project.toLowerCase()}:${platform.toLowerCase()}:${version}`;
  const registry = readRegistry(); if (registry.releases[id]) return { error: "该项目和平台下版本已存在", status: 409 };
  const now = new Date().toISOString();
  const item = { id, project, platform, version, releaseDate, ownerId: String(input.ownerId || ""), progress: 0, status: "planning", createdAt: now, updatedAt: now };
  registry.releases[id] = item; writeRegistry(registry); return { release: publicRelease(item) };
}

// 用户需求点: 并发创建版本不能互相覆盖，所有读改写操作必须在进程内串行执行。
export function createReleaseQueued(input = {}) {
  const task = writeQueue.then(() => createRelease(input));
  writeQueue = task.catch(() => {});
  return task;
}

export { PROJECTS, PLATFORMS };
