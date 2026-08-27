#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configureAgentFlowRuntime,
  loadAgentFlowRuntime,
  resolveAgentFlowPackageRoot,
} from "./agentflow-runtime.mjs";
import {
  agentFlowAuthFile,
  clearAgentFlowPendingAuthorization,
  clearAgentFlowProfile,
  saveAgentFlowPendingAuthorization,
  saveAgentFlowProfile,
  savedAgentFlowPendingAuthorization,
  savedAgentFlowProfile,
} from "./agentflow-auth-store.mjs";
import { createWorkflowReportClient } from "./workflow-report-client.mjs";

const DEFAULT_BASE_URL = "http://ai.mengma.bigo.inner/";
const DISPLAY_DEFINITION_KINDS = new Map([
  ["display_markdown", "markdown"],
  ["display_mermaid", "mermaid"],
  ["display_ascii", "ascii"],
  ["display_html", "html"],
  ["display_react_app", "react"],
  ["display_image", "image"],
  ["display_chart", "chart"],
  ["display_table", "table"],
]);

/**
 * `--file` 可以是流程目录、workspace.flow.js，或历史的 workspace.graph.json。
 * 前两种要静态解析代码才能拿到图，交给 agentflow 自己的存储层——不在这里重实现一遍。
 */
async function readWorkspaceGraphArg(target, marketplaceRoot = process.cwd()) {
  const file = String(target || "");
  if (!file) throw new Error("--file is required");
  const stat = fs.statSync(file);
  const dir = stat.isDirectory() ? file : path.dirname(file);
  if (!stat.isDirectory() && file.endsWith(".json")) return readJsonFile(file);
  const runtime = await loadAgentFlowRuntime();
  const design = runtime.readWorkspaceDesign(dir, { marketplaceRoot });
  if (design.format === "empty") throw new Error(`No workspace graph in ${dir}`);
  const statePath = path.join(dir, runtime.WORKSPACE_STATE_FILENAME);
  const localState = fs.existsSync(statePath) ? readJsonFile(statePath) : null;
  return runtime.mergeWorkspaceState(design.graph, localState);
}

function usage() {
  return `AgentFlow direct API CLI

Usage:
  agentflow-cli <command> [options]

Config:
  --base-url <url>       Override AGENTFLOW_BASE_URL
  --token <token>        Override AGENTFLOW_TOKEN
  --agentflow-package-root <dir>  Development override for the bundled Skill runtime
  AGENTFLOW_BASE_URL     Defaults to ${DEFAULT_BASE_URL}
  AGENTFLOW_TOKEN        Overrides saved browser authorization
  AGENTFLOW_ENV_FILE     Optional dotenv file path
  AGENTFLOW_AUTH_FILE    Optional saved authorization path

Commands:
  config
  auth start | auth login
  auth complete
  auth status
  auth logout
  dsl-lint --file <flowDir|workspace.flow.js> [--workspace-root <dir>]
  dsl-layout --file <flowDir|workspace.flow.js> [--workspace-root <dir>] [--all]
  list-workspace | list-workspaces
  list-flows
  node-package-list
  node-package-search --query <text> [--limit <n>]
  node-package-publish --file <nodePackageDir>
  node-package-install --node <id>@<version> [--workspace-root <dir>]
  node-package-sync --flow <flowDir|workspace.flow.js> [--workspace-root <dir>]
  marketplace-list [--kind flow|node] [--owned] [--query <text>]
  marketplace-flow-publish --flow-id <id> [--flow-source user] [--version 1.0.0] [--visibility public|private]
  marketplace-flow-install --flow <id>@<version> [--flow-id <targetId>]
  marketplace-visibility --kind flow|node --resource <id>@<version> --visibility public|private
  pull-flow --flow-id <id> [--flow-source user] [--output <flowDir>] [--workspace-root <dir>] [--replace]
  publish-flow --flow-id <id> --file <flowDir|workspace.flow.js|flow.yaml> [--target-space personal|workspace|team] [--schedule enabled|disabled|preserve] [--with-dependencies] [--replace]
  get-graph --flow-id <id> [--flow-source user]
  migrate-flow --flow-id <id> [--flow-source user] [--archived] [--allow-loss]
  migrate-all [--include-archived] [--allow-loss] [--dry-run]
  workspace-preview --file <flowDir|workspace.flow.js|workspace.graph.json> [--preview-id <id>] [--ttl-seconds <n>]
  draft-create --file <flowDir|workspace.flow.js|workspace.graph.json> [--draft-id <id>] [--ttl-seconds <n>] [--with-dependencies]
  draft-pull --draft-id <id> [--output <flowDir>] [--workspace-root <dir>] [--replace]
  draft-update --draft-id <id> --base-revision <revision> --file <flowDir|workspace.flow.js|workspace.graph.json> [--ttl-seconds <n>] [--with-dependencies]
  draft-run --draft-id <id> [--run-node-id <id>] [--input k=v]
  draft-publish --draft-id <id> --flow-id <id> [--target-space personal|workspace|team] [--schedule enabled|disabled|preserve]
  run --flow-id <id> [--flow-source user] [--run-node-id <id>] [--input k=v]
  status --flow-id <id> [--flow-source user]
  list-run-by-workspace | list-runs-by-workspace --workspace <flowId> [--limit 20]
  list-runs [--flow-id <id>] [--flow-source user] [--limit 20]
  logs --run-id <id>
  display-outputs --flow-id <id> [--flow-source user]
  schedule-list [--flow-id <id>] [--flow-source user]
  schedule-set --flow-id <id> --schedule-node-id <id> [--enabled true|false] [--cron <expr>] [--timezone <tz>] [--overlap-policy skip]
  schedule-enable --flow-id <id> --schedule-node-id <id>
  schedule-disable --flow-id <id> --schedule-node-id <id>
  schedule-run-now --flow-id <id> --schedule-node-id <id> [--input k=v]
  sync-workspace --workspace <id>
  workflow-get --workflow tapd:<id> [--flow-id <id>] [--runtime-only] [--admin-operation repair-version-membership]
  workflow-access-sync --workflow tapd:<id> --file <access.json>
  workflow-report --workflow tapd:<id> --file <report.json> [--source <adapter>] [--expected-revision <revision>] [--idempotency-key <key>] [--admin-operation repair-version-membership]
  workflow-artifact-publish --workflow tapd:<id> --file <artifact.json> [--source <adapter>] [--expected-revision <revision>] [--idempotency-key <key>]
`;
}

function parseDotenvValue(raw) {
  let value = String(raw ?? "").trim();
  if (!value) return "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.replace(/\\n/g, "\n");
}

function loadEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = parseDotenvValue(match[2]);
  }
}

