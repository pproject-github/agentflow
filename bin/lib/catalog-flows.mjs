import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import chalk from "chalk";
import { log } from "./log.mjs";
import { t, translateNodeDef } from "./i18n.mjs";
import {
  ARCHIVED_PIPELINES_DIR_NAME,
  LEGACY_NODES_DIR,
  LEGACY_PIPELINES_DIR,
  PACKAGE_BUILTIN_NODES_DIR,
  PACKAGE_BUILTIN_PIPELINES_DIR,
  PIPELINES_DIR,
  PROJECT_NODES_DIR,
  USER_AGENTFLOW_PIPELINES_LABEL,
  getUserPipelinesRoot,
} from "./paths.mjs";
import { Table } from "./table.mjs";
import { listMarketplaceNodes, parseMarketplaceDefinitionId, resolveMarketplaceNodePackage } from "./marketplace.mjs";

/** 从指定目录收集含 flow.yaml 的子目录名。 */
export function collectPipelineNamesFromDir(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => fs.existsSync(path.join(dirPath, e.name, "flow.yaml")))
    .map((e) => e.name);
}

/**
 * 读取 flow.yaml 中流水线级说明（与 Web UI serialize 一致：ui.description）。
 * @param {string} flowDir 含 flow.yaml 的目录
 * @returns {string | undefined}
 */
export function readPipelineListDescription(flowDir) {
  const yamlPath = path.join(flowDir, "flow.yaml");
  if (!fs.existsSync(yamlPath)) return undefined;
  try {
    const raw = fs.readFileSync(yamlPath, "utf-8");
    const data = yaml.load(raw);
    if (!data || typeof data !== "object") return undefined;
    const ui = data.ui && typeof data.ui === "object" ? data.ui : {};
    const d = ui.description;
    if (typeof d !== "string") return undefined;
    const t = d.trim();
    return t === "" ? undefined : t;
  } catch {
    return undefined;
  }
}

export function listFlowsJson(workspaceRoot, opts = {}) {
  const root = path.resolve(workspaceRoot);
  const out = [];
  const fromBuiltin = collectPipelineNamesFromDir(PACKAGE_BUILTIN_PIPELINES_DIR);
  for (const name of fromBuiltin) {
    const dir = path.join(PACKAGE_BUILTIN_PIPELINES_DIR, name);
    const description = readPipelineListDescription(dir);
    out.push({ id: name, path: dir, source: "builtin", ...(description ? { description } : {}) });
  }
  const userPipelinesRoot = getUserPipelinesRoot(opts.userId);
  const fromUserData = collectPipelineNamesFromDir(userPipelinesRoot);
  for (const name of fromUserData) {
    if (name === ARCHIVED_PIPELINES_DIR_NAME) continue;
    const dir = path.join(userPipelinesRoot, name);
    const description = readPipelineListDescription(dir);
    out.push({ id: name, path: dir, source: "user", ...(description ? { description } : {}) });
  }
  const userArchivedRoot = path.join(userPipelinesRoot, ARCHIVED_PIPELINES_DIR_NAME);
  const fromUserArchived = collectPipelineNamesFromDir(userArchivedRoot);
  for (const name of fromUserArchived) {
    const dir = path.join(userArchivedRoot, name);
    const description = readPipelineListDescription(dir);
    out.push({ id: name, path: dir, source: "user", archived: true, ...(description ? { description } : {}) });
  }
  const wsPrimary = path.join(root, PIPELINES_DIR);
  const fromWorkspace = collectPipelineNamesFromDir(wsPrimary);
  const workspaceIds = new Set(fromWorkspace);
  for (const name of fromWorkspace) {
    if (name === ARCHIVED_PIPELINES_DIR_NAME) continue;
    const dir = path.join(wsPrimary, name);
    const description = readPipelineListDescription(dir);
    out.push({ id: name, path: dir, source: "workspace", ...(description ? { description } : {}) });
  }
  const wsArchivedPrimary = path.join(wsPrimary, ARCHIVED_PIPELINES_DIR_NAME);
  const fromWsArchived = collectPipelineNamesFromDir(wsArchivedPrimary);
  const workspaceArchivedIds = new Set(fromWsArchived);
  for (const name of fromWsArchived) {
    const dir = path.join(wsArchivedPrimary, name);
    const description = readPipelineListDescription(dir);
    out.push({ id: name, path: dir, source: "workspace", archived: true, ...(description ? { description } : {}) });
  }
  const fromLegacyWs = collectPipelineNamesFromDir(path.join(root, LEGACY_PIPELINES_DIR));
  for (const name of fromLegacyWs) {
    if (name === ARCHIVED_PIPELINES_DIR_NAME) continue;
    if (workspaceIds.has(name)) continue;
    const legDir = path.join(root, LEGACY_PIPELINES_DIR, name);
    const description = readPipelineListDescription(legDir);
    out.push({ id: name, path: legDir, source: "workspace", ...(description ? { description } : {}) });
  }
  const legArchivedRoot = path.join(root, LEGACY_PIPELINES_DIR, ARCHIVED_PIPELINES_DIR_NAME);
  const fromLegArchived = collectPipelineNamesFromDir(legArchivedRoot);
  for (const name of fromLegArchived) {
    if (workspaceArchivedIds.has(name)) continue;
    const dir = path.join(legArchivedRoot, name);
    const description = readPipelineListDescription(dir);
    out.push({ id: name, path: dir, source: "workspace", archived: true, ...(description ? { description } : {}) });
    workspaceArchivedIds.add(name);
  }
  const sourceRank = (s) => (s === "builtin" ? 0 : s === "user" ? 1 : 2);
  const archRank = (a) => (a.archived ? 1 : 0);
  out.sort(
    (a, b) =>
      sourceRank(a.source) - sourceRank(b.source) ||
      archRank(a) - archRank(b) ||
      a.id.localeCompare(b.id),
  );
  return out;
}

