import { useCallback, useEffect, useState } from "react";

function compareVersions(a, b) {
  const pa = String(a || "").split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const pb = String(b || "").split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const av = Number.isFinite(pa[i]) ? pa[i] : 0;
    const bv = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

function installedSkillVersion(s) {
  return String(s?.version || "").trim();
}

function installedSkillMeta(s) {
  const version = installedSkillVersion(s);
  const parts = [s?.agent || "codex", s?.kind || "skill"];
  if (version) parts.push(`v${version}`);
  return parts.join(" · ");
}

export default function SkillHubPanel({ onChanged, canManage = false }) {
  const [status, setStatus] = useState({
    available: false,
    version: "",
    loggedIn: false,
    user: "",
    error: "",
  });
  const [installed, setInstalled] = useState([]);
  const [skillsRoot, setSkillsRoot] = useState("");
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState("keyword");
  const [results, setResults] = useState([]);
  const [updateState, setUpdateState] = useState({});
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setErr("");
    try {
      const [statusRes, listRes] = await Promise.all([
        fetch("/api/skillhub/status"),
        fetch("/api/skillhub/list?target=agentflow&agent=codex"),
      ]);
      const statusJson = await statusRes.json().catch(() => ({}));
      if (statusRes.ok) {
        setStatus({
          available: Boolean(statusJson.available),
          version: typeof statusJson.version === "string" ? statusJson.version : "",
          loggedIn: Boolean(statusJson.loggedIn),
          user: typeof statusJson.user === "string" ? statusJson.user : "",
          error: typeof statusJson.error === "string" ? statusJson.error : "",
        });
      }
      const listJson = await listRes.json().catch(() => ({}));
      if (!listRes.ok) throw new Error(typeof listJson.error === "string" ? listJson.error : "HTTP " + listRes.status);
      setInstalled(Array.isArray(listJson.skills) ? listJson.skills : []);
      setSkillsRoot(typeof listJson.skillsRoot === "string" ? listJson.skillsRoot : "");
      setUpdateState({});
    } catch (e) {
      setErr(String(e.message || e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setBusy("search");
    setErr("");
    setMsg("");
    try {
      const r = await fetch(`/api/skillhub/search?q=${encodeURIComponent(q)}&mode=${encodeURIComponent(searchMode)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      setResults(Array.isArray(j.items) ? j.items : []);
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy("");
    }
  }, [query, searchMode]);

  const install = useCallback(async (itemOrSlug, force = false) => {
    if (!canManage) return;
    const item = itemOrSlug && typeof itemOrSlug === "object" ? itemOrSlug : null;
    const s = String(item ? item.slug || item.name || item.collection || item.skillId || item.id : itemOrSlug || "").trim();
    if (!s) return;
    setBusy(`install:${s}`);
    setErr("");
    setMsg("");
    try {
      const body = item
        ? {
            slug: item.slug || "",
            skillId: item.skillId || "",
            collection: item.collection || "",
            collectionName: item.collection ? item.name || "" : "",
            version: item.version || item.latestVersion || "",
            target: "agentflow",
            agent: "codex",
            force,
          }
        : { slug: s, target: "agentflow", agent: "codex", force };
      const r = await fetch("/api/skillhub/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      setMsg(force ? `已更新 ${s}` : `已安装 ${s}`);
      await load();
      if (typeof onChanged === "function") await onChanged();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy("");
    }
  }, [canManage, load, onChanged]);

  const checkUpdates = useCallback(async () => {
    if (!canManage) return;
    if (installed.length === 0) return;
    setBusy("check-updates");
    setErr("");
    setMsg("");
    try {
      const entries = await Promise.all(installed.map(async (skill) => {
        const slug = String(skill.name || "").trim();
        if (!slug) return null;
        try {
          const r = await fetch(`/api/skillhub/search?q=${encodeURIComponent(slug)}&mode=keyword`);
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
          const items = Array.isArray(j.items) ? j.items : [];
          const exact = items.find((item) => item.slug === slug || item.name === slug || item.id === slug) || items[0];
          const installedVersion = installedSkillVersion(skill);
          const latestVersion = String(exact?.version || "").trim();
          let state = "unknown";
          if (!exact) state = "missing";
          else if (installedVersion && latestVersion) state = compareVersions(installedVersion, latestVersion) < 0 ? "update" : "current";
          else if (latestVersion) state = "remote-only";
          return [slug, {
            state,
            latestVersion,
            version: latestVersion,
            installedVersion,
            slug: exact?.slug || "",
            skillId: exact?.skillId || exact?.id || "",
            name: exact?.name || slug,
            summary: exact?.summary || "",
          }];
        } catch (e) {
          return [slug, { state: "error", error: String(e.message || e), installedVersion: installedSkillVersion(skill) }];
        }
      }));
      const next = {};
      for (const entry of entries) {
        if (entry) next[entry[0]] = entry[1];
      }
      setUpdateState(next);
      const count = Object.values(next).filter((item) => item.state === "update").length;
      setMsg(count > 0 ? `发现 ${count} 个可更新 skill` : "已检查，暂无明确可更新项");
    } finally {
      setBusy("");
    }
  }, [canManage, installed]);

  const uninstall = useCallback(async (slug) => {
    if (!canManage) return;
    const s = String(slug || "").trim();
    if (!s) return;
    setBusy(`uninstall:${s}`);
    setErr("");
    setMsg("");
    try {
      const r = await fetch("/api/skillhub/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: s, target: "agentflow", agent: "codex" }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      setMsg(`已卸载 ${s}`);
      await load();
      if (typeof onChanged === "function") await onChanged();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy("");
    }
  }, [canManage, load, onChanged]);

  const updateCli = useCallback(async () => {
    if (!canManage) return;
    setBusy("update-cli");
    setErr("");
    setMsg("");
    try {
      const r = await fetch("/api/skillhub/update", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      setMsg("SkillHub CLI 已更新");
      await load();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy("");
    }
  }, [canManage, load]);

  return (
    <section className="af-set-card af-set-card--span-all af-set-skillhub">
      <div className="af-set-card-head af-set-card-head--spread">
        <div>
          <h2 className="af-set-h2">SkillHub</h2>
          <p className="af-set-p af-set-p--tight">
            {canManage ? "搜索、安装、更新和卸载 AgentFlow 共享 skills。" : "查看 AgentFlow 共享 skills；使用时在 Workspace 中通过 Load Skills 加载。"}
          </p>
          {skillsRoot ? <p className="af-set-hint af-set-hint--inline">Skills Root：<code>{skillsRoot}</code></p> : null}
        </div>
        <div className="af-set-skillhub-head-actions">
          <div className="af-set-skillhub-status">
            <span className="material-symbols-outlined af-set-icon--tertiary">extension</span>
            <span>{status.loggedIn ? `已登录 ${status.user}` : "未登录 SkillHub"}</span>
            <span className={"af-set-badge" + (status.available ? " af-set-badge--ok" : " af-set-badge--err")}>
              {status.available ? `v${status.version}` : "not found"}
            </span>
          </div>
          <div className="af-set-skillhub-toolbar">
            <button type="button" className="af-set-btn-mini" onClick={load} disabled={Boolean(busy)}>
              刷新
            </button>
            <button type="button" className="af-set-btn-mini" onClick={checkUpdates} disabled={!canManage || Boolean(busy) || installed.length === 0}>
              {busy === "check-updates" ? "检查中…" : "检查更新"}
            </button>
            <button type="button" className="af-set-btn-mini" onClick={updateCli} disabled={!canManage || Boolean(busy)}>
              {busy === "update-cli" ? "更新中…" : "更新 CLI"}
            </button>
          </div>
        </div>
      </div>

      <div className="af-set-skillhub-search">
        <select
          className="af-set-input af-set-input--sm af-set-skillhub-search-mode"
          value={searchMode}
          onChange={(e) => {
            setSearchMode(e.target.value);
            setResults([]);
          }}
        >
          <option value="keyword">关键词</option>
          <option value="skillId">Skill ID</option>
          <option value="collectionId">Collection ID</option>
        </select>
        <input
          className="af-set-input af-set-input--sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
          }}
          placeholder={
            searchMode === "collectionId"
              ? "输入 collection id，例如 1"
              : searchMode === "skillId"
                ? "输入 skill id"
                : "搜索 skill slug / 关键词，例如 android、issue-tracker"
          }
        />
        <button
          type="button"
          className="af-set-btn-add"
          onClick={() => search()}
          disabled={!query.trim() || busy === "search"}
        >
          <span className="material-symbols-outlined">search</span>
          {busy === "search" ? "搜索中…" : "搜索"}
        </button>
      </div>

      {err ? <p className="af-err af-set-hint af-set-hint--inline">{err}</p> : null}
      {msg ? <p className="af-set-hint af-set-hint--inline">{msg}</p> : null}

      <div className="af-set-skillhub-grid">
        <div className="af-set-skillhub-pane">
          <div className="af-set-skillhub-pane-head">
            <h3>已安装</h3>
            <span>{installed.length}</span>
          </div>
          <div className="af-set-skillhub-list">
            {installed.length === 0 ? (
              <div className="af-set-skillhub-empty">暂无 AgentFlow 共享 skills</div>
            ) : (
              installed.map((s) => {
                const update = updateState[s.name];
                const canUpdate = !update || update.state === "update" || update.state === "remote-only" || update.state === "unknown" || update.state === "error";
                const updateLabel =
                  busy === `install:${s.name}` ? "更新中…"
                    : update?.state === "current" ? "已最新"
                    : update?.state === "update" && update.latestVersion ? `更新到 v${update.latestVersion}`
                    : update?.state === "remote-only" && update.latestVersion ? `安装 v${update.latestVersion}`
                    : "重装";
                return (
                  <div key={`${s.agent}:${s.path}:${s.name}`} className="af-set-skillhub-item">
                    <div>
                      <div className="af-set-skillhub-title">{s.displayName || s.name}</div>
                      <div className="af-set-skillhub-meta">{installedSkillMeta(s)}</div>
                      <div className="af-set-skillhub-version-row">
                        {!update ? (
                          <span className="af-set-skillhub-version af-set-skillhub-version--muted">未检查远端版本</span>
                        ) : update.state === "update" ? (
                          <span className="af-set-skillhub-version af-set-skillhub-version--warn">
                            可更新 {update.installedVersion ? `v${update.installedVersion} -> ` : ""}v{update.latestVersion}
                          </span>
                        ) : update.state === "current" ? (
                          <span className="af-set-skillhub-version af-set-skillhub-version--ok">已最新 v{update.latestVersion || update.installedVersion}</span>
                        ) : update.state === "remote-only" ? (
                          <span className="af-set-skillhub-version af-set-skillhub-version--muted">远端 v{update.latestVersion}，本地版本未知</span>
                        ) : update.state === "missing" ? (
                          <span className="af-set-skillhub-version af-set-skillhub-version--muted">未找到远端匹配项</span>
                        ) : update.state === "error" ? (
                          <span className="af-set-skillhub-version af-set-skillhub-version--err">检查失败</span>
                        ) : (
                          <span className="af-set-skillhub-version af-set-skillhub-version--muted">状态未知</span>
                        )}
                      </div>
                    </div>
                    <div className="af-set-skillhub-actions">
                      <button
                        type="button"
                        className="af-set-btn-mini"
                        onClick={() => install(update?.slug || update?.skillId ? { ...update, slug: update.slug || s.name } : s.name, true)}
                        disabled={!canManage || Boolean(busy) || !canUpdate}
                      >
                        {updateLabel}
                      </button>
                      <button type="button" className="af-set-btn-mini af-set-btn-mini--danger" onClick={() => uninstall(s.name)} disabled={!canManage || Boolean(busy)}>
                        卸载
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="af-set-skillhub-pane">
          <div className="af-set-skillhub-pane-head">
            <h3>搜索结果</h3>
            <span>{results.length}</span>
          </div>
          <div className="af-set-skillhub-list">
            {results.length === 0 ? (
              <div className="af-set-skillhub-empty">输入关键词后搜索 SkillHub</div>
            ) : (
              results.map((s) => {
                const slug = s.slug || s.name;
                const isCollection = s.kind === "collection" || s.collection;
                const isInstalled = !isCollection && installed.some((x) => x.name === slug || x.name === s.name);
                return (
                  <div key={s.id || slug} className="af-set-skillhub-item">
                    <div>
                      <div className="af-set-skillhub-title">{s.name || slug}</div>
                      <div className="af-set-skillhub-meta">
                        {isCollection ? `collection:${s.collection}` : slug}{s.skillId ? ` · id:${s.skillId}` : ""}{s.version ? ` · ${s.version}` : ""}
                      </div>
                      {s.summary ? <p className="af-set-skillhub-summary">{s.summary}</p> : null}
                    </div>
                    <button
                      type="button"
                      className={isInstalled ? "af-set-btn-mini" : "af-set-btn-add af-set-btn-add--compact"}
                      onClick={() => install(s, isInstalled)}
                      disabled={!canManage || Boolean(busy)}
                    >
                      {isInstalled ? "更新" : isCollection ? "安装合集" : "安装"}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