function loadEnvFiles() {
  const cwd = process.cwd();
  const candidates = [
    process.env.AGENTFLOW_ENV_FILE,
    path.join(cwd, ".env"),
    path.join(cwd, ".agentflow.env"),
    path.join(os.homedir(), ".agentflow.env"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    loadEnvFile(path.resolve(candidate));
  }
}

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      out._.push(item);
      continue;
    }
    const eq = item.indexOf("=");
    let key = item.slice(2);
    let value = true;
    if (eq >= 0) {
      key = item.slice(2, eq);
      value = item.slice(eq + 1);
    } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      value = argv[i + 1];
      i += 1;
    }
    if (out[key] !== undefined) {
      if (!Array.isArray(out[key])) out[key] = [out[key]];
      out[key].push(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function option(args, name, fallback = "") {
  const value = args[name];
  if (Array.isArray(value)) return value[value.length - 1] ?? fallback;
  if (value === true || value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function normalizedBaseUrl(args) {
  const raw = option(args, "base-url") || process.env.AGENTFLOW_BASE_URL || DEFAULT_BASE_URL;
  return String(raw).replace(/\/+$/, "");
}

function resolvedAuth(args) {
  const fromFlag = option(args, "token");
  if (fromFlag) return { token: fromFlag, source: "flag", profile: null };
  const fromTokenEnv = String(process.env.AGENTFLOW_TOKEN || "").trim();
  if (fromTokenEnv) return { token: fromTokenEnv, source: "AGENTFLOW_TOKEN", profile: null };
  const fromSessionEnv = String(process.env.AGENTFLOW_SESSION_TOKEN || "").trim();
  if (fromSessionEnv) return { token: fromSessionEnv, source: "AGENTFLOW_SESSION_TOKEN", profile: null };
  const profile = savedAgentFlowProfile(normalizedBaseUrl(args));
  return profile?.token
    ? { token: profile.token, source: "saved-auth", profile }
    : { token: "", source: "", profile: null };
}

function authToken(args, required = true) {
  const trimmed = String(resolvedAuth(args).token || "").trim();
  if (required && !trimmed) {
    throw new Error("AgentFlow authorization is missing. Run `auth start`, open the returned URL, then run `auth complete`; or set AGENTFLOW_TOKEN.");
  }
  return trimmed;
}

function query(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

async function httpJson(args, pathname, { method = "GET", body, tokenRequired = true } = {}) {
  const token = authToken(args, tokenRequired);
  const url = new URL(pathname, normalizedBaseUrl(args));
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers.Cookie = `af_session=${encodeURIComponent(token)}`;
  }
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { text };
  }
  if (!response.ok) {
    const message = data?.error || data?.message || text || `HTTP ${response.status}`;
    const error = new Error(`${method} ${url.pathname} failed: ${message}`);
    error.status = response.status;
    error.response = data;
    throw error;
  }
  return data;
}

async function httpMultipart(args, pathname, form) {
  const token = authToken(args);
  const url = new URL(pathname, normalizedBaseUrl(args));
  const headers = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers.Cookie = `af_session=${encodeURIComponent(token)}`;
  }
  const response = await fetch(url, { method: "POST", headers, body: form });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { text };
  }
  if (!response.ok) {
    const message = data?.error || data?.message || text || `HTTP ${response.status}`;
    const error = new Error(`POST ${url.pathname} failed: ${message}`);
    error.status = response.status;
    error.response = data;
    throw error;
  }
  return data;
}

async function httpBuffer(args, pathname) {
  const token = authToken(args);
  const url = new URL(pathname, normalizedBaseUrl(args));
  const headers = { Accept: "application/zip" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers.Cookie = `af_session=${encodeURIComponent(token)}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try { message = JSON.parse(text)?.error || text; } catch { /* keep text */ }
    const error = new Error(`GET ${url.pathname} failed: ${message || `HTTP ${response.status}`}`);
    error.status = response.status;
    throw error;
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentSha256: String(response.headers.get("x-agentflow-content-sha256") || "").trim(),
    archiveSha256: String(response.headers.get("x-agentflow-archive-sha256") || "").trim(),
  };
}

function parseNodePackageSpec(raw) {
  const text = String(raw || "").replace(/^marketplace:/, "").trim();
  const at = text.lastIndexOf("@");
  if (at <= 0 || at === text.length - 1) throw new Error("Invalid --node. Expected <id>@<version>.");
  return { id: text.slice(0, at), version: text.slice(at + 1) };
}

function readFlowDependencySource(target) {
  const requested = String(target || "").trim();
  if (!requested) throw new Error("Missing --flow <flowDir|workspace.flow.js>.");
  let resolved = path.resolve(requested);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    resolved = path.join(resolved, "workspace.flow.js");
  }
  if (!/\.m?js$/i.test(resolved)) {
    throw new Error(`Node package sync only supports workspace.flow.js: ${resolved}`);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Cannot read workspace.flow.js: ${resolved}`);
  }
  return { resolved, source: fs.readFileSync(resolved, "utf-8") };
}

async function flowNodePackageDependencies(source) {
  const runtime = await loadAgentFlowRuntime();
  const result = runtime.marketplaceDependenciesFromSource(source);
  if (result.errors.length) throw new Error(result.errors.join("\n"));
  return result.dependencies;
}

async function remoteNodePackageCatalog(args) {
  const result = await httpJson(args, "/api/node-packages");
  const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
  return new Map(nodes.map((node) => [`${node.id}@${node.version}`, node]));
}