/** 将 YAML 解析得到的 input/output 项转为 Web UI / 校验使用的槽位结构 */
function normalizeFrontmatterSlots(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((item) => {
    if (!item || typeof item !== "object") return { type: t("catalog.type_text"), name: "", default: "" };
    const type = item.type != null ? String(item.type).trim() : t("catalog.type_text");
    const name = item.name != null ? String(item.name).trim() : "";
    let def = item.default !== undefined && item.default !== null ? item.default : item.value;
    if (def === undefined || def === null) def = "";
    else if (typeof def !== "string") def = String(def);
    const slot = { type, name, default: def };
    if (item.required != null) slot.required = Boolean(item.required);
    if (item.showOnNode != null) slot.showOnNode = Boolean(item.showOnNode);
    return slot;
  });
}

/**
 * 解析 .md 节点文件的 frontmatter。
 * 优先用 js-yaml 解析整块 frontmatter，以支持 description: | / >- 等多行字段；
 * 旧版单行正则会把 `description: |` 误解析成仅一个 `|` 字符，导致 Web UI「系统说明」几乎空白。
 */
export function parseNodeFrontmatter(raw) {
  const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const data = { input: [], output: [], displayName: undefined, description: undefined };
  if (!m) return data;
  const fm = m[1];
  try {
    const parsed = yaml.load(fm);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (parsed.description != null && String(parsed.description).trim() !== "") {
        data.description = String(parsed.description).trim();
      }
      if (parsed.displayName != null && String(parsed.displayName).trim() !== "") {
        data.displayName = String(parsed.displayName).trim();
      }
      data.input = normalizeFrontmatterSlots(parsed.input);
      data.output = normalizeFrontmatterSlots(parsed.output);
      return data;
    }
  } catch {
    /* 非严格 YAML 时回退到正则 */
  }

  const inputBlock = fm.match(/(?:^|\n)\s*input:\s*\n([\s\S]*?)\noutput\s*:/m);
  const outputBlock = fm.match(/(?:^|\n)\s*output:\s*\n([\s\S]*)/m);
  const normalizeSlots = (block) => {
    if (!block) return [];
    const text = block[1];
    const slots = [];
    const parts = text.split(/\n\s*-\s+type:/).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const chunk = (i === 0 ? parts[i] : "  - type:" + parts[i]).trim();
      const typeM = chunk.match(/type:\s*["']?([^"'\n]*)["']?/);
      const nameM = chunk.match(/name:\s*["']?([^"'\n]*)["']?/);
      const defaultM = chunk.match(/(?:default|value):\s*(.*)$/m);
      let defaultVal = defaultM ? defaultM[1].trim().replace(/^["']|["']$/g, "") : undefined;
      if (defaultVal === '""' || defaultVal === "''") defaultVal = "";
      slots.push({
        type: (typeM && typeM[1].trim()) || t("catalog.type_text"),
        name: nameM ? nameM[1].trim() : "",
        default: defaultVal !== undefined ? defaultVal : "",
      });
    }
    return slots;
  };
  data.input = normalizeSlots(inputBlock);
  data.output = normalizeSlots(outputBlock);
  const descM = fm.match(/\bdescription:\s*["']?([^"'\n#][^\n]*)["']?/);
  const displayM = fm.match(/\bdisplayName:\s*["']?([^"'\n#][^\n]*)["']?/);
  if (descM) data.description = descM[1].trim().replace(/^["']|["']$/g, "");
  if (displayM) data.displayName = displayM[1].trim().replace(/^["']|["']$/g, "");
  return data;
}

/**
 * @param {string} workspaceRoot
 * @param {string} flowId
 * @param {string} flowSource
 * @param {{ archived?: boolean }} [opts]
 */
export function listNodesJson(workspaceRoot, flowId, flowSource, opts = {}) {
  const root = path.resolve(workspaceRoot);
  const archived = Boolean(opts.archived);
  const userPipelinesRoot = getUserPipelinesRoot(opts.userId);
  const byId = new Map();
  const pipelineTranslations = {};
  let marketplaceFlowData = null;
  if (flowId && flowSource) {
    const flowPath = getFlowYamlAbs(workspaceRoot, flowId, flowSource, opts);
    if (flowPath.path && fs.existsSync(flowPath.path)) {
      try {
        const parsed = yaml.load(fs.readFileSync(flowPath.path, "utf-8"));
        if (parsed && typeof parsed === "object") marketplaceFlowData = parsed;
      } catch (_) {}
    }
  }
  const addFromDir = (dir, source, flowIdOpt) => {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
    const files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md"));
    for (const e of files) {
      const id = e.name.replace(/\.mdx?$/i, "").replace(/\.markdown$/i, "");
      let type = "agent";
      if (/^control/i.test(id)) type = "control";
      else if (/^provide/i.test(id)) type = "provide";
      else if (/^tool/i.test(id)) type = "agent";
      try {
        const raw = fs.readFileSync(path.join(dir, e.name), "utf-8");
        const data = parseNodeFrontmatter(raw);
        const strippedId =
          id.replace(/^agent_?/i, "").replace(/^control_?/i, "").replace(/^provide_?/i, "").replace(/^tool_?/i, "") || id;
        const label = data.displayName ?? strippedId;
        const translatedDisplayName = translateNodeDef(id, "displayName");
        const translatedDescription = translateNodeDef(id, "description");
        byId.set(id, {
          id,
          type,
          label: translatedDisplayName || label,
          displayName: translatedDisplayName || data.displayName,
          description: translatedDescription || data.description,
          inputs: data.input,
          outputs: data.output,
          source: flowIdOpt ? "flow" : "project",
          flowId: flowIdOpt,
        });
      } catch (_) {}
    }
  };
  addFromDir(PACKAGE_BUILTIN_NODES_DIR, "project");
  addFromDir(path.join(root, LEGACY_NODES_DIR), "project");
  addFromDir(path.join(root, PROJECT_NODES_DIR), "project");
  for (const manifest of listMarketplaceNodes(root, marketplaceFlowData)) {
    let type = "agent";
    const runtimeType = String(manifest.runtime?.type || manifest.type || "").toLowerCase();
    if (runtimeType.startsWith("control")) type = "control";
    else if (runtimeType.startsWith("provide")) type = "provide";
    byId.set(manifest.definitionId, {
      id: manifest.definitionId,
      packageId: manifest.id,
      version: manifest.version,
      type,
      label: manifest.displayName,
      displayName: manifest.displayName,
      description: manifest.description,
      inputs: manifest.input,
      outputs: manifest.output,
      source: manifest.source || "marketplace",
      packageDir: manifest.packageDir,
      runtime: manifest.runtime,
    });
  }
  if (flowId && flowSource) {
    if (flowSource === "builtin") {
      addFromDir(path.join(PACKAGE_BUILTIN_PIPELINES_DIR, flowId, "nodes"), "flow", flowId);
      try {
        const flowYamlPath = path.join(PACKAGE_BUILTIN_PIPELINES_DIR, flowId, "flow.yaml");
        if (fs.existsSync(flowYamlPath)) {
          const flowData = yaml.load(fs.readFileSync(flowYamlPath, "utf-8"));
          if (flowData?.instances) {
            for (const [nodeId, inst] of Object.entries(flowData.instances)) {
              pipelineTranslations[flowId] = pipelineTranslations[flowId] || {};
              const trans = t(`pipeline.${flowId}.${nodeId}`);
              pipelineTranslations[flowId][nodeId] = {
                label: trans !== `pipeline.${flowId}.${nodeId}` ? trans : inst.label,
                body: inst.body,
                description: inst.description || inst.userDescription,
              };
            }
          }
          if (flowData?.ui?.description) {
            pipelineTranslations[flowId].__flowDescription = t(`pipeline.${flowId}.description`) !== `pipeline.${flowId}.description`
              ? t(`pipeline.${flowId}.description`)
              : flowData.ui.description;
          }
        }
      } catch (_) {}
    } else if (flowSource === "user") {
      if (archived) {
        addFromDir(path.join(userPipelinesRoot, ARCHIVED_PIPELINES_DIR_NAME, flowId, "nodes"), "flow", flowId);
      } else {
        addFromDir(path.join(userPipelinesRoot, flowId, "nodes"), "flow", flowId);
        addFromDir(path.join(root, PIPELINES_DIR, flowId, "nodes"), "flow", flowId);
        addFromDir(path.join(root, LEGACY_PIPELINES_DIR, flowId, "nodes"), "flow", flowId);
      }
    } else if (flowSource === "workspace") {
      if (archived) {
        addFromDir(path.join(root, PIPELINES_DIR, ARCHIVED_PIPELINES_DIR_NAME, flowId, "nodes"), "flow", flowId);
        addFromDir(path.join(root, LEGACY_PIPELINES_DIR, ARCHIVED_PIPELINES_DIR_NAME, flowId, "nodes"), "flow", flowId);
      } else {
        addFromDir(path.join(root, PIPELINES_DIR, flowId, "nodes"), "flow", flowId);
        addFromDir(path.join(root, LEGACY_PIPELINES_DIR, flowId, "nodes"), "flow", flowId);
      }
    }
  }
  return { nodes: Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id)), pipelineTranslations };
}

export function printNodesTable(list) {
  const maxDesc = 56;
  const truncate = (s) => {
    if (s == null) return "";
    const t = String(s).replace(/\r?\n/g, " ").trim();
    return t.length <= maxDesc ? t : t.slice(0, maxDesc - 2) + "…";
  };
  const table = new Table({
    head: [chalk.bold("id"), chalk.bold("type"), chalk.bold("label"), chalk.bold("source"), chalk.bold("description")],
    colWidths: [28, 12, 16, 10, maxDesc + 2],
  });
  for (const n of list) {
    table.push([n.id, n.type, n.displayName ?? n.label, n.source, truncate(n.description)]);
  }
  process.stdout.write(table.toString() + "\n");
}

/**
 * @param {string} workspaceRoot
 * @param {string} flowId
 * @param {string} flowSource
 * @param {{ archived?: boolean }} [options]
 */
export function readFlowJson(workspaceRoot, flowId, flowSource, options = {}) {
  const root = path.resolve(workspaceRoot);
  const archived = Boolean(options.archived);
  const userPipelinesRoot = getUserPipelinesRoot(options.userId);
  let flowDir;
  if (archived) {
    if (flowSource === "builtin") {
      return { error: t("catalog.builtin_flow_archive_not_supported") };
    }
    if (flowSource === "user") {
      flowDir = path.join(userPipelinesRoot, ARCHIVED_PIPELINES_DIR_NAME, flowId);
    } else if (flowSource === "workspace") {
      flowDir = path.join(root, PIPELINES_DIR, ARCHIVED_PIPELINES_DIR_NAME, flowId);
    } else {
      return { error: "Invalid flowSource" };
    }
    let yamlPath = path.join(flowDir, "flow.yaml");
    if (flowSource === "workspace" && !fs.existsSync(yamlPath)) {
      const legDir = path.join(root, LEGACY_PIPELINES_DIR, ARCHIVED_PIPELINES_DIR_NAME, flowId);
      const legYaml = path.join(legDir, "flow.yaml");
      if (fs.existsSync(legYaml)) {
        flowDir = legDir;
        yamlPath = legYaml;
      }
    }
    if (!fs.existsSync(yamlPath)) {
      return { error: "Flow not found: " + flowId };
    }
    try {
      const flowYaml = fs.readFileSync(yamlPath, "utf-8");
      return { flowYaml };
    } catch (e) {
      return { error: (e && e.message) || String(e) };
    }
  }

  if (flowSource === "builtin") {
    flowDir = path.join(PACKAGE_BUILTIN_PIPELINES_DIR, flowId);
  } else if (flowSource === "user") {
    flowDir = path.join(userPipelinesRoot, flowId);
  } else if (flowSource === "workspace") {
    flowDir = path.join(root, PIPELINES_DIR, flowId);
  } else {
    return { error: "Invalid flowSource" };
  }
  let yamlPath = path.join(flowDir, "flow.yaml");
  if (flowSource === "user" && !fs.existsSync(yamlPath)) {
    for (const rel of [PIPELINES_DIR, LEGACY_PIPELINES_DIR]) {
      const wsDir = path.join(root, rel, flowId);
      const wsYaml = path.join(wsDir, "flow.yaml");
      if (fs.existsSync(wsYaml)) {
        flowDir = wsDir;
        yamlPath = wsYaml;
        break;
      }
    }
  }
  if (flowSource === "workspace" && !fs.existsSync(yamlPath)) {
    const legDir = path.join(root, LEGACY_PIPELINES_DIR, flowId);
    const legYaml = path.join(legDir, "flow.yaml");
    if (fs.existsSync(legYaml)) {
      flowDir = legDir;
      yamlPath = legYaml;
    }
  }
  if (!fs.existsSync(yamlPath)) {
    return { error: "Flow not found: " + flowId };
  }
  try {
    const flowYaml = fs.readFileSync(yamlPath, "utf-8");
    return { flowYaml };
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

/**
 * 解析 flow.yaml 绝对路径（与 readFlowJson 一致；user 含 workspace 回退）。
 * @param {{ archived?: boolean }} [options]
 * @returns {{ path: string } | { error: string }}
 */
export function getFlowYamlAbs(workspaceRoot, flowId, flowSource, options = {}) {
  const root = path.resolve(workspaceRoot);
  const archived = Boolean(options.archived);
  const userPipelinesRoot = getUserPipelinesRoot(options.userId);
  let yamlPath;
  if (archived) {
    if (flowSource === "builtin") {
      return { error: t("catalog.builtin_flow_archive_path_not_supported") };
    }
    if (flowSource === "user") {
      yamlPath = path.join(userPipelinesRoot, ARCHIVED_PIPELINES_DIR_NAME, flowId, "flow.yaml");
    } else if (flowSource === "workspace") {
      yamlPath = path.join(root, PIPELINES_DIR, ARCHIVED_PIPELINES_DIR_NAME, flowId, "flow.yaml");
      if (!fs.existsSync(yamlPath)) {
        const altLeg = path.join(root, LEGACY_PIPELINES_DIR, ARCHIVED_PIPELINES_DIR_NAME, flowId, "flow.yaml");
        if (fs.existsSync(altLeg)) yamlPath = altLeg;
      }
    } else {
      return { error: "Invalid flowSource" };
    }
    if (!fs.existsSync(yamlPath)) {
      return { error: "Flow not found: " + flowId };
    }
    return { path: yamlPath };
  }

  if (flowSource === "builtin") {
    yamlPath = path.join(PACKAGE_BUILTIN_PIPELINES_DIR, flowId, "flow.yaml");
  } else if (flowSource === "user") {
    yamlPath = path.join(userPipelinesRoot, flowId, "flow.yaml");
    if (!fs.existsSync(yamlPath)) {
      const alt = path.join(root, PIPELINES_DIR, flowId, "flow.yaml");
      if (fs.existsSync(alt)) yamlPath = alt;
    }
    if (!fs.existsSync(yamlPath)) {
      const altLeg = path.join(root, LEGACY_PIPELINES_DIR, flowId, "flow.yaml");
      if (fs.existsSync(altLeg)) yamlPath = altLeg;
    }
  } else if (flowSource === "workspace") {
    yamlPath = path.join(root, PIPELINES_DIR, flowId, "flow.yaml");
    if (!fs.existsSync(yamlPath)) {
      const altLeg = path.join(root, LEGACY_PIPELINES_DIR, flowId, "flow.yaml");
      if (fs.existsSync(altLeg)) yamlPath = altLeg;
    }
  } else {
    return { error: "Invalid flowSource" };
  }
  if (!fs.existsSync(yamlPath)) {
    return { error: "Flow not found: " + flowId };
  }
  return { path: yamlPath };
}

export function readNodeJson(workspaceRoot, nodeId, flowId, flowSource, opts = {}) {
  const root = path.resolve(workspaceRoot);
  const archived = Boolean(opts.archived);
  const userPipelinesRoot = getUserPipelinesRoot(opts.userId);
  const marketSpec = parseMarketplaceDefinitionId(nodeId);
  if (marketSpec) {
    let flowDir = root;
    if (flowId && flowSource) {
      const flowPath = getFlowYamlAbs(workspaceRoot, flowId, flowSource, opts);
      if (flowPath.path) flowDir = path.dirname(flowPath.path);
      if (flowPath.path && fs.existsSync(flowPath.path)) {
        try {
          const parsed = yaml.load(fs.readFileSync(flowPath.path, "utf-8"));
          if (parsed && typeof parsed === "object") opts.flowData = parsed;
        } catch (_) {}
      }
    }
    const resolved = resolveMarketplaceNodePackage(root, flowDir, nodeId, opts.flowData || null);
    if (!resolved) return { error: "Node not found: " + nodeId };
    const readmePath = path.join(resolved.packageDir, "README.md");
    let type = "agent";
    const runtimeType = String(resolved.runtime?.type || resolved.type || "").toLowerCase();
    if (runtimeType.startsWith("control")) type = "control";
    else if (runtimeType.startsWith("provide")) type = "provide";
    return {
      type,
      label: resolved.displayName,
      displayName: resolved.displayName,
      inputs: resolved.input,
      outputs: resolved.output,
      executionLogic: fs.existsSync(readmePath) ? fs.readFileSync(readmePath, "utf-8").trim() : undefined,
      description: resolved.description,
      packageId: resolved.id,
      version: resolved.version,
      packageDir: resolved.packageDir,
      runtime: resolved.runtime,
    };
  }
  const fileName = nodeId.endsWith(".md") ? nodeId : `${nodeId}.md`;
  const pathsToTry = [];
  if (flowId && flowSource) {
    if (flowSource === "builtin") {
      pathsToTry.push(path.join(PACKAGE_BUILTIN_PIPELINES_DIR, flowId, "nodes", fileName));
    } else if (flowSource === "user") {
      if (archived) {
        pathsToTry.push(path.join(userPipelinesRoot, ARCHIVED_PIPELINES_DIR_NAME, flowId, "nodes", fileName));
      } else {
        pathsToTry.push(path.join(userPipelinesRoot, flowId, "nodes", fileName));
        pathsToTry.push(path.join(root, PIPELINES_DIR, flowId, "nodes", fileName));
        pathsToTry.push(path.join(root, LEGACY_PIPELINES_DIR, flowId, "nodes", fileName));
      }
    } else if (flowSource === "workspace") {
      if (archived) {
        pathsToTry.push(path.join(root, PIPELINES_DIR, ARCHIVED_PIPELINES_DIR_NAME, flowId, "nodes", fileName));
        pathsToTry.push(path.join(root, LEGACY_PIPELINES_DIR, ARCHIVED_PIPELINES_DIR_NAME, flowId, "nodes", fileName));
      } else {
        pathsToTry.push(path.join(root, PIPELINES_DIR, flowId, "nodes", fileName));
        pathsToTry.push(path.join(root, LEGACY_PIPELINES_DIR, flowId, "nodes", fileName));
      }
    }
  }
  pathsToTry.push(path.join(root, PROJECT_NODES_DIR, fileName));
  pathsToTry.push(path.join(root, LEGACY_NODES_DIR, fileName));
  pathsToTry.push(path.join(PACKAGE_BUILTIN_NODES_DIR, fileName));
  for (const filePath of pathsToTry) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = parseNodeFrontmatter(raw);
      const content = raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "").trim();
      let type = "agent";
      if (/^control/i.test(nodeId)) type = "control";
      else if (/^provide/i.test(nodeId)) type = "provide";
      else if (/^tool/i.test(nodeId)) type = "agent";
      const strippedId =
        nodeId
          .replace(/\.md$/, "")
          .replace(/^agent_?/i, "")
          .replace(/^control_?/i, "")
          .replace(/^provide_?/i, "")
          .replace(/^tool_?/i, "") || nodeId;
      const label = data.displayName ?? strippedId;
      return {
        type,
        label,
        displayName: data.displayName,
        inputs: data.input,
        outputs: data.output,
        executionLogic: content || undefined,
        description: data.description,
      };
    } catch (_) {}
  }
  return { error: "Node not found: " + nodeId };
}

const NODE_DETAIL_MAX_FILES = 300;
const NODE_FILE_MAX_BYTES = 256 * 1024;

function isTextPreviewPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return [
    ".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
    ".py", ".sh", ".css", ".html", ".xml", ".toml", ".ini", ".env", ".sql",
  ].includes(ext);
}

