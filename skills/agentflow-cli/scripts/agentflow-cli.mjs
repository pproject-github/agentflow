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
  get-graph --flow-id <id> [--flow-source user]
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
    throw new Error(`${method} ${url.pathname} failed: ${message}`);
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

  if (command === "get-graph") {
    const flowId = requireFlowId(args);
    const flowSource = option(args, "flow-source") || "user";
    printJson(await httpJson(args, `/api/workspace/graph${query({ flowId, flowSource })}`));
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
