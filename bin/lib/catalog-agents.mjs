import fs from "fs";
import path from "path";
import chalk from "chalk";
import { getAgentPath, readAgentFrontmatter } from "./agents-path.mjs";
import { collectPipelineNamesFromDir } from "./catalog-flows.mjs";
import { log } from "./log.mjs";
import { t } from "./i18n.mjs";
import {
  PACKAGE_AGENTS_DIR,
  PACKAGE_AGENTS_JSON,
  PACKAGE_BUILTIN_PIPELINES_DIR,
  USER_AGENTS_FILEPATH_PREFIX,
  getUserAgentsDirAbs,
  getUserAgentsJsonAbs,
  getUserPipelinesRoot,
} from "./paths.mjs";
import { Table } from "./table.mjs";

/** 列出所有角色：包内 agents.json（builtin）+ 用户数据目录 */
export function listAgentsJson(_workspaceRoot) {
  const out = [];

  if (fs.existsSync(PACKAGE_AGENTS_JSON) && fs.statSync(PACKAGE_AGENTS_JSON).isFile()) {
    try {
      const raw = fs.readFileSync(PACKAGE_AGENTS_JSON, "utf8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const e of arr) {
          const id = e && typeof e.id === "string" ? e.id.trim() : "";
          if (!id) continue;
          const filepath = e.filepath != null ? String(e.filepath) : `agents/${id}.md`;
          out.push({
            id,
            name: e.name != null ? String(e.name) : id,
            description: e.description != null ? String(e.description) : null,
            source: "builtin",
            filepath,
          });
        }
      }
    } catch (_) {}
  }
  if (out.length === 0 && fs.existsSync(PACKAGE_AGENTS_DIR) && fs.statSync(PACKAGE_AGENTS_DIR).isDirectory()) {
    const names = fs.readdirSync(PACKAGE_AGENTS_DIR);
    for (const n of names) {
      if (!n.endsWith(".md")) continue;
      const id = n.slice(0, -3);
      const fp = path.join(PACKAGE_AGENTS_DIR, n);
      if (!fs.statSync(fp).isFile()) continue;
      const { name, description } = readAgentFrontmatter(fp);
      out.push({
        id,
        name: name || id,
        description: description || null,
        source: "builtin",
        filepath: `agents/${id}.md`,
      });
    }
  }

  const userAgentsJsonPath = getUserAgentsJsonAbs();
  const userAgentsDir = getUserAgentsDirAbs();
  let userList = [];
  if (fs.existsSync(userAgentsJsonPath) && fs.statSync(userAgentsJsonPath).isFile()) {
    try {
      const raw = fs.readFileSync(userAgentsJsonPath, "utf8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        userList = arr
          .filter((e) => e && typeof e.id === "string" && e.id.trim())
          .map((e) => ({
            id: e.id.trim(),
            name: e.name != null ? String(e.name) : e.id.trim(),
            description: e.description != null ? String(e.description) : null,
            source: "user",
            filepath: e.filepath != null ? String(e.filepath) : `${USER_AGENTS_FILEPATH_PREFIX}/${e.id.trim()}.md`,
          }));
      }
    } catch (_) {}
  }
  if (userList.length === 0 && fs.existsSync(userAgentsDir) && fs.statSync(userAgentsDir).isDirectory()) {
    const names = fs.readdirSync(userAgentsDir);
    for (const n of names) {
      if (!n.endsWith(".md")) continue;
      const id = n.slice(0, -3);
      const fp = path.join(userAgentsDir, n);
      if (!fs.statSync(fp).isFile()) continue;
      const { name, description } = readAgentFrontmatter(fp);
      userList.push({
        id,
        name: name || id,
        description: description || null,
        source: "user",
        filepath: `${USER_AGENTS_FILEPATH_PREFIX}/${id}.md`,
      });
    }
    if (userList.length > 0) {
      try {
        fs.mkdirSync(path.dirname(userAgentsJsonPath), { recursive: true });
        fs.writeFileSync(userAgentsJsonPath, JSON.stringify(userList, null, 2), "utf8");
      } catch (_) {}
    }
  }
  for (const e of userList) out.push(e);

  out.sort((a, b) => (a.source !== b.source ? (a.source === "builtin" ? -1 : 1) : a.id.localeCompare(b.id)));
  return out;
}