function listNodeFiles(baseDir, allowAllFiles, primaryFilePath = "") {
  const root = path.resolve(baseDir);
  const out = [];
  const addFile = (filePath) => {
    if (out.length >= NODE_DETAIL_MAX_FILES) return;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return;
      const rel = path.relative(root, filePath).replace(/\\/g, "/");
      out.push({
        path: rel,
        size: stat.size,
        previewable: isTextPreviewPath(filePath),
      });
    } catch (_) {}
  };
  if (!allowAllFiles) {
    if (primaryFilePath) addFile(primaryFilePath);
    return out;
  }
  const walk = (dir) => {
    if (out.length >= NODE_DETAIL_MAX_FILES) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= NODE_DETAIL_MAX_FILES) return;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) addFile(p);
    }
  };
  walk(root);
  return out;
}

function resolveMarkdownNodeFile(workspaceRoot, nodeId, flowId, flowSource, opts = {}) {
  const root = path.resolve(workspaceRoot);
  const archived = Boolean(opts.archived);
  const userPipelinesRoot = getUserPipelinesRoot(opts.userId);
  const fileName = nodeId.endsWith(".md") ? nodeId : `${nodeId}.md`;
  const pathsToTry = [];
  if (flowId && flowSource) {
    if (flowSource === "builtin") {
      pathsToTry.push(path.join(PACKAGE_BUILTIN_PIPELINES_DIR, flowId, "nodes", fileName));
    } else if (flowSource === "user") {
      if (archived) {
        pathsToTry.push(path.join(userPipelinesRoot, ARCHIVED_PIPELINES_DIR_NAME, flowId, "nodes", fileName));
      } else {
        pathsToTry.push(path.join(userPipelinesRoot, flowId, "nodes", fileName));
        pathsToTry.push(path.join(root, PIPELINES_DIR, flowId, "nodes", fileName));
        pathsToTry.push(path.join(root, LEGACY_PIPELINES_DIR, flowId, "nodes", fileName));
      }
    } else if (flowSource === "workspace") {
      if (archived) {
        pathsToTry.push(path.join(root, PIPELINES_DIR, ARCHIVED_PIPELINES_DIR_NAME, flowId, "nodes", fileName));
        pathsToTry.push(path.join(root, LEGACY_PIPELINES_DIR, ARCHIVED_PIPELINES_DIR_NAME, flowId, "nodes", fileName));
      } else {
        pathsToTry.push(path.join(root, PIPELINES_DIR, flowId, "nodes", fileName));
        pathsToTry.push(path.join(root, LEGACY_PIPELINES_DIR, flowId, "nodes", fileName));
      }
    }
  }
  pathsToTry.push(path.join(root, PROJECT_NODES_DIR, fileName));
  pathsToTry.push(path.join(root, LEGACY_NODES_DIR, fileName));
  pathsToTry.push(path.join(PACKAGE_BUILTIN_NODES_DIR, fileName));
  return pathsToTry.find((p) => fs.existsSync(p) && fs.statSync(p).isFile()) || "";
}

