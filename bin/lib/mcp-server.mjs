const DEFAULT_BASE_URL = "http://127.0.0.1:8875";

function envBaseUrl() {
  return String(process.env.AGENTFLOW_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function envToken() {
  return String(process.env.AGENTFLOW_TOKEN || process.env.AGENTFLOW_SESSION_TOKEN || "").trim();
}

function toolText(data) {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function toolError(error) {
  return {
    isError: true,
    content: [{ type: "text", text: String(error?.message || error || "Unknown error") }],
  };
}

async function httpJson(pathname, { method = "GET", body } = {}) {
  const baseUrl = envBaseUrl();
  const token = envToken();
  const url = new URL(pathname, baseUrl);
  const headers = {
    Accept: "application/json",
  };
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
    throw new Error(message);
  }
  return data;
}

function query(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

function displayKind(definitionId) {
  const id = String(definitionId || "");
  if (id === "display_markdown") return "markdown";
  if (id === "display_code") return "code";
  if (id === "display_mermaid") return "mermaid";
  if (id === "display_ascii") return "ascii";
  if (id === "display_html") return "html";
  if (id === "display_react_app") return "react";
  if (id === "display_image") return "image";
  if (id === "display_chart") return "chart";
  if (id === "display_table") return "table";
  return "";
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
    const kind = displayKind(instance?.definitionId);
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

const tools = [
  {
    name: "agentflow_list_flows",
    description: "List AgentFlow flows visible to the configured user.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "agentflow_get_workspace_graph",
    description: "Read a flow as a workspace graph before running or inspecting display nodes.",
    inputSchema: {
      type: "object",
      required: ["flowId"],
      properties: {
        flowId: { type: "string" },
        flowSource: { type: "string", default: "user" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentflow_run_flow",
    description: "Run an AgentFlow workspace flow and return the merged graph plus display outputs.",
    inputSchema: {
      type: "object",
      required: ["flowId"],
      properties: {
        flowId: { type: "string" },
        flowSource: { type: "string", default: "user" },
        runNodeId: { type: "string", description: "Optional run/schedule node id. Empty runs from the graph start." },
        inputs: { type: "object", description: "Optional flow input values." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentflow_get_run_status",
    description: "Get active workspace run status for a flow.",
    inputSchema: {
      type: "object",
      required: ["flowId"],
      properties: {
        flowId: { type: "string" },
        flowSource: { type: "string", default: "user" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentflow_get_run_logs",
    description: "Read workspace run logs. Provide runId for a specific run, or flowId to list recent runs.",
    inputSchema: {
      type: "object",
      properties: {
        flowId: { type: "string" },
        flowSource: { type: "string" },
        runId: { type: "string" },
        limit: { type: "number", default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentflow_get_display_outputs",
    description: "Extract display node outputs from a workspace graph.",
    inputSchema: {
      type: "object",
      required: ["flowId"],
      properties: {
        flowId: { type: "string" },
        flowSource: { type: "string", default: "user" },
      },
      additionalProperties: false,
    },
  },
];

async function callTool(name, args = {}) {
  if (name === "agentflow_list_flows") {
    return toolText(await httpJson("/api/flows"));
  }
  if (name === "agentflow_get_workspace_graph") {
    const flowSource = args.flowSource || "user";
    return toolText(await httpJson(`/api/workspace/graph${query({ flowId: args.flowId, flowSource })}`));
  }
  if (name === "agentflow_run_flow") {
    const flowSource = args.flowSource || "user";
    const graphPayload = await httpJson(`/api/workspace/graph${query({ flowId: args.flowId, flowSource })}`);
    const runPayload = {
      flowId: args.flowId,
      flowSource,
      runNodeId: args.runNodeId || "",
      graph: graphPayload.graph,
      inputs: args.inputs && typeof args.inputs === "object" ? args.inputs : {},
    };
    const result = await httpJson("/api/workspace/run", { method: "POST", body: runPayload });
    return toolText({
      ok: result?.ok === true,
      flowId: args.flowId,
      flowSource,
      runNodeId: args.runNodeId || "",
      order: result?.order || [],
      pauseNodeIds: result?.pauseNodeIds || [],
      touchedNodeIds: result?.touchedNodeIds || [],
      displayOutputs: extractDisplayOutputs(result?.graph),
      graph: result?.graph || null,
    });
  }
  if (name === "agentflow_get_run_status") {
    return toolText(await httpJson(`/api/workspace/run/status${query({ flowId: args.flowId, flowSource: args.flowSource || "user" })}`));
  }
  if (name === "agentflow_get_run_logs") {
    if (args.runId) {
      return toolText(await httpJson(`/api/workspace/run-logs/${encodeURIComponent(String(args.runId))}`));
    }
    return toolText(await httpJson(`/api/workspace/run-logs${query({
      flowId: args.flowId || "",
      flowSource: args.flowSource || "",
      limit: args.limit || 20,
    })}`));
  }
  if (name === "agentflow_get_display_outputs") {
    const flowSource = args.flowSource || "user";
    const graphPayload = await httpJson(`/api/workspace/graph${query({ flowId: args.flowId, flowSource })}`);
    return toolText({
      flowId: args.flowId,
      flowSource,
      displayOutputs: extractDisplayOutputs(graphPayload.graph),
    });
  }
  return toolError(`Unknown tool: ${name}`);
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, error) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: String(error?.message || error || "Unknown error"),
    },
  };
}

function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  const id = message.id;
  const method = String(message.method || "");
  try {
    if (method === "initialize") {
      writeMessage(response(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agentflow", version: "0.1.0" },
      }));
      return;
    }
    if (method === "notifications/initialized") return;
    if (method === "tools/list") {
      writeMessage(response(id, { tools }));
      return;
    }
    if (method === "tools/call") {
      const params = message.params || {};
      const result = await callTool(String(params.name || ""), params.arguments || {});
      writeMessage(response(id, result));
      return;
    }
    if (id !== undefined) writeMessage(errorResponse(id, `Unknown method: ${method}`));
  } catch (e) {
    if (id !== undefined) writeMessage(errorResponse(id, e));
  }
}

function feedLine(line) {
  const text = String(line || "").trim();
  if (!text) return;
  try {
    void handleMessage(JSON.parse(text));
  } catch (e) {
    writeMessage(errorResponse(null, e));
  }
}

export async function startMcpServer() {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      feedLine(line);
      idx = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => {
    if (buffer.trim()) feedLine(buffer);
  });
  await new Promise(() => {});
}