function searchNodePackageCatalog(nodes, queryText, limitValue) {
  const needle = String(queryText || "").trim().toLowerCase();
  const requestedLimit = Number.parseInt(String(limitValue || "20"), 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 20;
  const score = (node) => {
    if (!needle) return 1;
    const id = String(node?.id || "").toLowerCase();
    const name = String(node?.displayName || node?.name || "").toLowerCase();
    const description = String(node?.description || "").toLowerCase();
    const slots = JSON.stringify({
      inputs: node?.inputs || node?.input || [],
      outputs: node?.outputs || node?.output || [],
    }).toLowerCase();
    if (id === needle) return 100;
    if (id.startsWith(needle)) return 80;
    if (name === needle) return 70;
    if (name.includes(needle)) return 50;
    if (id.includes(needle)) return 40;
    if (description.includes(needle)) return 20;
    if (slots.includes(needle)) return 10;
    return 0;
  };
  return nodes
    .map((node) => ({ node, score: score(node) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score
      || String(a.node.id).localeCompare(String(b.node.id))
      || String(b.node.version).localeCompare(String(a.node.version)))
    .slice(0, limit)
    .map(({ node }) => ({
      id: node.id,
      version: node.version,
      specifier: `marketplace:${node.id}@${node.version}`,
      displayName: node.displayName || node.name || node.id,
      description: node.description || "",
      baseDefinitionId: node.baseDefinitionId || node.runtime?.type || "tool_nodejs",
      inputs: node.inputs || node.input || [],
      outputs: node.outputs || node.output || [],
      contentSha256: node.contentSha256 || "",
      visibility: node.visibility || "public",
      useCount: Number(node.useCount || 0),
      installCount: Number(node.installCount || 0),
      uniqueUserCount: Number(node.uniqueUserCount || 0),
      lastUsedAt: node.lastUsedAt || "",
      installCommand: `node-package-install --node ${node.id}@${node.version}`,
    }));
}

async function inspectDownloadedNodePackage(args, dependency, remote) {
  const downloaded = await httpBuffer(
    args,
    `/api/node-packages/${encodeURIComponent(dependency.id)}/${encodeURIComponent(dependency.version)}/archive`,
  );
  const runtime = await loadAgentFlowRuntime();
  const inspected = runtime.inspectNodePackageArchive(downloaded.buffer);
  if (!inspected.ok) throw new Error(`${dependency.specifier}: ${inspected.error || "invalid node package archive"}`);
  if (inspected.manifest.id !== dependency.id || inspected.manifest.version !== dependency.version) {
    throw new Error(
      `${dependency.specifier}: 下载内容声明为 ${inspected.manifest.id}@${inspected.manifest.version}，与请求不一致`,
    );
  }
  for (const [label, expected, actual] of [
    ["目录内容", remote?.contentSha256, inspected.contentSha256],
    ["响应内容", downloaded.contentSha256, inspected.contentSha256],
    ["ZIP", downloaded.archiveSha256, inspected.archiveSha256],
  ]) {
    if (expected && expected !== actual) {
      throw new Error(`${dependency.specifier}: ${label} SHA256 校验失败（expected ${expected}, got ${actual}）`);
    }
  }
  return { dependency, remote, downloaded, inspected };
}

async function syncNodePackageDependencies(args, dependencies, workspaceRoot, context = {}) {
  const remoteByKey = await remoteNodePackageCatalog(args);
  const runtime = await loadAgentFlowRuntime();
  const localByKey = new Map(
    runtime.listMarketplacePackages(workspaceRoot).nodes.map((node) => [`${node.id}@${node.version}`, node]),
  );
  const result = {
    ok: true,
    ...context,
    workspaceRoot,
    installed: [],
    unchanged: [],
    missing: [],
    conflicts: [],
  };
  const pending = [];
  for (const dependency of dependencies) {
    const key = `${dependency.id}@${dependency.version}`;
    const remote = remoteByKey.get(key);
    if (!remote) {
      result.missing.push({ ...dependency, error: "远端不存在该精确版本" });
      continue;
    }
    const local = localByKey.get(key);
    if (local) {
      const localInspection = runtime.inspectNodePackageDirectory(local.packageDir, { allowLegacyManifest: true });
      const localSha = localInspection.ok ? localInspection.contentSha256 : String(local.contentSha256 || "");
      if (remote.contentSha256 && localSha && remote.contentSha256 !== localSha) {
        result.conflicts.push({
          ...dependency,
          localContentSha256: localSha,
          remoteContentSha256: remote.contentSha256,
          error: "本地同版本内容与远端不同",
        });
      } else {
        result.unchanged.push({ ...dependency, contentSha256: localSha || remote.contentSha256 || "" });
      }
      continue;
    }
    pending.push({ dependency, remote });
  }
  if (result.missing.length || result.conflicts.length) {
    result.ok = false;
    return result;
  }

  // 所有 ZIP 先下载并校验，再开始落盘；远端有一个坏包时，本地不会只装上一半。
  const prepared = [];
  for (const item of pending) {
    prepared.push(await inspectDownloadedNodePackage(args, item.dependency, item.remote));
  }
  const installedAt = new Date().toISOString();
  for (const item of prepared) {
    const installed = runtime.publishNodePackageArchive(workspaceRoot, item.downloaded.buffer, {
      installedFrom: normalizedBaseUrl(args),
      installedAt,
    });
    if (!installed.ok) throw new Error(`${item.dependency.specifier}: ${installed.error || "install failed"}`);
    result.installed.push({
      ...item.dependency,
      contentSha256: installed.contentSha256,
      archiveSha256: installed.archiveSha256,
      installedFrom: normalizedBaseUrl(args),
    });
  }
  return result;
}

async function syncFlowNodePackages(args, flowTarget, workspaceRoot) {
  const flow = readFlowDependencySource(flowTarget);
  const dependencies = await flowNodePackageDependencies(flow.source);
  return syncNodePackageDependencies(args, dependencies, workspaceRoot, { flow: flow.resolved });
}

async function graphNodePackageDependencies(graph) {
  const runtime = await loadAgentFlowRuntime();
  const bySpecifier = new Map();
  for (const instance of Object.values(graph?.instances || {})) {
    const explicit = String(instance?.marketplaceRef || "").trim();
    const fallback = String(instance?.definitionId || "").trim();
    const specifier = explicit || (fallback.startsWith("marketplace:") ? fallback : "");
    if (!specifier) continue;
    const parsed = runtime.parseMarketplaceDefinitionId(specifier);
    if (!parsed?.id || !parsed.version) {
      throw new Error(`Flow contains an invalid or unpinned node package reference: ${specifier}`);
    }
    bySpecifier.set(specifier, { id: parsed.id, version: parsed.version, specifier, line: 0 });
  }
  return [...bySpecifier.values()].sort((a, b) => a.specifier.localeCompare(b.specifier));
}

function pullFlowOutputDir(args, flowId, workspaceRoot) {
  const explicit = option(args, "output") || option(args, "file");
  if (explicit) return path.resolve(explicit);
  if (!/^[A-Za-z0-9._-]+$/.test(flowId) || flowId === "." || flowId === "..") {
    throw new Error("--flow-id contains characters unsafe for a default local directory; pass --output explicitly.");
  }
  return path.join(workspaceRoot, ".workspace", "agentflow", "pipelines", flowId);
}

async function pullFlow(args) {
  const flowId = requireFlowId(args);
  const flowSource = option(args, "flow-source") || "user";
  const workspaceRoot = path.resolve(option(args, "workspace-root") || process.cwd());
  const outputDir = pullFlowOutputDir(args, flowId, workspaceRoot);
  if (fs.existsSync(outputDir)) {
    if (!fs.statSync(outputDir).isDirectory()) throw new Error(`Pull target is not a directory: ${outputDir}`);
    const entries = fs.readdirSync(outputDir);
    if (entries.length && args.replace !== true) {
      throw new Error(`Pull target is not empty: ${outputDir}. Pass --replace to update its managed flow files.`);
    }
  }
  const current = await httpJson(args, `/api/workspace/graph${query({ flowId, flowSource })}`);
  const graph = current?.graph;
  if (!graph || typeof graph !== "object") throw new Error(`Server returned no workspace graph for ${flowId}.`);
  const dependencies = await graphNodePackageDependencies(graph);
  const nodePackages = await syncNodePackageDependencies(args, dependencies, workspaceRoot, { flowId, flowSource });
  if (!nodePackages.ok) return { ok: false, flowId, flowSource, outputDir, nodePackages };

  const runtime = await loadAgentFlowRuntime();
  const { design } = runtime.splitWorkspaceGraph(graph);
  const written = runtime.writeWorkspaceGraphFiles(outputDir, design, { marketplaceRoot: workspaceRoot });
  return {
    ok: true,
    flowId,
    flowSource,
    draft: current.draft === true,
    outputDir,
    revision: current.revision || "",
    format: written.format,
    path: path.join(outputDir, written.format === "dsl" ? "workspace.flow.js" : "workspace.graph.json"),
    nodePackages,
  };
}

async function preflightRemoteFlowDependencies(args, source) {
  if (!source.isCode) return [];
  const dependencies = await flowNodePackageDependencies(source.flowYaml);
  if (!dependencies.length) return [];
  const remoteByKey = await remoteNodePackageCatalog(args);
  const missing = dependencies.filter((dependency) => !remoteByKey.has(`${dependency.id}@${dependency.version}`));
  if (missing.length) {
    throw new Error(
      `Cannot publish flow: server is missing node packages ${missing.map((dependency) => dependency.specifier).join(", ")}. `
      + "Publish those exact versions first with node-package-publish.",
    );
  }
  return dependencies;
}

function asArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parseInputs(args) {
  const inputs = {};
  for (const item of asArray(args.input)) {
    const text = String(item);
    const index = text.indexOf("=");
    if (index <= 0) {
      throw new Error(`Invalid --input "${text}". Expected key=value.`);
    }
    inputs[text.slice(0, index)] = text.slice(index + 1);
  }
  return inputs;
}

function parseBooleanOption(value, name) {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw new Error(`${name} must be true or false.`);
}

async function runRemoteWorkspace(args, { flowId, flowSource = "user", runNodeId = "" }) {
  const graphPayload = await httpJson(args, `/api/workspace/graph${query({ flowId, flowSource })}`);
  const result = await httpJson(args, "/api/workspace/run", {
    method: "POST",
    body: {
      flowId,
      flowSource,
      runNodeId,
      runAlias: option(args, "run-alias") || "",
      graph: graphPayload.graph,
      inputs: parseInputs(args),
    },
  });
  return {
    ...result,
    displayOutputs: extractDisplayOutputs(result?.graph),
  };
}

async function prepareDraftGraph(args) {
  const requestedFile = option(args, "file");
  const withDependencies = args["with-dependencies"] === true;
  let publishedNodePackages = [];
  let rewrittenImports = [];
  if (withDependencies) {
    const rawSource = readFlowSourceFile(requestedFile, { allowPackageDependencies: true });
    const source = await prepareFlowWithDependencies(args, requestedFile, rawSource);
    publishedNodePackages = source.publishedNodePackages || [];
    rewrittenImports = source.rewrittenImports || [];
  }
  const graph = await readWorkspaceGraphArg(requestedFile, path.resolve(option(args, "workspace-root") || process.cwd()));
  const nodeDependencies = await graphNodePackageDependencies(graph);
  if (nodeDependencies.length) {
    const remoteByKey = await remoteNodePackageCatalog(args);
    const missing = nodeDependencies.filter((item) => !remoteByKey.has(`${item.id}@${item.version}`));
    if (missing.length) {
      throw new Error(`Cannot create draft: server is missing node packages ${missing.map((item) => item.specifier).join(", ")}.`);
    }
  }
  return {
    graph,
    file: path.resolve(String(requestedFile || "")),
    nodeDependencies: nodeDependencies.map((item) => item.specifier),
    publishedNodePackages,
    rewrittenImports,
  };
}

function slotText(slots, names = []) {
  const wanted = new Set(names.map(String));
  for (const slot of Array.isArray(slots) ? slots : []) {
    const name = String(slot?.name || "");
    if (wanted.size && !wanted.has(name)) continue;
    const value = slot?.value ?? slot?.default ?? "";
    if (String(value || "").trim()) return String(value);
  }
  return "";
}

function extractDisplayOutputs(graph) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const outputs = [];
  for (const [nodeId, instance] of Object.entries(instances)) {
    const kind = DISPLAY_DEFINITION_KINDS.get(String(instance?.definitionId || ""));
    if (!kind) continue;
    const primary = kind === "image" ? "src" : "content";
    const content = String(instance?.body || "") ||
      slotText(instance?.input, [primary, "content", "markdown", "html", "src"]) ||
      slotText(instance?.output, [primary, "content", "markdown", "html", "src"]);
    outputs.push({
      nodeId,
      label: String(instance?.label || instance?.displayName || nodeId),
      definitionId: String(instance?.definitionId || ""),
      kind,
      content,
      hasContent: Boolean(String(content || "").trim()),
    });
  }
  return outputs;
}

function printJson(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function authAction(command, args) {
  if (command === "auth") return String(args._[1] || "status").trim().toLowerCase();
  if (command.startsWith("auth-")) return command.slice("auth-".length).toLowerCase();
  return "";
}

async function runAuthCommand(action, args) {
  const baseUrl = normalizedBaseUrl(args);
  if (action === "start" || action === "login") {
    const authorization = await httpJson(args, "/api/auth/cli/device", {
      method: "POST",
      tokenRequired: false,
      body: {
        clientName: option(args, "client-name") || "AgentFlow CLI",
      },
    });
    const saved = saveAgentFlowPendingAuthorization(baseUrl, authorization);
    printJson({
      status: "authorization_required",
      baseUrl,
      requestId: saved.requestId,
      userCode: saved.userCode,
      verificationUrl: saved.verificationUrl,
      expiresAt: saved.expiresAt,
      next: "Open verificationUrl, approve access, then run `auth complete`.",
    });
    return;
  }

  if (action === "complete") {
    const pending = savedAgentFlowPendingAuthorization(baseUrl);
    if (!pending?.deviceCode) {
      throw new Error("No pending AgentFlow authorization. Run `auth start` first.");
    }
    let result;
    try {
      result = await httpJson(args, "/api/auth/cli/token", {
        method: "POST",
        tokenRequired: false,
        body: { deviceCode: pending.deviceCode },
      });
    } catch (error) {
      const code = String(error?.response?.code || "");
      if (["access_denied", "expired_token", "invalid_grant"].includes(code)) {
        clearAgentFlowPendingAuthorization(baseUrl);
      }
      throw error;
    }
    if (result?.code === "authorization_pending") {
      printJson({
        status: "authorization_pending",
        baseUrl,
        requestId: pending.requestId,
        verificationUrl: pending.verificationUrl,
        expiresAt: pending.expiresAt,
      });
      process.exitCode = 2;
      return;
    }
    if (!result?.token) throw new Error("AgentFlow authorization exchange did not return a token.");
    const saved = saveAgentFlowProfile(baseUrl, result);
    printJson({
      status: "authenticated",
      baseUrl,
      user: result.user || null,
      scopes: Array.isArray(result.scopes) ? result.scopes : [],
      expiresAt: result.expiresAt || 0,
      credentialFile: saved.file,
    });
    return;
  }

  if (action === "status") {
    const auth = resolvedAuth(args);
    if (!auth.token) {
      printJson({ authenticated: false, baseUrl, tokenSource: "", credentialFile: agentFlowAuthFile() });
      return;
    }
    const me = await httpJson(args, "/api/auth/me", { tokenRequired: false });
    printJson({
      authenticated: Boolean(me?.authenticated),
      baseUrl,
      tokenSource: auth.source,
      user: me?.user || null,
      expiresAt: auth.profile?.expiresAt || me?.user?.sessionExpiresAt || 0,
      credentialFile: auth.source === "saved-auth" ? agentFlowAuthFile() : "",
    });
    return;
  }

  if (action === "logout") {
    const auth = resolvedAuth(args);
    let revoked = false;
    let remoteError = "";
    if (auth.token) {
      try {
        const response = await httpJson(args, "/api/auth/cli/revoke", { method: "POST", body: {} });
        revoked = Boolean(response?.ok);
      } catch (error) {
        remoteError = error?.message || String(error);
      }
    }
    const localCleared = clearAgentFlowProfile(baseUrl);
    printJson({
      authenticated: false,
      baseUrl,
      revoked,
      localCleared,
      tokenSource: auth.source,
      warning: auth.source && auth.source !== "saved-auth"
        ? `${auth.source} is still configured outside the CLI credential store.`
        : remoteError || "",
    });
    return;
  }

  throw new Error(`Unknown auth command: ${action}. Use auth start, complete, status, or logout.`);
}

function requireFlowId(args) {
  const flowId = option(args, "flow-id") || option(args, "flow");
  if (!flowId) throw new Error("Missing --flow-id.");
  return flowId;
}

function parseWorkflowReference(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const separator = text.indexOf(":");
  if (separator <= 0 || separator === text.length - 1) {
    throw new Error(`Invalid workflow reference "${text}". Expected namespace:id, for example tapd:1015046.`);
  }
  const namespace = text.slice(0, separator).trim().toLowerCase();
  const id = text.slice(separator + 1).trim();
  if (!namespace || !id) {
    throw new Error(`Invalid workflow reference "${text}". Expected namespace:id.`);
  }
  return { namespace, id, key: `${namespace}:${id}` };
}

function workflowReferenceFromArgs(args, required = true) {
  const explicit = option(args, "workflow");
  if (explicit) return parseWorkflowReference(explicit);
  const tapdId = option(args, "tapd-id") || option(args, "tapd");
  if (tapdId) return { namespace: "tapd", id: tapdId, key: `tapd:${tapdId}` };
  if (required) throw new Error("Missing --workflow namespace:id.");
  return null;
}

function readJsonFile(filePath) {
  const requested = String(filePath || "").trim();
  if (!requested) throw new Error("Missing --file <report.json>.");
  const resolved = path.resolve(requested);
  let source;
  try {
    source = fs.readFileSync(resolved, "utf8");
  } catch (error) {
    throw new Error(`Cannot read JSON file ${resolved}: ${error?.message || String(error)}`);
  }
  try {
    const value = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("top-level value must be an object");
    }
    return value;
  } catch (error) {
    throw new Error(`Invalid JSON file ${resolved}: ${error?.message || String(error)}`);
  }
}

// 代码化的流程目录里没有 flow.yaml，权威存储是 workspace.flow.js。两种都要能发布。
const FLOW_MARKERS = ["workspace.flow.js", "workspace.graph.json", "flow.yaml"];

/**
 * 单文件上传只能带一个文件，所以流程目录里如果还有这些东西，它们发不上去。宁可当场报错，
 * 也不要把一个残缺的流程静悄悄发布出去——画布上少了坐标还好说，少了 marketplaceRef 或者
 * nodes/ 里的代码节点包，那流程根本跑不起来。
 */
const UNSHIPPABLE = ["workspace.nodes.json", "nodes"];

function readFlowSourceFile(filePath, { allowPackageDependencies = false } = {}) {
  const requested = String(filePath || "").trim();
  if (!requested) throw new Error(`Missing --file <flowDir|${FLOW_MARKERS.join("|")}>.`);
  let resolved = path.resolve(requested);

  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const dir = resolved;
    const marker = FLOW_MARKERS.find((name) => fs.existsSync(path.join(dir, name)));
    if (!marker) {
      throw new Error(`Not a flow directory (no ${FLOW_MARKERS.join(" / ")}): ${dir}`);
    }
    const extra = allowPackageDependencies ? [] : UNSHIPPABLE.filter((name) => fs.existsSync(path.join(dir, name)));
    if (extra.length) {
      throw new Error(
        `Cannot publish ${dir}: it also contains ${extra.join(", ")}, which a single-file upload cannot carry. `
        + "Publish a flow whose graph is self-contained, or package it by hand for now.",
      );
    }
    resolved = path.join(dir, marker);
  }

  let flowSource;
  try {
    flowSource = fs.readFileSync(resolved, "utf8");
  } catch (error) {
    throw new Error(`Cannot read flow file ${resolved}: ${error?.message || String(error)}`);
  }
  if (!flowSource.trim()) throw new Error(`Flow file is empty: ${resolved}`);
  return {
    resolved,
    flowDir: path.dirname(resolved),
    flowYaml: flowSource,
    isCode: /\.m?js$/i.test(resolved),
  };
}

async function uploadPreparedNodePackage(args, packed) {
  const form = new FormData();
  form.set(
    "file",
    new Blob([packed.archive], { type: "application/zip" }),
    `${packed.manifest.id}-${packed.manifest.version}.zip`,
  );
  return httpMultipart(args, "/api/node-packages", form);
}

function nodePackageDirectories(flowDir) {
  const root = path.join(flowDir, "nodes");
  if (!fs.existsSync(root)) return [];
  if (!fs.statSync(root).isDirectory()) throw new Error(`Flow nodes path is not a directory: ${root}`);
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort();
}

async function prepareFlowWithDependencies(args, filePath, existingSource = null) {
  const source = existingSource || readFlowSourceFile(filePath, { allowPackageDependencies: true });
  if (!source.isCode) {
    throw new Error("--with-dependencies only supports code DSL flows (workspace.flow.js).");
  }
  const runtime = await loadAgentFlowRuntime();
  // 全部本地包先验证并打包；任何一个坏包都不会触发远端写入。
  const packedCandidates = nodePackageDirectories(source.flowDir).map((packageDir) => {
    const item = runtime.createNodePackageArchive(packageDir);
    if (!item.ok) throw new Error(`${packageDir}: ${item.error || "Cannot package node."}`);
    return { ...item, packageDir };
  });

  const packedByKey = new Map();
  for (const item of packedCandidates) {
    const key = `${item.manifest.id}@${item.manifest.version}`;
    const previous = packedByKey.get(key);
    if (previous && previous.contentSha256 !== item.contentSha256) {
      throw new Error(`Flow contains two different local packages with the same version ${key}.`);
    }
    if (!previous) packedByKey.set(key, item);
  }
  const packed = [...packedByKey.values()];

  const available = runtime.scanFlowLocalPackages(source.flowDir);
  const portable = runtime.rewriteFlowLocalPackageImports(source.flowYaml, available);

  // 上传之前先比较所有已存在版本，避免发布一半后才发现后面的同版本冲突。
  const remoteByKey = await remoteNodePackageCatalog(args);
  for (const item of packed) {
    const key = `${item.manifest.id}@${item.manifest.version}`;
    const remote = remoteByKey.get(key);
    if (remote?.contentSha256 && remote.contentSha256 !== item.contentSha256) {
      throw new Error(
        `Cannot publish ${key}: server already has the same version with different content. Bump the node package version.`,
      );
    }
  }

  const packageResults = [];
  for (const item of packed) {
    const uploaded = await uploadPreparedNodePackage(args, item);
    packageResults.push({
      id: item.manifest.id,
      version: item.manifest.version,
      specifier: `marketplace:${item.manifest.id}@${item.manifest.version}`,
      contentSha256: item.contentSha256,
      alreadyExists: Boolean(uploaded?.alreadyExists),
    });
  }

  return {
    ...source,
    flowYaml: portable.source,
    rewrittenImports: portable.rewritten,
    publishedNodePackages: packageResults,
  };
}

function targetDestinationFromArgs(args) {
  const requested = (option(args, "target-space") || option(args, "flow-source") || "personal").toLowerCase();
  if (requested === "personal" || requested === "user") return { flowSource: "user", shareWithTeam: false };
  if (requested === "workspace") return { flowSource: "workspace", shareWithTeam: false };
  if (requested === "team") return { flowSource: "workspace", shareWithTeam: true };
  throw new Error("Invalid --target-space. Use personal|workspace|team (alias: user).");
}

function isMissingPublishedFlowError(error) {
  if (error?.status === 404) return true;
  return error?.status === 400 && /Pipeline directory not found/i.test(String(error?.message || ""));
}

async function importFlow(args, { flowId, targetSpace, scheduleMode = "disabled", resolved, flowYaml }) {
  const form = new FormData();
  form.set("flowId", flowId);
  form.set("targetSpace", targetSpace);
  form.set("scheduleMode", scheduleMode);
  const name = path.basename(resolved);
  const mime = /\.m?js$/i.test(name) ? "application/javascript" : "application/yaml";
  form.set("file", new Blob([flowYaml], { type: mime }), name);
  return httpMultipart(args, "/api/flows/import", form);
}

function normalizeScheduleMode(args, fallback = "disabled") {
  const scheduleMode = String(option(args, "schedule") || fallback).trim().toLowerCase();
  if (!["enabled", "disabled", "preserve"].includes(scheduleMode)) {
    throw new Error("--schedule must be enabled, disabled, or preserve.");
  }
  return scheduleMode;
}

function graphWithScheduleMode(graph, scheduleMode = "disabled") {
  if (scheduleMode === "preserve") return graph;
  const instances = { ...(graph?.instances || {}) };
  let scheduleCount = 0;
  for (const [nodeId, instance] of Object.entries(instances)) {
    if (String(instance?.definitionId || "") !== "workspace_scheduled_run") continue;
    scheduleCount += 1;
    let config = {};
    try {
      const parsed = JSON.parse(String(instance.body || "{}"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed;
    } catch {}
    instances[nodeId] = {
      ...instance,
      body: JSON.stringify({ ...config, enabled: scheduleMode === "enabled" }),
    };
  }
  if (scheduleMode === "enabled" && scheduleCount === 0) {
    throw new Error("Cannot enable scheduling: the Flow has no Scheduled Run node.");
  }
  return { ...graph, instances };
}

async function resolvePublishTeam(args, shareWithTeam) {
  if (!shareWithTeam) return null;
  const result = await httpJson(args, "/api/teams/me");
  if (!result?.team?.id) {
    throw new Error("Cannot publish to team: the current AgentFlow account is not assigned to an active team.");
  }
  return result.team;
}

async function sharePublishedFlowWithTeam(args, { flowId, flowSource, team }) {
  if (!team) return null;
  const result = await httpJson(args, "/api/workspace/collaboration/team-share", {
    method: "POST",
    body: { flowId, flowSource, teamId: team.id, role: "editor" },
  });
  return result?.team || team;
}

async function main() {
  loadEnvFiles();
  const args = parseArgv(process.argv.slice(2));
  configureAgentFlowRuntime({ packageRoot: option(args, "agentflow-package-root") });
  const command = args._[0] || "help";
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }

  const selectedAuthAction = authAction(command, args);
  if (selectedAuthAction) {
    await runAuthCommand(selectedAuthAction, args);
    return;
  }

  if (command === "config") {
    let localRuntime = { available: false, root: "", version: "" };
    try {
      const runtimeRoot = resolveAgentFlowPackageRoot();
      const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf-8"));
      localRuntime = { available: true, root: runtimeRoot, version: String(manifest.version || "") };
    } catch (error) {
      localRuntime.error = error?.message || String(error);
    }
    const auth = resolvedAuth(args);
    printJson({
      baseUrl: normalizedBaseUrl(args),
      hasToken: Boolean(auth.token),
      tokenSource: auth.source,
      credentialFile: auth.source === "saved-auth" ? agentFlowAuthFile() : "",
      localRuntime,
    });
    return;
  }

  if (command === "dsl-lint" || command === "dsl-layout") {
    const target = option(args, "file");
    if (!target) throw new Error(`${command} requires --file <flowDir|workspace.flow.js>.`);
    const resolved = path.resolve(target);
    const stat = fs.statSync(resolved);
    const flowDir = stat.isDirectory() ? resolved : path.dirname(resolved);
    const workspaceRoot = path.resolve(option(args, "workspace-root") || process.cwd());
    const runtime = await loadAgentFlowRuntime();
    if (command === "dsl-lint") {
      const result = runtime.lintWorkspaceFlowDir(flowDir, { workspaceRoot });
      printJson(result);
      if (result.errors.length) process.exitCode = 1;
      return;
    }
    const result = runtime.layoutWorkspaceFlowDir(flowDir, {
      all: args.all === true,
      workspaceRoot,
    });
    printJson(result);
    return;
  }

  if (command === "list-workspace" || command === "list-workspaces") {
    printJson(await httpJson(args, "/api/workspaces"));
    return;
  }

  if (command === "sync-workspace") {
    const id = option(args, "workspace") || option(args, "id");
    if (!id) throw new Error("Missing --workspace.");
    printJson(await httpJson(args, "/api/workspaces/sync", { method: "POST", body: { id } }));
    return;
  }

  if (command === "list-flows" || command === "list-flow") {
    printJson(await httpJson(args, "/api/flows"));
    return;
  }

  if (command === "node-package-list") {
    printJson(await httpJson(args, "/api/node-packages"));
    return;
  }

  if (command === "node-package-search") {
    const queryText = option(args, "query") || option(args, "q");
    if (!queryText) throw new Error("Missing --query <text>.");
    const catalog = await httpJson(args, "/api/node-packages");
    const matches = searchNodePackageCatalog(Array.isArray(catalog?.nodes) ? catalog.nodes : [], queryText, option(args, "limit"));
    printJson({ query: queryText, count: matches.length, nodes: matches });
    return;
  }

  if (command === "node-package-publish") {
    const packageDir = option(args, "file");
    if (!packageDir) throw new Error("Missing --file <nodePackageDir>.");
    const runtime = await loadAgentFlowRuntime();
    const packed = runtime.createNodePackageArchive(packageDir);
    if (!packed.ok) throw new Error(packed.error || "Cannot package node.");
    printJson(await uploadPreparedNodePackage(args, packed));
    return;
  }

  if (command === "node-package-install") {
    const spec = parseNodePackageSpec(option(args, "node"));
    const workspaceRoot = path.resolve(option(args, "workspace-root") || process.cwd());
    const dependency = { ...spec, specifier: `marketplace:${spec.id}@${spec.version}`, line: 0 };
    const remote = (await remoteNodePackageCatalog(args)).get(`${spec.id}@${spec.version}`);
    if (!remote) throw new Error(`Node package not found on server: ${dependency.specifier}`);
    const prepared = await inspectDownloadedNodePackage(args, dependency, remote);
    const runtime = await loadAgentFlowRuntime();
    const installed = runtime.publishNodePackageArchive(workspaceRoot, prepared.downloaded.buffer, {
      installedFrom: normalizedBaseUrl(args),
      installedAt: new Date().toISOString(),
    });
    if (!installed.ok) throw new Error(installed.error || "Cannot install node package.");
    printJson({ ...installed, workspaceRoot });
    return;
  }

  if (command === "node-package-sync") {
    const flowTarget = option(args, "flow") || option(args, "file");
    const workspaceRoot = path.resolve(option(args, "workspace-root") || process.cwd());
    const result = await syncFlowNodePackages(args, flowTarget, workspaceRoot);
    printJson(result);
    if (!result.ok) process.exitCode = 2;
    return;
  }

  if (command === "marketplace-list") {
    const kind = String(option(args, "kind") || "flow").trim().toLowerCase();
    if (kind !== "flow" && kind !== "node") throw new Error("--kind must be flow or node.");
    const result = await httpJson(args, `/api/marketplace/resources${query({
      kind,
      scope: args.owned === true ? "owned" : "",
      q: option(args, "query") || option(args, "q"),
      sort: "useCount",
      order: "desc",
    })}`);
    printJson(result);
    return;
  }

  if (command === "marketplace-flow-publish") {
    const flowId = requireFlowId(args);
    const visibility = String(option(args, "visibility") || "public").trim().toLowerCase();
    if (visibility !== "public" && visibility !== "private") throw new Error("--visibility must be public or private.");
    printJson(await httpJson(args, "/api/marketplace/flows/publish", {
      method: "POST",
      body: {
        flowId,
        flowSource: option(args, "flow-source") || "user",
        id: option(args, "marketplace-id") || flowId,
        displayName: option(args, "display-name") || flowId,
        description: option(args, "description") || "",
        version: option(args, "version") || "1.0.0",
        visibility,
      },
    }));
    return;
  }

  if (command === "marketplace-flow-install") {
    const spec = parseNodePackageSpec(option(args, "flow"));
    printJson(await httpJson(args, "/api/marketplace/flows/install", {
      method: "POST",
      body: { id: spec.id, version: spec.version, flowId: option(args, "flow-id") || spec.id },
    }));
    return;
  }

  if (command === "marketplace-visibility") {
    const kind = String(option(args, "kind") || "").trim().toLowerCase();
    if (kind !== "flow" && kind !== "node") throw new Error("--kind must be flow or node.");
    const spec = parseNodePackageSpec(option(args, "resource"));
    const visibility = String(option(args, "visibility") || "").trim().toLowerCase();
    if (visibility !== "public" && visibility !== "private") throw new Error("--visibility must be public or private.");
    printJson(await httpJson(args, "/api/marketplace/visibility", {
      method: "PATCH",
      body: { kind, id: spec.id, version: spec.version, visibility },
    }));
    return;
  }

  if (command === "pull-flow") {
    const result = await pullFlow(args);
    printJson(result);
    if (!result.ok) process.exitCode = 2;
    return;
  }

  if (command === "draft-pull") {
    const draftId = option(args, "draft-id");
    if (!draftId) throw new Error("draft-pull requires --draft-id <id>.");
    args["flow-id"] = draftId;
    args["flow-source"] = "user";
    const result = await pullFlow(args);
    if (result.ok && result.draft !== true) throw new Error(`${draftId} is not a Workspace Draft.`);
    printJson({ ...result, draftId });
    if (!result.ok) process.exitCode = 2;
    return;
  }

  if (command === "publish-flow") {
    const flowId = requireFlowId(args);
    const destination = targetDestinationFromArgs(args);
    const targetSpace = destination.flowSource;
    const scheduleMode = normalizeScheduleMode(args);
    const withDependencies = args["with-dependencies"] === true;
    const requestedFile = option(args, "file");
    const rawSource = readFlowSourceFile(requestedFile, { allowPackageDependencies: withDependencies });
    const replace = args.replace === true;
    const team = await resolvePublishTeam(args, destination.shareWithTeam);

    // 先读目标是否存在，再上传不可变节点版本。这样 create-only 的 409 不会在服务端留下
    // 一个 Flow 没发布成功、节点包却已经出现的半次发布。
    let current = null;
    try {
      current = rawSource.isCode
        ? await httpJson(args, `/api/workspace/graph${query({ flowId, flowSource: targetSpace })}`)
        : await httpJson(args, `/api/flow${query({ flowId, flowSource: targetSpace })}`);
    } catch (error) {
      if (!isMissingPublishedFlowError(error)) throw error;
    }
    if (current && !replace) {
      throw new Error(`已存在同名流水线 ${flowId}；确认更新后请显式传 --replace。`);
    }

    const source = withDependencies
      ? await prepareFlowWithDependencies(args, requestedFile, rawSource)
      : rawSource;
    const dependencyPreflight = await preflightRemoteFlowDependencies(args, source);

    if (!replace) {
      const result = await importFlow(args, { flowId, targetSpace, scheduleMode, ...source });
      const sharedTeam = await sharePublishedFlowWithTeam(args, { flowId, flowSource: targetSpace, team });
      printJson({ ...result, action: "created", targetSpace: team ? "team" : targetSpace, team: sharedTeam, file: source.resolved, nodeDependencies: dependencyPreflight.map((item) => item.specifier), rewrittenImports: source.rewrittenImports || [], publishedNodePackages: source.publishedNodePackages || [] });
      return;
    }

    // 更新走哪条路取决于存储格式：yaml 流程改 /api/flow，代码化流程改 Workspace 图。
    // /api/flow 只认 flowYaml 字符串，代码化的流程发过去等于把图退回成 yaml。
    if (!current) {
      const result = await importFlow(args, { flowId, targetSpace, scheduleMode, ...source });
      const sharedTeam = await sharePublishedFlowWithTeam(args, { flowId, flowSource: targetSpace, team });
      printJson({ ...result, action: "created", targetSpace: team ? "team" : targetSpace, team: sharedTeam, file: source.resolved, nodeDependencies: dependencyPreflight.map((item) => item.specifier), rewrittenImports: source.rewrittenImports || [], publishedNodePackages: source.publishedNodePackages || [] });
      return;
    }
    if (source.isCode) {
      const graph = graphWithScheduleMode(await readWorkspaceGraphArg(
        option(args, "file"),
        path.resolve(option(args, "workspace-root") || process.cwd()),
      ), scheduleMode);
      const updated = await httpJson(args, "/api/workspace/graph", {
        method: "POST",
        body: { flowId, flowSource: targetSpace, graph, baseRevision: current.revision },
      });
      const sharedTeam = await sharePublishedFlowWithTeam(args, { flowId, flowSource: targetSpace, team });
      printJson({ ...updated, action: "replaced", targetSpace: team ? "team" : targetSpace, team: sharedTeam, file: source.resolved, nodeDependencies: dependencyPreflight.map((item) => item.specifier), rewrittenImports: source.rewrittenImports || [], publishedNodePackages: source.publishedNodePackages || [] });
      return;
    }
    const result = await httpJson(args, "/api/flow", {
      method: "POST",
      body: {
        flowId,
        flowSource: targetSpace,
        flowYaml: source.flowYaml,
        baseRevision: current.revision,
      },
    });
    const sharedTeam = await sharePublishedFlowWithTeam(args, { flowId, flowSource: targetSpace, team });
    printJson({ ...result, flowId, flowSource: targetSpace, action: "updated", targetSpace: team ? "team" : targetSpace, team: sharedTeam, file: source.resolved });
    return;
  }

  if (command === "get-graph") {
    const flowId = requireFlowId(args);
    const flowSource = option(args, "flow-source") || "user";
    printJson(await httpJson(args, `/api/workspace/graph${query({ flowId, flowSource })}`));
    return;
  }

  /**
   * 一键把这个账号能看到的所有流程迁到当前的权威存储格式。
   *
   * 两类活儿，风险完全不同：
   *   graph.json -> 代码   换存储格式，词汇表不变，往返比对闸门保证图等价——无损，随便跑
   *   flow.yaml  -> 代码   要换节点词汇表，可能丢东西——默认拒绝，把清单摆出来给人看
   *
   * 所以默认行为是「无损的全做掉，有损的一个不碰、列出来」。跑完看报告再决定要不要
   * 对那几个加 --allow-loss。重复跑是幂等的：已经是代码形态的流程直接跳过。
   */
  if (command === "migrate-all") {
    const dryRun = args["dry-run"] === true;
    const allowLoss = args["allow-loss"] === true;
    const includeArchived = args["include-archived"] === true;
    const flowsRaw = await httpJson(args, "/api/flows");
    const all = Array.isArray(flowsRaw) ? flowsRaw : flowsRaw.flows || flowsRaw.items || [];
    // builtin 与 admin 是只读目录（服务端 isReadonlyBuiltinFlowSource），写不回去。
    // 它们本来也不依赖 flow.yaml 哨兵，留在原格式没有代价——所以是「跳过」，不是「失败」。
    const readonly = all.filter((f) => f.source === "builtin" || f.source === "admin");
    const skippedArchived = includeArchived ? [] : all.filter((f) => f.archived && !readonly.includes(f));
    const flows = all
      .filter((f) => !readonly.includes(f))
      .filter((f) => includeArchived || !f.archived);

    const rows = [];
    for (const flow of flows) {
      const label = `${flow.id}${flow.archived ? " (归档)" : ""} [${flow.source}]`;
      const body = {
        flowId: flow.id,
        flowSource: flow.source,
        archived: Boolean(flow.archived),
        allowArchived: Boolean(flow.archived),
        allowLoss,
      };
      if (dryRun) {
        // 干跑靠的是服务端「默认拒绝有损」那条闸门本身：不带 allowLoss 发过去，有损的
        // 会原样退回清单且不落盘。无损的会真的迁——所以干跑只对有损那批有意义，
        // 这里改成只读探一次格式，一个字节都不写。
        const graph = await httpJson(args, `/api/workspace/graph${query({
          flowId: flow.id, flowSource: flow.source, archived: flow.archived ? "1" : "",
        })}`).catch((e) => ({ error: String(e.message || e) }));
        const file = String(graph.path || "").split("/").pop() || "";
        const nodes = Object.keys(graph.graph?.instances || {}).length;
        rows.push({
          flow: label,
          store: graph.error ? `读不到: ${graph.error}`
            : nodes > 0 ? (file === "workspace.flow.js" ? "代码（已是最新）" : "graph.json（待迁）")
            : "空图（多半是仅 yaml）",
          nodes,
        });
        continue;
      }
      const r = await httpJson(args, "/api/workspace/migrate", { method: "POST", body })
        .catch((e) => ({ error: String(e.message || e) }));
      const lost = [...(r.dropped || []), ...(r.droppedEdges || [])].filter((x) => !x.benign);
      rows.push({
        flow: label,
        result: r.error ? `失败: ${r.error}`
          : r.migrated ? "→ 代码"
          : r.leftYaml ? "→ graph.json（DSL 装不下部分字段）"
          : r.format === "dsl" ? "已是代码，跳过"
          : r.format === "yaml" ? `拒绝：有损（${lost.length} 处）`
          : `未处理（${r.format}）`,
        remapped: (r.remapped || []).map((x) => `${x.from}->${x.to}`),
        lost: lost.map((x) => x.id || `${x.source}->${x.target}`),
        caveats: (r.remapped || []).filter((x) => x.caveat).map((x) => `${x.id}: ${x.caveat}`),
      });
    }

    const refused = rows.filter((r) => String(r.result || "").startsWith("拒绝"));
    const failed = rows.filter((r) => String(r.result || "").startsWith("失败"));
    printJson({
      total: rows.length,
      dryRun,
      rows,
      // 只读目录和归档要交代清楚跳过了什么，否则「跑完了」会被读成「全覆盖了」
      skipped: {
        readonly: readonly.map((f) => `${f.id} [${f.source}]`),
        archived: skippedArchived.map((f) => `${f.id} [${f.source}]`),
      },
      // 拒绝的单独拎出来：一键跑完之后要人做决定的就这些
      needsDecision: refused.map((r) => r.flow),
      hint: refused.length
        ? "这些流程有节点/边在 Workspace 里没有对等物。看过 lost 清单后，对单个流程跑 migrate-flow --allow-loss。"
        : undefined,
    });
    if (failed.length) process.exitCode = 1;
    return;
  }

  // 平台上还停在 flow.yaml 的老流程：列在列表里、点开是空图、跑不了。这条命令是它们的出口。
  // 默认拒绝有损迁移并把清单打出来，看过之后再加 --allow-loss。
  if (command === "migrate-flow") {
    const flowId = requireFlowId(args);
    const result = await httpJson(args, "/api/workspace/migrate", {
      method: "POST",
      body: {
        flowId,
        flowSource: option(args, "flow-source") || "user",
        archived: args.archived === true,
        allowArchived: args.archived === true,
        allowLoss: args["allow-loss"] === true,
      },
    });
    printJson(result);
    // 只有「因为有损而拒绝」才算失败。已经是代码形态是空操作，不是错。
    if (result.format === "yaml") process.exitCode = 1;
    return;
  }

  if (command === "workspace-preview" || command === "preview-workspace") {
    const graph = await readWorkspaceGraphArg(option(args, "file"));
    const result = await httpJson(args, "/api/workspace/preview", {
      method: "POST",
      body: {
        graph,
        previewId: option(args, "preview-id") || "",
        title: option(args, "title") || "Workspace Preview",
        ttlSeconds: option(args, "ttl-seconds") ? Number(option(args, "ttl-seconds")) : undefined,
      },
    });
    printJson(result);
    return;
  }

  if (command === "draft-create" || command === "draft-update" || command === "workspace-draft") {
    const draftId = option(args, "draft-id") || "";
    if (command === "draft-update" && !draftId) throw new Error("draft-update requires --draft-id <id>.");
    const baseRevision = option(args, "base-revision") || "";
    if (command === "draft-update" && !baseRevision) {
      throw new Error("draft-update requires --base-revision <revision>. Pull the Draft first if the revision is unknown.");
    }
    const prepared = await prepareDraftGraph(args);
    const result = await httpJson(args, "/api/workspace/draft", {
      method: "POST",
      body: {
        graph: prepared.graph,
        draftId,
        baseRevision,
        title: option(args, "title") || "Workspace Draft",
        ttlSeconds: option(args, "ttl-seconds") ? Number(option(args, "ttl-seconds")) : undefined,
        resetRuntime: args["keep-runtime"] !== true,
      },
    });
    printJson({ ...result, ...prepared });
    return;
  }

  if (command === "draft-run") {
    const draftId = option(args, "draft-id");
    if (!draftId) throw new Error("draft-run requires --draft-id <id>.");
    printJson(await runRemoteWorkspace(args, {
      flowId: draftId,
      flowSource: "user",
      runNodeId: option(args, "run-node-id") || "",
    }));
    return;
  }

  if (command === "draft-publish" || command === "draft-promote") {
    const draftId = option(args, "draft-id");
    if (!draftId) throw new Error("draft-publish requires --draft-id <id>.");
    const flowId = requireFlowId(args);
    const destination = targetDestinationFromArgs(args);
    const targetSpace = destination.shareWithTeam ? "team" : destination.flowSource === "user" ? "personal" : "workspace";
    const scheduleMode = normalizeScheduleMode(args);
    const team = await resolvePublishTeam(args, destination.shareWithTeam);
    const result = await httpJson(args, "/api/workspace/draft/publish", {
      method: "POST",
      body: { draftId, flowId, targetSpace, scheduleMode },
    });
    const sharedTeam = await sharePublishedFlowWithTeam(args, {
      flowId,
      flowSource: destination.flowSource,
      team,
    });
    printJson({ ...result, team: sharedTeam, targetSpace });
    return;
  }

  if (command === "run") {
    const flowId = requireFlowId(args);
    const flowSource = option(args, "flow-source") || "user";
    const runNodeId = option(args, "run-node-id") || "";
    printJson(await runRemoteWorkspace(args, { flowId, flowSource, runNodeId }));
    return;
  }

  if (command === "status") {
    const flowId = requireFlowId(args);
    const flowSource = option(args, "flow-source") || "user";
    printJson(await httpJson(args, `/api/workspace/run/status${query({ flowId, flowSource })}`));
    return;
  }

  if (command === "list-run-by-workspace" || command === "list-runs-by-workspace") {
    const workspace = option(args, "workspace") || option(args, "flow-id") || option(args, "flow");
    const flowSource = option(args, "flow-source") || "user";
    const limit = Number(option(args, "limit") || 20);
    printJson(await httpJson(args, `/api/workspace/run-logs${query({ flowId: workspace, flowSource, limit })}`));
    return;
  }

  if (command === "list-runs") {
    const flowId = option(args, "flow-id") || "";
    const flowSource = option(args, "flow-source") || "";
    const scheduleNodeId = option(args, "schedule-node-id") || "";
    const runNodeId = option(args, "run-node-id") || "";
    const limit = Number(option(args, "limit") || 20);
    printJson(await httpJson(args, `/api/workspace/run-logs${query({ flowId, flowSource, scheduleNodeId, runNodeId, limit })}`));
    return;
  }

  if (command === "logs") {
    const runId = option(args, "run-id");
    if (!runId) throw new Error("Missing --run-id.");
    printJson(await httpJson(args, `/api/workspace/run-logs/${encodeURIComponent(runId)}`));
    return;
  }

  if (command === "display-outputs") {
    const flowId = requireFlowId(args);
    const flowSource = option(args, "flow-source") || "user";
    const graphPayload = await httpJson(args, `/api/workspace/graph${query({ flowId, flowSource })}`);
    printJson({ flowId, flowSource, displayOutputs: extractDisplayOutputs(graphPayload.graph) });
    return;
  }

  if (command === "schedule-list") {
    const flowId = option(args, "flow-id") || "";
    const flowSource = option(args, "flow-source") || "user";
    if (flowId) {
      printJson(await httpJson(args, `/api/workspace/schedules${query({ flowId, flowSource })}`));
    } else {
      printJson(await httpJson(args, "/api/schedules"));
    }
    return;
  }

  if (["schedule-set", "schedule-enable", "schedule-disable"].includes(command)) {
    const flowId = requireFlowId(args);
    const flowSource = option(args, "flow-source") || "user";
    const scheduleNodeId = option(args, "schedule-node-id");
    if (!scheduleNodeId) throw new Error(`${command} requires --schedule-node-id <id>.`);
    const body = { flowId, flowSource, scheduleNodeId };
    if (command === "schedule-enable") body.enabled = true;
    if (command === "schedule-disable") body.enabled = false;
    if (command === "schedule-set" && args.enabled !== undefined) {
      body.enabled = parseBooleanOption(args.enabled, "--enabled");
    }
    if (args.cron !== undefined) body.cron = option(args, "cron");
    if (args.timezone !== undefined) body.timezone = option(args, "timezone");
    if (args["overlap-policy"] !== undefined) body.overlapPolicy = option(args, "overlap-policy");
    printJson(await httpJson(args, "/api/workspace/schedule/config", { method: "POST", body }));
    return;
  }

  if (command === "schedule-run-now") {
    const flowId = requireFlowId(args);
    const flowSource = option(args, "flow-source") || "user";
    const scheduleNodeId = option(args, "schedule-node-id");
    if (!scheduleNodeId) throw new Error("schedule-run-now requires --schedule-node-id <id>.");
    printJson(await runRemoteWorkspace(args, { flowId, flowSource, runNodeId: scheduleNodeId }));
    return;
  }

  if (command === "workflow-get") {
    const workflow = workflowReferenceFromArgs(args);
    if (workflow.namespace !== "tapd") {
      throw new Error(`Unsupported workflow namespace: ${workflow.namespace}`);
    }
    const flowId = option(args, "flow-id") || option(args, "flow");
    const flowSource = option(args, "flow-source") || "user";
    const runtimeOnly = args["runtime-only"] === true || args.cached === true ? "1" : "";
    const adminOperation = option(args, "admin-operation") || "";
    const client = createWorkflowReportClient({ baseUrl: normalizedBaseUrl(args), token: authToken(args) });
    printJson(await client.getState({
      workflow: workflow.key,
      flowId,
      flowSource,
      runtimeOnly: runtimeOnly === "1",
      adminOperation,
    }));
    return;
  }

  if (command === "workflow-report") {
    const body = readJsonFile(option(args, "file"));
    const workflow = workflowReferenceFromArgs(args, false) || parseWorkflowReference(
      typeof body?.workflow === "string" ? body.workflow : body?.workflow?.key || "",
    );
    if (!workflow && !(body?.workflow?.namespace && body?.workflow?.id)) {
      throw new Error("Missing workflow reference. Pass --workflow namespace:id or include workflow.namespace and workflow.id in the JSON file.");
    }
    if (workflow) body.workflow = workflow;
    const expectedRevision = option(args, "expected-revision");
    const idempotencyKey = option(args, "idempotency-key");
    const reportSource = option(args, "source");
    const adminOperation = option(args, "admin-operation");
    const flowId = option(args, "flow-id") || option(args, "flow");
    const flowSource = option(args, "flow-source");
    if (expectedRevision) body.expectedRevision = expectedRevision;
    if (idempotencyKey) body.idempotencyKey = idempotencyKey;
    if (reportSource) body.source = reportSource;
    if (adminOperation) body.adminOperation = adminOperation;
    if (!String(body.source || "").trim()) throw new Error("Missing Workflow report source. Pass --source <adapter> or include source in the JSON file.");
    if (flowId) body.flowId = flowId;
    if (flowSource) body.flowSource = flowSource;
    const client = createWorkflowReportClient({ baseUrl: normalizedBaseUrl(args), token: authToken(args) });
    printJson(await client.report(body));
    return;
  }

  if (command === "workflow-access-sync") {
    const body = readJsonFile(option(args, "file"));
    const workflow = workflowReferenceFromArgs(args, false) || parseWorkflowReference(
      typeof body?.workflow === "string" ? body.workflow : body?.workflow?.key || "",
    );
    if (!workflow && !(body?.workflow?.namespace && body?.workflow?.id)) {
      throw new Error("Missing workflow reference. Pass --workflow namespace:id or include workflow.namespace and workflow.id in the JSON file.");
    }
    if (workflow) body.workflow = workflow;
    const client = createWorkflowReportClient({ baseUrl: normalizedBaseUrl(args), token: authToken(args) });
    printJson(await client.syncAccess(body));
    return;
  }

  if (command === "workflow-artifact-publish") {
    const body = readJsonFile(option(args, "file"));
    const workflow = workflowReferenceFromArgs(args, false) || parseWorkflowReference(
      typeof body?.workflow === "string" ? body.workflow : body?.workflow?.key || "",
    );
    if (!workflow && !(body?.workflow?.namespace && body?.workflow?.id)) {
      throw new Error("Missing workflow reference. Pass --workflow namespace:id or include workflow.namespace and workflow.id in the JSON file.");
    }
    if (workflow) body.workflow = workflow;
    const expectedRevision = option(args, "expected-revision");
    const idempotencyKey = option(args, "idempotency-key");
    const reportSource = option(args, "source");
    const flowId = option(args, "flow-id") || option(args, "flow");
    const flowSource = option(args, "flow-source");
    if (flowId) body.flowId = flowId;
    if (flowSource) body.flowSource = flowSource;
    if (expectedRevision) body.expectedRevision = expectedRevision;
    if (idempotencyKey) body.idempotencyKey = idempotencyKey;
    if (reportSource) body.source = reportSource;
    if (!String(body.source || "").trim()) throw new Error("Missing Workflow artifact source. Pass --source <adapter> or include source in the JSON file.");
    const client = createWorkflowReportClient({ baseUrl: normalizedBaseUrl(args), token: authToken(args) });
    printJson(await client.publishArtifact(body));
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exit(1);
});