function readNodeUsage(workspaceRoot, nodeId, opts = {}) {
  const usage = [];
  const marketSpec = parseMarketplaceDefinitionId(nodeId);
  for (const flow of listFlowsJson(workspaceRoot, opts)) {
    const flowPath = getFlowYamlAbs(workspaceRoot, flow.id, flow.source || "user", { archived: Boolean(flow.archived), userId: opts.userId });
    if (!flowPath.path) continue;
    try {
      const data = yaml.load(fs.readFileSync(flowPath.path, "utf-8"));
      const instances = data && typeof data === "object" ? data.instances : null;
      const hits = [];
      if (marketSpec) {
        const deps = data && typeof data === "object" && data.dependencies && typeof data.dependencies === "object" ? data.dependencies : {};
        const nodeDeps = Array.isArray(deps.nodes) ? deps.nodes : [];
        if (nodeDeps.some((dep) => {
          const parsed = typeof dep === "string"
            ? parseMarketplaceDefinitionId(dep.startsWith("marketplace:") ? dep : `marketplace:${dep}`)
            : dep && typeof dep === "object"
              ? { id: dep.id, version: dep.version != null ? String(dep.version) : null }
              : null;
          return parsed && parsed.id === marketSpec.id && (!parsed.version || !marketSpec.version || parsed.version === marketSpec.version);
        })) {
          hits.push({ instanceId: "dependencies.nodes", label: "dependency" });
        }
      }
      if (instances && typeof instances === "object") {
        hits.push(...Object.entries(instances)
          .filter(([, inst]) => {
            if (!inst) return false;
            if (!marketSpec) return inst.definitionId === nodeId;
            const parsed = parseMarketplaceDefinitionId(inst.definitionId);
            return parsed && parsed.id === marketSpec.id && (!parsed.version || !marketSpec.version || parsed.version === marketSpec.version);
          })
          .map(([instanceId, inst]) => ({ instanceId, label: inst.label || instanceId })));
      }
      if (hits.length > 0) {
        usage.push({ flowId: flow.id, flowSource: flow.source || "user", archived: Boolean(flow.archived), instances: hits });
      }
    } catch (_) {}
  }
  return usage;
}

