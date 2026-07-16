import { useCallback, useEffect, useMemo, useState } from "react";

function newId() {
  return `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function isValidEnvKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key || "").trim());
}

function suggestCredentialRef(draft = {}, payload = {}) {
  const seed = String(draft.mountPath || payload.mountPath || draft.label || payload.label || draft.id || payload.id || "workspace")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return `${seed || "WORKSPACE"}_GIT_TOKEN`;
}

function emptyDraft() {
  return {
    id: "",
    label: "",
    kind: "git",
    path: "",
    repoUrl: "",
    branch: "master",
    mountPath: "",
    credentialRef: "",
    type: "code",
    description: "",
    enabled: true,
  };
}

function toDraft(item = {}) {
  return {
    id: String(item?.id || ""),
    label: String(item?.label || item?.name || ""),
    kind: item?.kind === "local" ? "local" : "git",
    path: String(item?.path || ""),
    repoUrl: String(item?.repoUrl || ""),
    branch: String(item?.branch || "master"),
    mountPath: String(item?.mountPath || ""),
    credentialRef: String(item?.credentialRef || ""),
    type: String(item?.type || (item?.kind === "local" ? "local" : "code")),
    description: String(item?.description || ""),
    enabled: item?.enabled !== false,
  };
}

function draftToPayload(draft) {
  const kind = draft.kind === "local" ? "local" : "git";
  return {
    id: String(draft.id || "").trim(),
    label: String(draft.label || "").trim(),
    kind,
    path: String(draft.path || "").trim(),
    repoUrl: kind === "git" ? String(draft.repoUrl || "").trim() : "",
    branch: kind === "git" ? String(draft.branch || "master").trim() || "master" : "",
    mountPath: kind === "git" ? String(draft.mountPath || "").trim() : "",
    credentialRef: kind === "git" ? String(draft.credentialRef || "").trim() : "",
    type: String(draft.type || (kind === "local" ? "local" : "code")).trim(),
    description: String(draft.description || "").trim(),
    enabled: draft.enabled !== false,
  };
}

function workspaceKey(item, index = 0) {
  return item?.id || item?.path || item?.repoUrl || `workspace-${index}`;
}

function StatusDot({ ok }) {
  return <span className={"af-workspaces-dot" + (ok ? " af-workspaces-dot--ok" : "")} aria-hidden />;
}

function WorkspaceCard({ item, selected, onClick, readOnly }) {
  return (
    <button
      type="button"
      className={"af-workspaces-card" + (selected ? " af-workspaces-card--selected" : "")}
      onClick={onClick}
    >
      <div className="af-workspaces-card__head">
        <strong>{item.label || "Workspace"}</strong>
        <span>{item.kind === "git" ? "Git" : "Local"}</span>
      </div>
      <p>{item.description || item.repoUrl || item.path || "-"}</p>
      <div className="af-workspaces-card__meta">
        <StatusDot ok={item.exists !== false} />
        <span>{item.exists === false ? "路径未就绪" : "路径可用"}</span>
        {readOnly ? <em>内置</em> : item.enabled === false ? <em>disabled</em> : null}
      </div>
    </button>
  );
}

export default function WorkspacesPage() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [builtins, setBuiltins] = useState([]);
  const [custom, setCustom] = useState([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [tokenDraft, setTokenDraft] = useState("");
  const [envRows, setEnvRows] = useState([]);
  const [selectedKey, setSelectedKey] = useState("");

  const selectedCustomIndex = useMemo(() => custom.findIndex((item, index) => workspaceKey(item, index) === selectedKey), [custom, selectedKey]);
  const selectedBuiltin = useMemo(() => builtins.find((item, index) => workspaceKey(item, index) === selectedKey) || null, [builtins, selectedKey]);
  const editingReadonly = Boolean(selectedBuiltin);
  const credentialEnvExists = useMemo(() => {
    const key = String(draft.credentialRef || "").trim();
    if (!key) return false;
    return envRows.some((row) => String(row?.key || "").trim() === key && String(row?.value ?? "") !== "");
  }, [draft.credentialRef, envRows]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [workspaceResp, envResp] = await Promise.all([
        fetch("/api/workspaces"),
        fetch("/api/user-env"),
      ]);
      const j = await workspaceResp.json().catch(() => ({}));
      const env = await envResp.json().catch(() => ({}));
      if (!envResp.ok) throw new Error(typeof env.error === "string" ? env.error : "ENV HTTP " + envResp.status);
      if (!workspaceResp.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + workspaceResp.status);
      const all = Array.isArray(j.workspaces) ? j.workspaces : [];
      const customRows = Array.isArray(j.customWorkspaces) ? j.customWorkspaces : [];
      setConfigPath(String(j.path || ""));
      setBuiltins(all.filter((item) => item?.builtin));
      setCustom(customRows);
      setEnvRows(Array.isArray(env.env) ? env.env.map((row) => ({ key: String(row?.key || ""), value: String(row?.value ?? "") })) : []);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveRows = useCallback(async (rows, nextSelected = "") => {
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const r = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaces: rows }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      const next = Array.isArray(j.customWorkspaces) ? j.customWorkspaces : rows;
      setCustom(next);
      setBuiltins((Array.isArray(j.workspaces) ? j.workspaces : []).filter((item) => item?.builtin));
      setConfigPath(String(j.path || configPath));
      if (nextSelected) setSelectedKey(nextSelected);
      setStatus("已保存");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSaving(false);
    }
  }, [configPath]);

  const startCreate = useCallback(() => {
    setSelectedKey("");
    setDraft(emptyDraft());
    setTokenDraft("");
    setStatus("");
    setError("");
  }, []);

  const selectCustom = useCallback((item, index) => {
    setSelectedKey(workspaceKey(item, index));
    setDraft(toDraft(item));
    setTokenDraft("");
    setStatus("");
  }, []);

  const selectBuiltin = useCallback((item, index) => {
    setSelectedKey(workspaceKey(item, index));
    setDraft(toDraft(item));
    setTokenDraft("");
    setStatus("");
  }, []);

  const saveUserToken = useCallback(async (credentialRef, token) => {
    const key = String(credentialRef || "").trim();
    const value = String(token ?? "");
    if (!key || !value) return;
    const nextRows = envRows.filter((row) => String(row?.key || "").trim() !== key);
    nextRows.push({ key, value });
    const r = await fetch("/api/user-env", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: nextRows }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "ENV HTTP " + r.status);
    setEnvRows(Array.isArray(j.env) ? j.env.map((row) => ({ key: String(row?.key || ""), value: String(row?.value ?? "") })) : nextRows);
  }, [envRows]);

  const saveDraft = useCallback(() => {
    const payload = draftToPayload({ ...draft, id: draft.id || newId() });
    const token = tokenDraft.trim();
    if (payload.kind === "git" && token && !payload.credentialRef) {
      payload.credentialRef = suggestCredentialRef(draft, payload);
    }
    if (payload.kind === "local" && !payload.path) {
      setError("本地工作区需要填写路径");
      return;
    }
    if (payload.kind === "git" && !payload.repoUrl) {
      setError("Git 工作区需要填写 repoUrl");
      return;
    }
    if (!payload.label) {
      setError("请填写名称");
      return;
    }
    if (payload.kind === "git" && payload.credentialRef && !isValidEnvKey(payload.credentialRef)) {
      setError("凭证环境变量只能使用字母、数字和下划线，且不能以数字开头");
      return;
    }
    const next = selectedCustomIndex >= 0
      ? custom.map((item, index) => (index === selectedCustomIndex ? payload : item))
      : [payload, ...custom];
    setDraft(toDraft(payload));
    void (async () => {
      setSaving(true);
      try {
        if (token) await saveUserToken(payload.credentialRef, token);
        setTokenDraft("");
        await saveRows(next, workspaceKey(payload));
      } catch (e) {
        setError(String(e.message || e));
        setSaving(false);
      }
    })();
  }, [custom, draft, saveRows, saveUserToken, selectedCustomIndex, tokenDraft]);

  const deleteDraft = useCallback(() => {
    if (selectedCustomIndex < 0) return;
    const next = custom.filter((_, index) => index !== selectedCustomIndex);
    setDraft(emptyDraft());
    setSelectedKey("");
    void saveRows(next);
  }, [custom, saveRows, selectedCustomIndex]);

  const syncDraft = useCallback(async () => {
    if (editingReadonly) return;
    if (selectedCustomIndex < 0 || !draft.id) {
      setError("请先保存工作区配置，再拉取更新");
      return;
    }
    if (draft.kind !== "git") {
      setError("只有 Git 工作区支持拉取更新");
      return;
    }
    setSyncing(true);
    setError("");
    setStatus("");
    try {
      const r = await fetch("/api/workspaces/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: draft.id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      const nextCustom = Array.isArray(j.customWorkspaces) ? j.customWorkspaces : custom;
      setCustom(nextCustom);
      setBuiltins((Array.isArray(j.workspaces) ? j.workspaces : []).filter((item) => item?.builtin));
      const nextItem = nextCustom.find((item) => String(item?.id || "") === String(draft.id || ""));
      if (nextItem) setDraft(toDraft(nextItem));
      const commit = String(j.commit || "").trim();
      setStatus(j.changed ? `已拉取更新${commit ? `：${commit.slice(0, 8)}` : ""}` : `已是最新${commit ? `：${commit.slice(0, 8)}` : ""}`);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSyncing(false);
    }
  }, [custom, draft, editingReadonly, selectedCustomIndex]);

  const patchDraft = useCallback((patch) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  }, []);

  return (
    <div className="af-workspaces-page">
      <header className="af-settings-top">
        <div className="af-settings-crumb" aria-label="工作区">
          <span className="af-settings-crumb-muted">AgentFlow</span>
          <span className="af-settings-crumb-sep" aria-hidden>/</span>
          <span className="af-settings-crumb-active">工作区</span>
        </div>
        <button type="button" className="af-schedules-refresh" onClick={load} disabled={loading}>
          <span className="material-symbols-outlined">refresh</span>
          刷新
        </button>
      </header>

      <main className="af-settings-body">
        <div className="af-workspaces-inner">
          <header className="af-settings-hero">
            <h1 className="af-settings-h1">工作区</h1>
            <p className="af-settings-lead">维护可被 Load Workspace、一键任务和后续 Agent 运行使用的上下文目录。Git 字段与 mengmai 的资源配置保持一致。</p>
            {configPath ? <p className="af-workspaces-config">配置文件：{configPath}</p> : null}
            {error ? <p className="af-err af-settings-api-hint">{error}</p> : null}
            {status ? <p className="af-workspaces-status">{status}</p> : null}
          </header>

          <section className="af-workspaces-summary">
            <div>
              <span>内置</span>
              <strong>{builtins.length}</strong>
            </div>
            <div>
              <span>自定义</span>
              <strong>{custom.length}</strong>
            </div>
            <div>
              <span>Git</span>
              <strong>{custom.filter((item) => item.kind === "git").length}</strong>
            </div>
          </section>

          <div className="af-workspaces-layout">
            <section className="af-workspaces-list">
              <div className="af-workspaces-section-head">
                <h2>自定义工作区</h2>
                <button type="button" onClick={startCreate}>
                  <span className="material-symbols-outlined">add</span>
                  新增
                </button>
              </div>
              {custom.length ? custom.map((item, index) => (
                <WorkspaceCard
                  key={workspaceKey(item, index)}
                  item={item}
                  selected={workspaceKey(item, index) === selectedKey}
                  onClick={() => selectCustom(item, index)}
                />
              )) : (
                <div className="af-workspaces-empty">暂无自定义工作区。新增 Git 或本地目录后，画布里的 Load Workspace 就可以选择它。</div>
              )}

              <div className="af-workspaces-section-head af-workspaces-section-head--sub">
                <h2>内置工作区</h2>
              </div>
              {builtins.map((item, index) => (
                <WorkspaceCard
                  key={workspaceKey(item, index)}
                  item={item}
                  selected={workspaceKey(item, index) === selectedKey}
                  onClick={() => selectBuiltin(item, index)}
                  readOnly
                />
              ))}
            </section>

            <section className="af-workspaces-editor">
              <div className="af-workspaces-editor__head">
                <div>
                  <h2>{editingReadonly ? "查看内置工作区" : selectedCustomIndex >= 0 ? "编辑工作区" : "新增工作区"}</h2>
                  <p>{editingReadonly ? "内置项由当前运行环境提供，不能在这里修改。" : "本地路径用于执行，Git 字段用于后续同步和上下文挂载。"}</p>
                </div>
                <label className="af-workspaces-switch">
                  <input type="checkbox" checked={draft.enabled !== false} disabled={editingReadonly} onChange={(e) => patchDraft({ enabled: e.target.checked })} />
                  <span>启用</span>
                </label>
              </div>

              <div className="af-workspaces-kind">
                <button type="button" className={draft.kind === "git" ? "active" : ""} disabled={editingReadonly} onClick={() => patchDraft({ kind: "git", type: draft.type === "local" ? "code" : draft.type })}>
                  <span className="material-symbols-outlined">account_tree</span>
                  Git
                </button>
                <button type="button" className={draft.kind === "local" ? "active" : ""} disabled={editingReadonly} onClick={() => patchDraft({ kind: "local", type: "local" })}>
                  <span className="material-symbols-outlined">folder_open</span>
                  本地目录
                </button>
              </div>

              <div className="af-workspaces-form">
                <label>
                  <span>名称</span>
                  <input value={draft.label} disabled={editingReadonly} onChange={(e) => patchDraft({ label: e.target.value })} placeholder="Likee Android" />
                </label>
                <label>
                  <span>类型</span>
                  <select value={draft.type} disabled={editingReadonly} onChange={(e) => patchDraft({ type: e.target.value })}>
                    <option value="code">code</option>
                    <option value="docs">docs</option>
                    <option value="analytics">analytics</option>
                    <option value="config">config</option>
                    <option value="local">local</option>
                    <option value="other">other</option>
                  </select>
                </label>
                <label className="af-workspaces-form__wide">
                  <span>本地路径</span>
                  <input value={draft.path} disabled={editingReadonly} onChange={(e) => patchDraft({ path: e.target.value })} placeholder={draft.kind === "git" ? "可空，默认保存到用户数据目录/workspaces/repos/<id>" : "/Users/.../project"} />
                </label>
                {draft.kind === "git" ? (
                  <>
                    <label className="af-workspaces-form__wide">
                      <span>Git URL</span>
                      <input value={draft.repoUrl} disabled={editingReadonly} onChange={(e) => patchDraft({ repoUrl: e.target.value })} placeholder="https://git.example.com/group/repo.git" />
                    </label>
                    <label>
                      <span>分支</span>
                      <input value={draft.branch} disabled={editingReadonly} onChange={(e) => patchDraft({ branch: e.target.value })} placeholder="master" />
                    </label>
                    <label>
                      <span>挂载目录</span>
                      <input value={draft.mountPath} disabled={editingReadonly} onChange={(e) => patchDraft({ mountPath: e.target.value })} placeholder="likee_android" />
                    </label>
                    <label className="af-workspaces-form__wide">
                      <span>凭证环境变量</span>
                      <input value={draft.credentialRef} disabled={editingReadonly} onChange={(e) => patchDraft({ credentialRef: e.target.value })} placeholder="LIKEE_GIT_READONLY_TOKEN" />
                    </label>
                    <label className="af-workspaces-form__wide">
                      <span>Token</span>
                      <input
                        type="password"
                        value={tokenDraft}
                        disabled={editingReadonly}
                        onChange={(e) => setTokenDraft(e.target.value)}
                        placeholder={credentialEnvExists ? "已在个人环境变量中配置；留空则不修改" : "保存到个人环境变量，不写入 workspace 配置"}
                      />
                      <small>保存后只在 workspace 配置中保留 credentialRef，token 会写入当前用户的个人环境变量。</small>
                    </label>
                  </>
                ) : null}
                <label className="af-workspaces-form__wide">
                  <span>说明</span>
                  <textarea value={draft.description} disabled={editingReadonly} onChange={(e) => patchDraft({ description: e.target.value })} placeholder="这个工作区包含哪些代码、文档或需求上下文" />
                </label>
              </div>

              <div className="af-workspaces-actions">
                {!editingReadonly && selectedCustomIndex >= 0 ? (
                  <button type="button" className="af-workspaces-danger" onClick={deleteDraft} disabled={saving || syncing}>
                    <span className="material-symbols-outlined">delete</span>
                    删除
                  </button>
                ) : <span />}
                <div>
                  {draft.kind === "git" && selectedCustomIndex >= 0 ? (
                    <button type="button" onClick={syncDraft} disabled={editingReadonly || saving || syncing}>
                      <span className="material-symbols-outlined">{syncing ? "sync" : "download"}</span>
                      {syncing ? "拉取中" : "拉取更新"}
                    </button>
                  ) : null}
                  <button type="button" onClick={startCreate} disabled={saving || syncing}>重置</button>
                  <button type="button" className="af-workspaces-primary" onClick={saveDraft} disabled={editingReadonly || saving || syncing}>
                    <span className="material-symbols-outlined">save</span>
                    {saving ? "保存中" : "保存"}
                  </button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
