#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
async function readWorkspaceGraphArg(target) {
  const file = String(target || "");
  if (!file) throw new Error("--file is required");
  const stat = fs.statSync(file);
  const dir = stat.isDirectory() ? file : path.dirname(file);
  if (!stat.isDirectory() && file.endsWith(".json")) return readJsonFile(file);
  const store = await import(new URL("../../../bin/lib/workspace-flow-store.mjs", import.meta.url));
  const state = await import(new URL("../../../bin/lib/workspace-state.mjs", import.meta.url));
  const design = store.readWorkspaceDesign(dir);
  if (design.format === "empty") throw new Error(`No workspace graph in ${dir}`);
  const statePath = path.join(dir, state.WORKSPACE_STATE_FILENAME);
  const runtime = fs.existsSync(statePath) ? readJsonFile(statePath) : null;
  return state.mergeWorkspaceState(design.graph, runtime);
}

function usage() {
  return `AgentFlow direct API CLI

Usage:
  agentflow-cli <command> [options]

Config:
  --base-url <url>       Override AGENTFLOW_BASE_URL
  --token <token>        Override AGENTFLOW_TOKEN
  AGENTFLOW_BASE_URL     Defaults to ${DEFAULT_BASE_URL}
  AGENTFLOW_TOKEN        Required unless AGENTFLOW_SESSION_TOKEN is set
  AGENTFLOW_ENV_FILE     Optional dotenv file path

Commands:
  config
  list-workspace | list-workspaces
  list-flows
  publish-flow --flow-id <id> --file <flowDir|workspace.flow.js|flow.yaml> [--target-space personal|workspace|team] [--replace]
  get-graph --flow-id <id> [--flow-source user]
  workspace-preview --file <flowDir|workspace.flow.js|workspace.graph.json> [--preview-id <id>] [--ttl-seconds <n>]
  run --flow-id <id> [--flow-source user] [--run-node-id <id>] [--input k=v]
  status --flow-id <id> [--flow-source user]
  list-run-by-workspace | list-runs-by-workspace --workspace <flowId> [--limit 20]
  list-runs [--flow-id <id>] [--flow-source user] [--limit 20]
  logs --run-id <id>
  display-outputs --flow-id <id> [--flow-source user]
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

function authToken(args, required = true) {
  const token = option(args, "token") || process.env.AGENTFLOW_TOKEN || process.env.AGENTFLOW_SESSION_TOKEN || "";
  const trimmed = String(token).trim();
  if (required && !trimmed) {
    throw new Error("Missing AGENTFLOW_TOKEN. Set it in env, .env, .agentflow.env, or pass --token.");
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

function readFlowSourceFile(filePath) {
  const requested = String(filePath || "").trim();
  if (!requested) throw new Error(`Missing --file <flowDir|${FLOW_MARKERS.join("|")}>.`);
  let resolved = path.resolve(requested);

  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const dir = resolved;
    const marker = FLOW_MARKERS.find((name) => fs.existsSync(path.join(dir, name)));
    if (!marker) {
      throw new Error(`Not a flow directory (no ${FLOW_MARKERS.join(" / ")}): ${dir}`);
    }
    const extra = UNSHIPPABLE.filter((name) => fs.existsSync(path.join(dir, name)));
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
  return { resolved, flowYaml: flowSource, isCode: /\.m?js$/i.test(resolved) };
}

function targetDestinationFromArgs(args) {
  const requested = (option(args, "target-space") || option(args, "flow-source") || "personal").toLowerCase();
  if (requested === "personal" || requested === "user") return { flowSource: "user", shareWithTeam: false };
  if (requested === "workspace") return { flowSource: "workspace", shareWithTeam: false };
  if (requested === "team") return { flowSource: "workspace", shareWithTeam: true };
  throw new Error("Invalid --target-space. Use personal|workspace|team (alias: user).");
}

async function importFlow(args, { flowId, targetSpace, resolved, flowYaml }) {
  const form = new FormData();
  form.set("flowId", flowId);
  form.set("targetSpace", targetSpace);
  const name = path.basename(resolved);
  const mime = /\.m?js$/i.test(name) ? "application/javascript" : "application/yaml";
  form.set("file", new Blob([flowYaml], { type: mime }), name);
  return httpMultipart(args, "/api/flows/import", form);
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
  const command = args._[0] || "help";
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }

  if (command === "config") {
    printJson({
      baseUrl: normalizedBaseUrl(args),
      hasToken: Boolean(authToken(args, false)),
      tokenSource: option(args, "token") ? "flag" : process.env.AGENTFLOW_TOKEN ? "AGENTFLOW_TOKEN" : process.env.AGENTFLOW_SESSION_TOKEN ? "AGENTFLOW_SESSION_TOKEN" : "",
    });
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

  if (command === "publish-flow") {
    const flowId = requireFlowId(args);
    const destination = targetDestinationFromArgs(args);
    const targetSpace = destination.flowSource;
    const source = readFlowSourceFile(option(args, "file"));
    const replace = args.replace === true;
    const team = await resolvePublishTeam(args, destination.shareWithTeam);

    if (!replace) {
      const result = await importFlow(args, { flowId, targetSpace, ...source });
      const sharedTeam = await sharePublishedFlowWithTeam(args, { flowId, flowSource: targetSpace, team });
      printJson({ ...result, action: "created", targetSpace: team ? "team" : targetSpace, team: sharedTeam, file: source.resolved });
      return;
    }

    // 更新走哪条路取决于存储格式：yaml 流程改 /api/flow，代码化流程改 Workspace 图。
    // /api/flow 只认 flowYaml 字符串，代码化的流程发过去等于把图退回成 yaml。
    let current = null;
    try {
      current = source.isCode
        ? await httpJson(args, `/api/workspace/graph${query({ flowId, flowSource: targetSpace })}`)
        : await httpJson(args, `/api/flow${query({ flowId, flowSource: targetSpace })}`);
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
    if (!current) {
      const result = await importFlow(args, { flowId, targetSpace, ...source });
      const sharedTeam = await sharePublishedFlowWithTeam(args, { flowId, flowSource: targetSpace, team });
      printJson({ ...result, action: "created", targetSpace: team ? "team" : targetSpace, team: sharedTeam, file: source.resolved });
      return;
    }
    if (source.isCode) {
      const graph = await readWorkspaceGraphArg(option(args, "file"));
      const updated = await httpJson(args, "/api/workspace/graph", {
        method: "POST",
        body: { flowId, flowSource: targetSpace, graph, baseRevision: current.revision },
      });
      const sharedTeam = await sharePublishedFlowWithTeam(args, { flowId, flowSource: targetSpace, team });
      printJson({ ...updated, action: "replaced", targetSpace: team ? "team" : targetSpace, team: sharedTeam, file: source.resolved });
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

  if (command === "run") {
    const flowId = requireFlowId(args);
    const flowSource = option(args, "flow-source") || "user";
    const runNodeId = option(args, "run-node-id") || "";
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
    printJson({
      ...result,
      displayOutputs: extractDisplayOutputs(result?.graph),
    });
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