function resolveNodeFileScope(workspaceRoot, nodeId, flowId, flowSource, opts = {}) {
  const marketSpec = parseMarketplaceDefinitionId(nodeId);
  if (marketSpec) {
    let flowDir = path.resolve(workspaceRoot);
    let flowData = null;
    if (flowId && flowSource) {
      const flowPath = getFlowYamlAbs(workspaceRoot, flowId, flowSource, opts);
      if (flowPath.path) {
        flowDir = path.dirname(flowPath.path);
        try {
          const parsed = yaml.load(fs.readFileSync(flowPath.path, "utf-8"));
          if (parsed && typeof parsed === "object") flowData = parsed;
        } catch (_) {}
      }
    }
    const resolved = resolveMarketplaceNodePackage(workspaceRoot, flowDir, nodeId, flowData);
    if (!resolved) return null;
    return { baseDir: resolved.packageDir, allowAllFiles: true, primaryFilePath: path.join(resolved.packageDir, "node.yaml"), manifest: resolved };
  }
  const filePath = resolveMarkdownNodeFile(workspaceRoot, nodeId, flowId, flowSource, opts);
  if (!filePath) return null;
  return { baseDir: path.dirname(filePath), allowAllFiles: false, primaryFilePath: filePath, manifest: null };
}

export function readNodeDetailJson(workspaceRoot, nodeId, flowId = "", flowSource = "", opts = {}) {
  if (!nodeId) return { error: "Missing node id" };
  const node = readNodeJson(workspaceRoot, nodeId, flowId, flowSource, opts);
  if (node.error) return node;
  const scope = resolveNodeFileScope(workspaceRoot, nodeId, flowId, flowSource, opts);
  const files = scope ? listNodeFiles(scope.baseDir, scope.allowAllFiles, scope.primaryFilePath) : [];
  return {
    node: { id: nodeId, ...node },
    readOnly: true,
    manifest: scope?.manifest || null,
    runtime: node.runtime || scope?.manifest?.runtime || null,
    body: node.executionLogic || "",
    baseDir: scope?.baseDir || "",
    files,
    usage: readNodeUsage(workspaceRoot, nodeId, opts),
  };
}

