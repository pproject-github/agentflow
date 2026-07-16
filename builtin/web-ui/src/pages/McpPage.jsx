import { useCallback, useEffect, useMemo, useState } from "react";

function newId() {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function objectToRows(obj, privateKeys = []) {
  const privateSet = new Set((Array.isArray(privateKeys) ? privateKeys : []).map(String));
  return Object.entries(obj && typeof obj === "object" ? obj : {}).map(([key, value]) => ({
    id: newId(),
    key,
    value: String(value ?? ""),
    private: privateSet.has(key),
  }));
}

function rowsToObject(rows) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.key || "").trim();
    if (!key) continue;
    out[key] = String(row?.value ?? "");
  }
  return out;
}

function serverToDraft(server = null) {
  const raw = server?.raw && typeof server.raw === "object" ? server.raw : {};
  const args = Array.isArray(raw.args) ? raw.args : Array.isArray(server?.args) ? server.args : [];
  return {
    originalName: String(server?.name || ""),
    name: String(server?.name || ""),
    type: server?.url || raw.url ? "url" : "command",
    url: String(server?.url || raw.url || ""),
    command: String(server?.command || raw.command || ""),
    argsText: args.map(String).join("\n"),
    description: String(server?.description || raw.description || ""),
    envRows: objectToRows(raw.env || server?.env, server?.privateEnvKeys),
    headerRows: objectToRows(raw.headers || server?.headers, server?.privateHeaderKeys),
    extraJson: JSON.stringify(
      Object.fromEntries(Object.entries(raw).filter(([key]) => !["url", "command", "args", "env", "headers", "description", "__agentflowPrivateKeys"].includes(key))),
      null,
      2,
    ),
  };
}

function emptyDraft() {
  return serverToDraft({ name: "", raw: { command: "" } });
}

function draftToPayload(draft) {
  const extra = draft.extraJson.trim() ? JSON.parse(draft.extraJson) : {};
  const server = { ...extra };
  if (draft.type === "url") {
    server.url = draft.url.trim();
  } else {
    server.command = draft.command.trim();
    const args = draft.argsText.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
    if (args.length) server.args = args;
  }
  const env = rowsToObject(draft.envRows);
  const headers = rowsToObject(draft.headerRows);
  if (Object.keys(env).length) server.env = env;
  if (Object.keys(headers).length) server.headers = headers;
  if (draft.description.trim()) server.description = draft.description.trim();
  return {
    name: draft.originalName,
    nextName: draft.name.trim(),
    server,
    privateEnvKeys: draft.envRows.filter((row) => row.private).map((row) => String(row.key || "").trim()).filter(Boolean),
    privateHeaderKeys: draft.headerRows.filter((row) => row.private).map((row) => String(row.key || "").trim()).filter(Boolean),
  };
}

function checkLabel(check) {
  if (!check) return "未检测";
  if (check.ok) return `${check.toolCount || 0} tools enabled`;
  return `Error - ${check.error || "Show Output"}`;
}

function checkClass(check) {
  if (!check) return "unknown";
  return check.ok ? "ok" : "error";
}

function backendClass(status) {
  if (status === "ok") return "ok";
  if (status === "partial") return "partial";
  if (status === "unsupported") return "error";
  return "unknown";
}

function backendLabel(backend, fallback) {
  if (!backend) return fallback;
  return backend.label || fallback;
}

function mcpTokenValue(token) {
  const trimmed = String(token || "").trim();
  return trimmed || "<AGENTFLOW_TOKEN>";
}

function buildAgentflowCursorMcpConfig({ baseUrl = "", token = "" }) {
  return JSON.stringify({
    mcpServers: {
      agentflow: {
        command: "agentflow",
        args: ["mcp"],
        env: {
          AGENTFLOW_BASE_URL: String(baseUrl || "http://127.0.0.1:8875"),
          AGENTFLOW_TOKEN: mcpTokenValue(token),
        },
      },
    },
  }, null, 2);
}

function buildAgentflowCodexMcpConfig({ baseUrl = "", token = "" }) {
  const quotedBaseUrl = JSON.stringify(String(baseUrl || "http://127.0.0.1:8875"));
  const quotedToken = JSON.stringify(mcpTokenValue(token));
  return [
    "[mcp_servers.agentflow]",
    "command = \"agentflow\"",
    "args = [\"mcp\"]",
    "",
    "[mcp_servers.agentflow.env]",
    `AGENTFLOW_BASE_URL = ${quotedBaseUrl}`,
    `AGENTFLOW_TOKEN = ${quotedToken}`,
  ].join("\n");
}