export function listAgentsTable(workspaceRoot) {
  const rows = listAgentsJson(workspaceRoot);
  if (rows.length === 0) {
    log.info("No agents found (builtin: agents/agents.json, user: ~/agentflow/agents.json).");
    return;
  }
  const table = new Table({
    head: [chalk.cyan("id"), chalk.cyan("name"), chalk.cyan("source"), chalk.cyan("description")],
    colWidths: [36, 16, 10, 40],
    style: { head: [], border: ["grey"] },
  });
  for (const row of rows) {
    const sourceLabel = row.source === "builtin" ? "builtin" : "user";
    const desc = row.description != null ? String(row.description).slice(0, 38) + (String(row.description).length > 38 ? "…" : "") : "";
    table.push([row.id, row.name || row.id, sourceLabel, desc]);
  }
  log.info("\n" + chalk.bold("Agents (roles)"));
  log.info(table.toString());
}

export function copyBuiltinAgentJson(workspaceRoot, builtinAgentId, targetId) {
  const destId = (targetId && String(targetId).trim()) || builtinAgentId;
  const srcFile = path.join(PACKAGE_AGENTS_DIR, `${builtinAgentId}.md`);
  const userDir = getUserAgentsDirAbs();
  const destFile = path.join(userDir, `${destId}.md`);
  const userJsonPath = getUserAgentsJsonAbs();
  if (!fs.existsSync(srcFile) || !fs.statSync(srcFile).isFile()) {
    return { success: false, error: t("catalog.builtin_agent_not_found") };
  }
  if (fs.existsSync(destFile)) {
    return { success: false, error: t("catalog.name_already_exists") };
  }
  let name = destId;
  let description = null;
  if (fs.existsSync(PACKAGE_AGENTS_JSON) && fs.statSync(PACKAGE_AGENTS_JSON).isFile()) {
    try {
      const raw = fs.readFileSync(PACKAGE_AGENTS_JSON, "utf8");
      const arr = JSON.parse(raw);
      const built = Array.isArray(arr) ? arr.find((e) => e && e.id === builtinAgentId) : null;
      if (built) {
        if (built.name != null) name = String(built.name);
        if (built.description != null) description = String(built.description);
      }
    } catch (_) {}
  }
  if (name === destId) {
    const { name: fmName, description: fmDesc } = readAgentFrontmatter(srcFile);
    if (fmName) name = fmName;
    if (fmDesc) description = fmDesc;
  }
  try {
    fs.mkdirSync(userDir, { recursive: true });
    fs.copyFileSync(srcFile, destFile);
    const filepath = `${USER_AGENTS_FILEPATH_PREFIX}/${destId}.md`;
    const entry = { id: destId, name, description, filepath };
    let list = [];
    if (fs.existsSync(userJsonPath) && fs.statSync(userJsonPath).isFile()) {
      try {
        const raw = fs.readFileSync(userJsonPath, "utf8");
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) list = arr.filter((e) => e && e.id !== destId);
      } catch (_) {}
    }
    list.push(entry);
    list.sort((a, b) => a.id.localeCompare(b.id));
    fs.mkdirSync(path.dirname(userJsonPath), { recursive: true });
    fs.writeFileSync(userJsonPath, JSON.stringify(list, null, 2), "utf8");
    return { success: true };
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) };
  }
}

