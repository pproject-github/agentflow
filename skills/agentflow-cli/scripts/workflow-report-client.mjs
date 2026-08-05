function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function workflowQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function createWorkflowReportClient({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
  const origin = cleanBaseUrl(baseUrl);
  const credential = String(token || "").trim();
  if (!origin) throw new Error("Workflow Report client requires baseUrl");
  if (!credential) throw new Error("Workflow Report client requires token");
  if (typeof fetchImpl !== "function") throw new Error("Workflow Report client requires fetch");

  const request = async (pathname, { method = "GET", body } = {}) => {
    const url = new URL(pathname, `${origin}/`);
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${credential}`,
      Cookie: `af_session=${encodeURIComponent(credential)}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(url, {
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
      error.data = data;
      throw error;
    }
    return data;
  };

  return {
    getState({ workflow, flowId = "", flowSource = "user", runtimeOnly = false } = {}) {
      return request(`/api/workflows/state${workflowQuery({
        workflow,
        flowId,
        flowSource,
        runtimeOnly: runtimeOnly ? "1" : "",
      })}`);
    },
    syncAccess(body = {}) {
      return request("/api/workflows/access/sync", { method: "POST", body });
    },
    report(body = {}) {
      return request("/api/workflows/report", { method: "POST", body });
    },
    publishArtifact(body = {}) {
      return request("/api/workflow-artifacts/publish", { method: "POST", body });
    },
  };
}