function buildAgentflowMcpPrompt({ baseUrl = "", token = "" }) {
  const url = String(baseUrl || "http://127.0.0.1:8875");
  const cursorConfig = buildAgentflowCursorMcpConfig({ baseUrl: url, token });
  const codexConfig = buildAgentflowCodexMcpConfig({ baseUrl: url, token });
  return [
    "你是一个 AI Coding Agent。请帮我把 AgentFlow 配置成当前开发环境可用的 MCP server。",
    "",
    "这是一项配置任务，不是调用任务：请修改 Cursor 或 Codex 的 MCP 配置文件，让它们能连接本机 AgentFlow。",
    "",
    "AgentFlow MCP server 信息：",
    "- server name: agentflow",
    "- command: agentflow",
    "- args: [\"mcp\"]",
    `- env.AGENTFLOW_BASE_URL: ${url}`,
    `- env.AGENTFLOW_TOKEN: ${mcpTokenValue(token)}`,
    "",
    "Cursor 配置片段（合并到 .cursor/mcp.json 或 ~/.cursor/mcp.json）：",
    "```json",
    cursorConfig,
    "```",
    "",
    "Codex 配置片段（合并到 ~/.codex/config.toml 的 mcp_servers 配置）：",
    "```toml",
    codexConfig,
    "```",
    "",
    "配置要求：",
    "1. 先判断当前仓库主要使用 Cursor、Codex，还是两者都需要配置。",
    "2. 不要覆盖已有 MCP server；只新增或更新名为 `agentflow` 的 server。",
    "3. 保留已有配置文件里的其他字段、注释和 server。",
    "4. 如果配置文件不存在，请创建父目录和配置文件。",
    "5. 不要把 token 打印到最终回复里；如果需要说明，只写 `AGENTFLOW_TOKEN 已写入配置`。",
    "6. 如果 token 仍是 `<AGENTFLOW_TOKEN>` 占位符，请提醒用户需要在配置文件中替换成真实 token，或回到 AgentFlow 的 MCP 页面点击“使用当前登录 Token”后重新复制。",
    "",
    "配置后验证：",
    "- 确认 `agentflow` 命令在 PATH 中可用。",
    "- 通过 MCP 客户端刷新或重启后，确认 `agentflow` server 出现在 MCP server 列表。",
    "- 如果可以做工具探测，只验证 `tools/list` 能看到 `agentflow_list_flows`、`agentflow_run_flow`、`agentflow_get_display_outputs`。",
    "",
    "最终回复只需要说明：配置了哪些文件、是否验证成功、如果失败下一步该检查什么。",
  ].join("\n");
}