export function readNodeFilePreview(workspaceRoot, nodeId, relPath, flowId = "", flowSource = "", opts = {}) {
  if (!nodeId) return { error: "Missing node id" };
  const rel = String(relPath || "").trim();
  if (!rel || rel.includes("\0") || path.isAbsolute(rel) || rel.split(/[\\/]+/).includes("..")) {
    return { error: "Invalid file path" };
  }
  const scope = resolveNodeFileScope(workspaceRoot, nodeId, flowId, flowSource, opts);
  if (!scope) return { error: "Node files not found" };
  if (!scope.allowAllFiles) {
    const primaryRel = path.relative(scope.baseDir, scope.primaryFilePath).replace(/\\/g, "/");
    if (rel !== primaryRel) return { error: "File is outside node preview scope" };
  }
  const base = path.resolve(scope.baseDir);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return { error: "File is outside node package" };
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { error: "File not found" };
  const stat = fs.statSync(abs);
  if (!isTextPreviewPath(abs)) {
    return { path: rel, size: stat.size, binary: true, content: "", truncated: false };
  }
  const fd = fs.openSync(abs, "r");
  try {
    const len = Math.min(stat.size, NODE_FILE_MAX_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return { path: rel, size: stat.size, binary: false, content: buf.toString("utf-8"), truncated: stat.size > len };
  } finally {
    fs.closeSync(fd);
  }
}

/** 列出所有 pipeline（包内 builtin + ~/agentflow/pipelines + 项目内 .workspace/.cursor agentflow/pipelines）；nodes 见 PROJECT_NODES_DIR / LEGACY_NODES_DIR */
export function listPipelines(workspaceRoot) {
  const rows = listFlowsJson(workspaceRoot);
  if (rows.length === 0) {
    log.info(
      "No pipelines found (no subdirs with flow.yaml under builtin, " +
        USER_AGENTFLOW_PIPELINES_LABEL +
        ", " +
        PIPELINES_DIR +
        " or " +
        LEGACY_PIPELINES_DIR +
        ").",
    );
    return;
  }
  const table = new Table({
    head: [chalk.cyan(t("catalog.pipeline_header")), chalk.cyan(t("catalog.source_header")), chalk.cyan(t("catalog.apply_example_header"))],
    colWidths: [24, 10, 48],
    style: { head: [], border: ["grey"] },
  });
  for (const row of rows) {
    const sourceLabel = row.source === "builtin" ? "builtin" : row.source === "workspace" ? "workspace" : "user";
    table.push([row.id, sourceLabel, `agentflow apply ${row.id}`]);
  }
  log.info("\n" + chalk.bold("Pipelines"));
  log.info(table.toString());
}