export function readAgentJson(workspaceRoot, agentId) {
  const agentPath = getAgentPath(workspaceRoot, agentId);
  if (!fs.existsSync(agentPath) || !fs.statSync(agentPath).isFile()) {
    return { error: t("catalog.agent_not_found") };
  }
  try {
    const content = fs.readFileSync(agentPath, "utf8");
    return { content };
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

export function addRoleJson(workspaceRoot, opts) {
  const { builtin = false, id, name, description, contentPath } = opts;
  const idStr = id && typeof id === "string" ? id.trim() : "";
  if (!idStr || idStr.includes("/") || idStr.includes("\\") || idStr.includes("..")) {
    return { success: false, error: t("catalog.invalid_agent_id") };
  }
  if (builtin) {
    const destFile = path.join(PACKAGE_AGENTS_DIR, `${idStr}.md`);
    const destJson = PACKAGE_AGENTS_JSON;
    if (fs.existsSync(destFile)) {
      return { success: false, error: t("catalog.name_already_exists") };
    }
    let content = `---
name: ${name != null ? String(name).replace(/\n/g, " ") : idStr}
description: ${description != null ? String(description).replace(/\n/g, " ") : ""}
---

## 角色定义

（待编辑）
`;
    if (contentPath && fs.existsSync(contentPath) && fs.statSync(contentPath).isFile()) {
      content = fs.readFileSync(contentPath, "utf8");
    }
    try {
      fs.writeFileSync(destFile, content, "utf8");
      const filepath = `agents/${idStr}.md`;
      const entry = { id: idStr, name: name != null ? String(name) : idStr, description: description != null ? String(description) : null, filepath };
      let list = [];
      if (fs.existsSync(destJson) && fs.statSync(destJson).isFile()) {
        try {
          const raw = fs.readFileSync(destJson, "utf8");
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) list = arr.filter((e) => e && e.id !== idStr);
        } catch (_) {}
      }
      list.push(entry);
      list.sort((a, b) => a.id.localeCompare(b.id));
      fs.writeFileSync(destJson, JSON.stringify(list, null, 2), "utf8");
      return { success: true };
    } catch (e) {
      return { success: false, error: (e && e.message) || String(e) };
    }
  }
  const userDir = getUserAgentsDirAbs();
  const destFile = path.join(userDir, `${idStr}.md`);
  const userJsonPath = getUserAgentsJsonAbs();
  if (fs.existsSync(destFile)) {
    return { success: false, error: t("catalog.name_already_exists") };
  }
  let content = `---
name: ${name != null ? String(name).replace(/\n/g, " ") : idStr}
description: ${description != null ? String(description).replace(/\n/g, " ") : ""}
---

## 角色定义

（待编辑）
`;
  if (contentPath && fs.existsSync(contentPath) && fs.statSync(contentPath).isFile()) {
    content = fs.readFileSync(contentPath, "utf8");
  }
  try {
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(destFile, content, "utf8");
    const filepath = `${USER_AGENTS_FILEPATH_PREFIX}/${idStr}.md`;
    const entry = { id: idStr, name: name != null ? String(name) : idStr, description: description != null ? String(description) : null, filepath };
    let list = [];
    if (fs.existsSync(userJsonPath) && fs.statSync(userJsonPath).isFile()) {
      try {
        const raw = fs.readFileSync(userJsonPath, "utf8");
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) list = arr.filter((e) => e && e.id !== idStr);
      } catch (_) {}
    }
    list.push(entry);
    list.sort((a, b) => a.id.localeCompare(b.id));
    fs.mkdirSync(path.dirname(userJsonPath), { recursive: true });
    fs.writeFileSync(userJsonPath, JSON.stringify(list, null, 2), "utf8");
    return { success: true };
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) };
  }
}

export function copyBuiltinJson(workspaceRoot, flowId, targetFlowId) {
  const destId = (targetFlowId && targetFlowId.trim()) || flowId;
  const srcDir = path.join(PACKAGE_BUILTIN_PIPELINES_DIR, flowId);
  const pipelinesRoot = getUserPipelinesRoot();
  const destDir = path.join(pipelinesRoot, destId);
  if (!fs.existsSync(srcDir) || !fs.existsSync(path.join(srcDir, "flow.yaml"))) {
    return { success: false, error: t("catalog.builtin_flow_not_found") };
  }
  const existing = collectPipelineNamesFromDir(pipelinesRoot);
  if (existing.includes(destId)) {
    return { success: false, error: t("catalog.name_already_exists") };
  }
  try {
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.cpSync(srcDir, destDir, { recursive: true });
    return { success: true };
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) };
  }
}