function BackendMatrix({ server }) {
  const backends = server?.backends || {};
  const rows = [
    ["Cursor", backends.cursor],
    ["Codex", backends.codex],
  ];
  return (
    <div className="af-mcp-backends">
      {rows.map(([name, backend]) => (
        <div key={name} className={`af-mcp-backend af-mcp-backend--${backendClass(backend?.status)}`}>
          <div className="af-mcp-backend-head">
            <strong>{name}</strong>
            <span>{backendLabel(backend, "Unknown")}</span>
          </div>
          {Array.isArray(backend?.reasons) && backend.reasons.length ? (
            <ul>
              {backend.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          ) : (
            <p>当前配置可直接使用。</p>
          )}
        </div>
      ))}
    </div>
  );
}

function RowEditor({ title, rows, onChange, placeholderKey = "KEY", placeholderValue = "value" }) {
  const patch = (id, field, value) => onChange(rows.map((row) => row.id === id ? { ...row, [field]: value } : row));
  return (
    <div className="af-mcp-field">
      <div className="af-mcp-field-head">
        <span>{title}</span>
        <button type="button" className="af-set-btn-mini" onClick={() => onChange([...rows, { id: newId(), key: "", value: "", private: true }])}>
          添加
        </button>
      </div>
      <div className="af-mcp-kv-list">
        {rows.length === 0 ? <p className="af-set-hint">暂无</p> : null}
        {rows.map((row) => (
          <div key={row.id} className="af-mcp-kv-row">
            <input className="af-set-input af-set-input--mono" value={row.key} placeholder={placeholderKey} onChange={(e) => patch(row.id, "key", e.target.value)} />
            <input className="af-set-input af-set-input--mono" value={row.value} placeholder={placeholderValue} onChange={(e) => patch(row.id, "value", e.target.value)} />
            <label className="af-mcp-private-toggle" title="只保存到当前 AgentFlow 用户的个人配置">
              <input type="checkbox" checked={Boolean(row.private)} onChange={(e) => patch(row.id, "private", e.target.checked)} />
              <span>个人</span>
            </label>
            <button type="button" className="af-set-env-del" onClick={() => onChange(rows.filter((item) => item.id !== row.id))} aria-label="删除">
              <span className="material-symbols-outlined">delete</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function McpPage() {
  const [configPath, setConfigPath] = useState("");
  const [servers, setServers] = useState([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [selectedName, setSelectedName] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState({});
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [agentflowMcpBaseUrl, setAgentflowMcpBaseUrl] = useState(() =>
    typeof window !== "undefined" && window.location?.origin ? window.location.origin : "http://127.0.0.1:8875",
  );
  const [agentflowMcpToken, setAgentflowMcpToken] = useState("");
  const [mcpCopied, setMcpCopied] = useState("");
  const selected = useMemo(() => servers.find((server) => server.name === selectedName) || null, [selectedName, servers]);
  const selectedCheck = selected ? checks[selected.name] || null : null;
  const agentflowCursorMcpConfig = useMemo(() => buildAgentflowCursorMcpConfig({
    baseUrl: agentflowMcpBaseUrl,
    token: agentflowMcpToken,
  }), [agentflowMcpBaseUrl, agentflowMcpToken]);
  const agentflowCodexMcpConfig = useMemo(() => buildAgentflowCodexMcpConfig({
    baseUrl: agentflowMcpBaseUrl,
    token: agentflowMcpToken,
  }), [agentflowMcpBaseUrl, agentflowMcpToken]);
  const mcpPrompt = useMemo(() => buildAgentflowMcpPrompt({
    baseUrl: agentflowMcpBaseUrl,
    token: agentflowMcpToken,
  }), [agentflowMcpBaseUrl, agentflowMcpToken]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/mcps");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "MCP HTTP " + r.status);
      const list = Array.isArray(j.servers) ? j.servers : [];
      setConfigPath(String(j.path || ""));
      setServers(list);
      if (selectedName && list.some((server) => server.name === selectedName)) {
        setDraft(serverToDraft(list.find((server) => server.name === selectedName)));
      }
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, [selectedName]);

  useEffect(() => {
    void load();
  }, [load]);

  const startCreate = () => {
    setSelectedName("");
    setDraft(emptyDraft());
    setStatus("");
    setError("");
  };

  const startEdit = (server) => {
    setSelectedName(server.name);
    setDraft(serverToDraft(server));
    setStatus("");
    setError("");
  };

  const copyMcpPrompt = useCallback(() => {
    if (!mcpPrompt) return;
    void navigator.clipboard?.writeText(mcpPrompt);
    setMcpCopied("prompt");
    window.setTimeout(() => setMcpCopied(""), 1200);
  }, [mcpPrompt]);

  const copyCursorMcpConfig = useCallback(() => {
    void navigator.clipboard?.writeText(agentflowCursorMcpConfig);
    setMcpCopied("cursor");
    window.setTimeout(() => setMcpCopied(""), 1200);
  }, [agentflowCursorMcpConfig]);

  const copyCodexMcpConfig = useCallback(() => {
    void navigator.clipboard?.writeText(agentflowCodexMcpConfig);
    setMcpCopied("codex");
    window.setTimeout(() => setMcpCopied(""), 1200);
  }, [agentflowCodexMcpConfig]);

  const fillCurrentSessionToken = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/session-token");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      setAgentflowMcpToken(String(j.token || ""));
      setMcpCopied("token");
      window.setTimeout(() => setMcpCopied(""), 1200);
    } catch (e) {
      setMcpCopied("");
      setError(String(e.message || e));
    }
  }, []);

  const checkServers = async (name = "") => {
    setChecking(true);
    setError("");
    setStatus("");
    try {
      const r = await fetch("/api/mcps/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(name ? { name } : {}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "检测 MCP 失败");
      const results = Array.isArray(j.results) ? j.results : [];
      setChecks((prev) => {
        const next = { ...prev };
        for (const result of results) {
          if (result?.name) next[result.name] = result;
        }
        return next;
      });
      setStatus(name ? `已检测 ${name}。` : "已检测所有 MCP。");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const payload = draftToPayload(draft);
      if (!payload.nextName) throw new Error("请填写 MCP 名称");
      const r = await fetch("/api/mcps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "保存 MCP 失败");
      const list = Array.isArray(j.servers) ? j.servers : [];
      setServers(list);
      setConfigPath(String(j.path || configPath));
      setSelectedName(payload.nextName);
      setDraft(serverToDraft(list.find((server) => server.name === payload.nextName) || null));
      setChecks((prev) => {
        const next = { ...prev };
        if (draft.originalName && draft.originalName !== payload.nextName) delete next[draft.originalName];
        delete next[payload.nextName];
        return next;
      });
      setStatus("已保存。Cursor CLI 下次启动时会读取新配置。");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (server) => {
    if (!server?.name) return;
    if (!window.confirm(`删除 MCP "${server.name}"？`)) return;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const r = await fetch("/api/mcps/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: server.name }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "删除 MCP 失败");
      setServers(Array.isArray(j.servers) ? j.servers : []);
      setSelectedName("");
      setDraft(emptyDraft());
      setChecks((prev) => {
        const next = { ...prev };
        delete next[server.name];
        return next;
      });
      setStatus("已删除。");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="af-settings-page">
      <header className="af-settings-top">
        <div className="af-settings-crumb">
          <span className="af-settings-crumb-muted">AgentFlow</span>
          <span className="af-settings-crumb-sep">/</span>
          <span className="af-settings-crumb-active">MCP</span>
        </div>
        <div className="af-settings-top-right">
          <button type="button" className="af-set-btn-mini" onClick={load} disabled={loading || saving}>刷新</button>
          <button type="button" className="af-set-btn-mini" onClick={() => checkServers()} disabled={checking || loading || saving || servers.length === 0}>
            {checking ? "检测中..." : "检测状态"}
          </button>
          <button type="button" className="af-set-btn-mini" onClick={startCreate} disabled={saving}>新增 MCP</button>
        </div>
      </header>
      <div className="af-settings-body">
        <div className="af-settings-inner">
          <section className="af-settings-hero">
            <h1 className="af-settings-h1">MCP 管理</h1>
            <p className="af-settings-lead">管理 AgentFlow 暴露给外部 Agent 的 MCP 接入方式，以及 AgentFlow 自身可调用的外部 MCP server。</p>
          </section>

          <section className="af-set-card af-set-card--wide af-set-card--low af-set-mcp-personal">
            <div className="af-set-env-head">
              <div className="af-set-card-head">
                <div className="af-set-env-icon-wrap">
                  <span className="material-symbols-outlined af-set-icon--primary">lan</span>
                </div>
                <div>
                  <h2 className="af-set-h2">我的 MCP</h2>
                  <p className="af-set-card-subtitle">给 Cursor、Codex 等外部 Agent 配置 AgentFlow MCP，用来运行流程并读取 display 结果。</p>
                </div>
              </div>
              <span className="af-set-badge af-set-badge--ok">AgentFlow as MCP</span>
            </div>

            <p className="af-set-hint">
              这里生成的是让其他 Agent 连接本平台的配置；下方“外部 MCP Servers”管理的是 AgentFlow 运行时可调用的外部工具。
            </p>

            <div className="af-set-mcp-connect-grid">
              <label className="af-set-mcp-field">
                <span>Base URL</span>
                <input
                  className="af-set-input af-set-input--mono"
                  value={agentflowMcpBaseUrl}
                  onChange={(e) => setAgentflowMcpBaseUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8875"
                />
              </label>
              <label className="af-set-mcp-field">
                <span>Token</span>
                <div className="af-set-mcp-token-row">
                  <input
                    className="af-set-input af-set-input--mono"
                    type="password"
                    value={agentflowMcpToken}
                    onChange={(e) => setAgentflowMcpToken(e.target.value)}
                    placeholder="<AGENTFLOW_TOKEN>"
                  />
                  <button type="button" className="af-set-btn-outline af-set-btn-outline--compact" onClick={fillCurrentSessionToken}>
                    {mcpCopied === "token" ? "已填入" : "使用当前登录 Token"}
                  </button>
                </div>
              </label>
            </div>

            <div className="af-set-mcp-snippet-grid">
              <div>
                <div className="af-set-mcp-snippet-head">
                  <span>Cursor mcp.json</span>
                  <button type="button" className="af-set-btn-outline af-set-btn-outline--compact" onClick={copyCursorMcpConfig}>
                    {mcpCopied === "cursor" ? "已复制" : "复制"}
                  </button>
                </div>
                <pre className="af-set-mcp-code">{agentflowCursorMcpConfig}</pre>
              </div>
              <div>
                <div className="af-set-mcp-snippet-head">
                  <span>Codex config.toml</span>
                  <button type="button" className="af-set-btn-outline af-set-btn-outline--compact" onClick={copyCodexMcpConfig}>
                    {mcpCopied === "codex" ? "已复制" : "复制"}
                  </button>
                </div>
                <pre className="af-set-mcp-code">{agentflowCodexMcpConfig}</pre>
              </div>
            </div>

            <div className="af-set-mcp-copy-row">
              <button type="button" className="af-set-footer-primary" onClick={copyMcpPrompt}>
                <span className="material-symbols-outlined" aria-hidden>content_copy</span>
                {mcpCopied === "prompt" ? "已复制 Prompt" : "复制 AI 配置 Prompt"}
              </button>
            </div>

            <label className="af-set-label-sm" htmlFor="af-mcp-ai-prompt">
              AI 配置 Prompt
            </label>
            <textarea
              id="af-mcp-ai-prompt"
              className="af-set-input af-set-input--mono af-set-mcp-prompt"
              rows={12}
              readOnly
              value={mcpPrompt}
            />
          </section>

          <section className="af-settings-hero af-settings-hero--compact">
            <h2 className="af-settings-h2">外部 MCP Servers</h2>
            <p className="af-settings-lead">新增、编辑和删除 AgentFlow 可调用的外部 MCP server。当前配置文件：<span className="af-settings-code">{configPath || "~/.cursor/mcp.json"}</span></p>
          </section>

          <div className="af-mcp-layout">
            <section className="af-set-card af-mcp-list-card">
              <div className="af-set-card-head af-set-card-head--spread">
                <h2 className="af-set-h2">Servers</h2>
                <div className="af-mcp-list-head-actions">
                  <span className="af-set-badge af-set-badge--muted">{servers.length}</span>
                  <button type="button" className="af-set-btn-mini" onClick={startCreate} disabled={saving}>
                    <span className="material-symbols-outlined">add</span>
                    新增
                  </button>
                </div>
              </div>
              {loading ? <p className="af-set-p">加载中...</p> : null}
              {servers.length === 0 && !loading ? (
                <div className="af-mcp-empty">
                  <p className="af-set-p">暂无 MCP server。</p>
                  <button type="button" className="af-set-footer-primary" onClick={startCreate} disabled={saving}>
                    新增 MCP Server
                  </button>
                </div>
              ) : null}
              <div className="af-mcp-server-list">
                {servers.map((server) => (
                  <button
                    key={server.name}
                    type="button"
                    className={"af-mcp-server-item" + (selectedName === server.name ? " af-mcp-server-item--active" : "")}
                    onClick={() => startEdit(server)}
                  >
                    <span className="material-symbols-outlined">{server.type === "url" ? "cloud" : "terminal"}</span>
                    <span>
                      <span className="af-mcp-server-title">
                        <strong>{server.name}</strong>
                        <small className={`af-mcp-server-health af-mcp-server-health--${checkClass(checks[server.name])}`}>
                          {checkLabel(checks[server.name])}
                        </small>
                      </span>
                      <span className="af-mcp-server-backends">
                        <small className={`af-mcp-backend-pill af-mcp-backend-pill--${backendClass(server.backends?.cursor?.status)}`}>
                          Cursor
                        </small>
                        <small className={`af-mcp-backend-pill af-mcp-backend-pill--${backendClass(server.backends?.codex?.status)}`}>
                          Codex
                        </small>
                      </span>
                      <em>{server.url || [server.command, ...(server.args || [])].filter(Boolean).join(" ")}</em>
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section className="af-set-card af-mcp-editor-card">
              <div className="af-set-card-head af-set-card-head--spread">
                <div>
                  <h2 className="af-set-h2">{selected ? "编辑 MCP" : "新增 MCP"}</h2>
                  <p className="af-set-p af-set-p--tight">保存后会写入 Cursor MCP 配置。已运行的 agent 进程不会热更新，下一次启动会读取新配置。</p>
                </div>
                {selected ? (
                  <div className="af-mcp-editor-actions">
                    <button type="button" className="af-set-btn-mini" onClick={() => checkServers(selected.name)} disabled={checking || saving}>
                      {checking ? "检测中..." : "检测"}
                    </button>
                    <button type="button" className="af-set-btn-mini af-set-btn-mini--danger" onClick={() => remove(selected)} disabled={saving}>
                      删除
                    </button>
                  </div>
                ) : null}
              </div>
              {error ? <p className="af-mcp-error">{error}</p> : null}
              {status ? <p className="af-mcp-status">{status}</p> : null}
              {selected ? <BackendMatrix server={selected} /> : null}
              {selectedCheck ? (
                <div className={`af-mcp-check af-mcp-check--${checkClass(selectedCheck)}`}>
                  <div className="af-mcp-check-head">
                    <strong>{checkLabel(selectedCheck)}</strong>
                    <span>{selectedCheck.elapsedMs || 0}ms</span>
                  </div>
                  {selectedCheck.error ? <p>{selectedCheck.error}</p> : null}
                  {selectedCheck.tools?.length ? (
                    <div className="af-mcp-tools-list">
                      {selectedCheck.tools.map((tool) => (
                        <div key={tool.name} className="af-mcp-tool-row">
                          <strong>{tool.name}</strong>
                          {tool.description ? <span>{tool.description}</span> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="af-mcp-form">
                <label className="af-set-label">
                  MCP 名称
                  <input className="af-set-input af-set-input--mono" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="github" />
                </label>

                <label className="af-set-label">
                  类型
                  <select className="af-set-input" value={draft.type} onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}>
                    <option value="url">URL / HTTP</option>
                    <option value="command">Command / stdio</option>
                  </select>
                </label>

                {draft.type === "url" ? (
                  <label className="af-set-label af-mcp-field--wide">
                    URL
                    <input className="af-set-input af-set-input--mono" value={draft.url} onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))} placeholder="http://127.0.0.1:3845/mcp" />
                  </label>
                ) : (
                  <>
                    <label className="af-set-label">
                      Command
                      <input className="af-set-input af-set-input--mono" value={draft.command} onChange={(e) => setDraft((d) => ({ ...d, command: e.target.value }))} placeholder="uvx" />
                    </label>
                    <label className="af-set-label">
                      Args，每行一个
                      <textarea className="af-set-input af-mcp-textarea af-set-input--mono" rows={4} value={draft.argsText} onChange={(e) => setDraft((d) => ({ ...d, argsText: e.target.value }))} placeholder={"mcp-server-example\n--flag"} />
                    </label>
                  </>
                )}

                <label className="af-set-label af-mcp-field--wide">
                  描述
                  <input className="af-set-input" value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} placeholder="这个 MCP 提供什么能力" />
                </label>

                <RowEditor title="Headers" rows={draft.headerRows} onChange={(rows) => setDraft((d) => ({ ...d, headerRows: rows }))} placeholderKey="Authorization" placeholderValue="Bearer ..." />
                <RowEditor title="Env" rows={draft.envRows} onChange={(rows) => setDraft((d) => ({ ...d, envRows: rows }))} placeholderKey="TOKEN" placeholderValue="..." />

                <label className="af-set-label af-mcp-field--wide">
                  额外 JSON 字段
                  <textarea className="af-set-input af-mcp-textarea af-set-input--mono" rows={5} value={draft.extraJson} onChange={(e) => setDraft((d) => ({ ...d, extraJson: e.target.value }))} />
                </label>
              </div>

              <div className="af-mcp-actions">
                <button type="button" className="af-set-btn-outline" onClick={startCreate} disabled={saving}>清空</button>
                <button type="button" className="af-set-footer-primary" onClick={save} disabled={saving}>{saving ? "保存中..." : "保存 MCP"}</button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
