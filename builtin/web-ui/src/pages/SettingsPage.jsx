import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES, changeLanguage } from "../i18n";


const ENV_STORAGE_KEY = "agentflow-settings-env-v1";
/** 与服务器 config.json 同步的本地缓存（离线时回退） */
const OPCODE_PLAN_KEY = "agentflow-settings-opencode-plan-v1";

/** @param {unknown} ml */
function normalizeModelListsPayload(ml) {
  if (!ml || typeof ml !== "object") {
    return {
      cursor: [],
      opencode: [],
      claudeCode: [],
      cursorFetchedAt: null,
      opencodeFetchedAt: null,
      claudeCodeFetchedAt: null,
    };
  }
  const o = /** @type {{ cursor?: unknown, opencode?: unknown, claudeCode?: unknown, cursorFetchedAt?: unknown, opencodeFetchedAt?: unknown, claudeCodeFetchedAt?: unknown }} */ (ml);
  return {
    cursor: Array.isArray(o.cursor) ? o.cursor.map(String) : [],
    opencode: Array.isArray(o.opencode) ? o.opencode.map(String) : [],
    claudeCode: Array.isArray(o.claudeCode) ? o.claudeCode.map(String) : [],
    cursorFetchedAt: o.cursorFetchedAt ?? null,
    opencodeFetchedAt: o.opencodeFetchedAt ?? null,
    claudeCodeFetchedAt: o.claudeCodeFetchedAt ?? null,
  };
}

/** @typedef {{ id: string, key: string, value: string }} EnvRow */

function newId() {
  return `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** @param {unknown} raw */
function parseEnvRows(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const k = String(/** @type {{ key?: unknown }} */ (x).key ?? "").trim();
    const v = String(/** @type {{ value?: unknown }} */ (x).value ?? "");
    const id = String(/** @type {{ id?: unknown }} */ (x).id ?? "").trim() || newId();
    if (!k && !v) continue;
    out.push({ id, key: k, value: v });
  }
  return out;
}

function loadEnvFromStorage() {
  try {
    const s = localStorage.getItem(ENV_STORAGE_KEY);
    if (!s) return [];
    return parseEnvRows(JSON.parse(s));
  } catch {
    return [];
  }
}

function loadOpcodePlan() {
  try {
    return localStorage.getItem(OPCODE_PLAN_KEY) ?? "";
  } catch {
    return "";
  }
}

/** @param {string} v */
function maskValue(v) {
  if (!v) return "";
  if (v.length <= 6) return "•".repeat(v.length);
  return `${"•".repeat(Math.min(20, v.length - 4))}${v.slice(-4)}`;
}

/** @param {string | null | undefined} iso @param {string} lang */
function formatFetchedAt(iso, lang = "zh") {
  if (!iso) return ""; // 返回空，由调用方根据语言填充
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  try {
    const locale = lang === "en" ? "en-US" : lang === "ja" ? "ja-JP" : "zh-CN";
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "short",
      timeStyle: "medium",
    }).format(new Date(t));
  } catch {
    return String(iso);
  }
}

export default function SettingsPage() {
  const { t, i18n } = useTranslation(["common", "settings"]);
  const currentLang = i18n.language || "zh";
  
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [contextErr, setContextErr] = useState("");
  const [modelLists, setModelLists] = useState(
    /** @type {{ cursor: string[], opencode: string[], claudeCode: string[], cursorFetchedAt: string | null, opencodeFetchedAt: string | null, claudeCodeFetchedAt: string | null }} */ ({
      cursor: [],
      opencode: [],
      claudeCode: [],
      cursorFetchedAt: null,
      opencodeFetchedAt: null,
      claudeCodeFetchedAt: null,
    }),
  );
  const [listsErr, setListsErr] = useState("");
  const [listsLoading, setListsLoading] = useState(false);
  const [opencodeSaving, setOpencodeSaving] = useState(false);
  const [opencodeErr, setOpencodeErr] = useState("");

  const [envRows, setEnvRows] = useState(() => loadEnvFromStorage());
  const [draftKey, setDraftKey] = useState("");
  const [draftVal, setDraftVal] = useState("");
  const [opcodeDraft, setOpcodeDraft] = useState("");
  /** 与服务器（或首次加载的本地回退）已同步的 Provider，用于防抖保存时去重 */
  const lastSyncedOpencode = useRef(/** @type {string | null} */ (null));
  const opencodeConfigReady = useRef(false);

  const loadContext = useCallback(async () => {
    setContextErr("");
    try {
      const r = await fetch("/api/ui-context");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      setWorkspaceRoot(typeof j.workspaceRoot === "string" ? j.workspaceRoot : "");
    } catch (e) {
      setContextErr(String(/** @type {{ message?: string }} */ (e).message || e));
      setWorkspaceRoot("");
    }
  }, []);

  const loadLists = useCallback(async () => {
    setListsErr("");
    setListsLoading(true);
    try {
      const r = await fetch("/api/model-lists");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      setModelLists(normalizeModelListsPayload(j));
    } catch (e) {
      setListsErr(String(/** @type {{ message?: string }} */ (e).message || e));
    } finally {
      setListsLoading(false);
    }
  }, []);

  /** 重新执行 Cursor/OpenCode CLI 写入 model-lists.json */
  const refreshModelLists = useCallback(async () => {
    setListsErr("");
    setListsLoading(true);
    try {
      const r = await fetch("/api/update-model-lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opencodeProvider: opcodeDraft.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      setModelLists(normalizeModelListsPayload(j.modelLists));
    } catch (e) {
      setListsErr(String(/** @type {{ message?: string }} */ (e).message || e));
    } finally {
      setListsLoading(false);
    }
  }, [opcodeDraft]);

  useEffect(() => {
    loadContext();
    loadLists();
    (async () => {
      try {
        const r = await fetch("/api/agentflow-config");
        if (r.ok) {
          const j = await r.json();
          const p = typeof j.opencodeProvider === "string" ? j.opencodeProvider : "";
          setOpcodeDraft(p);
          lastSyncedOpencode.current = p;
          try {
            localStorage.setItem(OPCODE_PLAN_KEY, p);
          } catch (_) {}
        } else {
          const plan = loadOpcodePlan();
          setOpcodeDraft(plan);
          lastSyncedOpencode.current = plan;
        }
      } catch {
        const plan = loadOpcodePlan();
        setOpcodeDraft(plan);
        lastSyncedOpencode.current = plan;
      } finally {
        opencodeConfigReady.current = true;
      }
    })();
  }, [loadContext, loadLists]);

  useEffect(() => {
    try {
      localStorage.setItem(ENV_STORAGE_KEY, JSON.stringify(envRows));
    } catch (_) {}
  }, [envRows]);

  /** OpenCode Provider：停止输入约 450ms 后写入 config 并触发模型清单更新 */
  useEffect(() => {
    if (!opencodeConfigReady.current) return;
    const trimmed = opcodeDraft.trim();
    if (trimmed === lastSyncedOpencode.current) return;
    const t = setTimeout(() => {
      void (async () => {
        setOpencodeSaving(true);
        setOpencodeErr("");
        try {
          const r = await fetch("/api/agentflow-config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ opencodeProvider: trimmed }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
          }
          lastSyncedOpencode.current = trimmed;
          try {
            localStorage.setItem(OPCODE_PLAN_KEY, trimmed);
          } catch (_) {}
          if (j.modelLists) {
            setModelLists(normalizeModelListsPayload(j.modelLists));
          }
        } catch (e) {
          setOpencodeErr(String(/** @type {{ message?: string }} */ (e).message || e));
        } finally {
          setOpencodeSaving(false);
        }
      })();
    }, 450);
    return () => clearTimeout(t);
  }, [opcodeDraft]);

  const cursorReady = modelLists.cursor.length > 0;
  const opencodeReady = modelLists.opencode.length > 0;
  const claudeCodeReady = modelLists.claudeCode.length > 0;

  const copyWorkspace = useCallback(() => {
    if (!workspaceRoot) return;
    void navigator.clipboard?.writeText(workspaceRoot);
  }, [workspaceRoot]);

  const addEnvRow = useCallback(() => {
    const k = draftKey.trim();
    const v = draftVal;
    if (!k) return;
    setEnvRows((rows) => [...rows, { id: newId(), key: k, value: v }]);
    setDraftKey("");
    setDraftVal("");
  }, [draftKey, draftVal]);

  const removeEnvRow = useCallback((id) => {
    setEnvRows((rows) => rows.filter((r) => r.id !== id));
  }, []);

  const handleLanguageChange = useCallback((e) => {
    const newLang = e.target.value;
    changeLanguage(newLang);
  }, []);

  

  const getFetchedAtText = (iso) => {
    const formatted = formatFetchedAt(iso, currentLang);
    if (!formatted) return t("settings:cursor.modelList.never");
    return t("settings:cursor.modelList.fetchedAt", { time: formatted });
  };

  return (
    <div className="af-settings-page">
      <header className="af-settings-top">
        <div className="af-settings-crumb" aria-label={t("settings:title")}>
          <span className="af-settings-crumb-muted">{t("settings:crumb.engine")}</span>
          <span className="af-settings-crumb-sep" aria-hidden>
            /
          </span>
          <span className="af-settings-crumb-active">{t("settings:crumb.preferences")}</span>
        </div>
      </header>

      <div className="af-settings-body">
        <div className="af-settings-inner">
          <header className="af-settings-hero">
            <h1 className="af-settings-h1">{t("common:app.name")} {t("settings:title")}</h1>
            <p className="af-settings-lead">
              {t("settings:workspace.description")}
            </p>
            {contextErr ? <p className="af-err af-settings-api-hint">{contextErr}</p> : null}
            {listsErr ? <p className="af-err af-settings-api-hint">{listsErr}</p> : null}
          </header>

          <div className="af-settings-layout">
            <div className="af-settings-bento">
              <section className="af-set-card af-set-card--narrow af-set-card--low af-set-workspace">
                <div className="af-set-card-inner">
                  <div className="af-set-card-head">
                    <span className="material-symbols-outlined af-set-icon af-set-icon--secondary">folder_managed</span>
                    <h2 className="af-set-h2">{t("settings:workspace.title")}</h2>
                  </div>
                  <label className="af-set-label" htmlFor="af-workspace-path">
                    {t("settings:workspace.currentPath")}
                  </label>
                  <div className="af-set-input-wrap">
                    <input
                      id="af-workspace-path"
                      className="af-set-input af-set-input--mono"
                      type="text"
                      readOnly
                      value={workspaceRoot}
                      placeholder={t("common:loading")}
                    />
                    <button
                      type="button"
                      className="af-set-input-suffix"
                      onClick={copyWorkspace}
                      aria-label={t("settings:workspace.copyPath")}
                      disabled={!workspaceRoot}
                    >
                      <span className="material-symbols-outlined">content_copy</span>
                    </button>
                  </div>
                  <p className="af-set-hint">{t("settings:workspace.description")}</p>
                </div>
                <div className="af-set-watermark" aria-hidden>
                  <span className="material-symbols-outlined">account_tree</span>
                </div>
              </section>

              <section className="af-set-card af-set-card--narrow af-set-card--high">
                <div className="af-set-card-head af-set-card-head--spread">
                  <h2 className="af-set-h2 af-set-h2--caps">Cursor CLI</h2>
                  <span
                    className={
                      "af-set-badge" +
                      (cursorReady ? " af-set-badge--ok" : " af-set-badge--muted")
                    }
                  >
                    {cursorReady ? t("settings:cursor.status.cached") : t("settings:cursor.status.notCached")}
                  </span>
                </div>
                <div className="af-set-cli-block">
                  <div className="af-set-cli-icon">
                    <span className="material-symbols-outlined af-set-icon--tertiary">
                      {cursorReady ? "check_circle" : "hourglass_empty"}
                    </span>
                  </div>
                  <div>
                    <p className="af-set-cli-title">{cursorReady ? t("settings:cursor.modelList.cached") : t("settings:cursor.modelList.empty")}</p>
                    <p className="af-set-cli-mono">
                      {cursorReady
                        ? t("settings:cursor.modelList.count", { count: modelLists.cursor.length }) +
                            " · " +
                            getFetchedAtText(modelLists.cursorFetchedAt)
                        : t("settings:cursor.modelList.refresh")}
                    </p>
                  </div>
                </div>
                {cursorReady ? (
                  <pre
                    className="af-set-model-preview"
                    aria-label={t("settings:cursor.modelPreviewLabel")}
                  >
                    {modelLists.cursor.join("\n")}
                  </pre>
                ) : null}
                <button
                  type="button"
                  className="af-set-btn-outline"
                  onClick={() => refreshModelLists()}
                  disabled={listsLoading}
                >
                  {listsLoading ? t("settings:cursor.modelList.fetching") : t("settings:cursor.modelList.refresh")}
                </button>
              </section>

              <section className="af-set-card af-set-card--narrow af-set-card--high">
                <div className="af-set-card-head af-set-card-head--spread">
                  <h2 className="af-set-h2 af-set-h2--caps">OpenCode</h2>
                  <span
                    className={
                      "af-set-badge" + (opencodeReady ? " af-set-badge--ok" : " af-set-badge--err")
                    }
                  >
                    {opencodeReady ? t("settings:opencode.status.ready") : t("settings:opencode.status.notFound")}
                  </span>
                </div>
                <p className="af-set-p">
                  {t("settings:opencode.description")}
                </p>
                <div>
                  <label className="af-set-label-sm" htmlFor="af-opencode-plan">
                    {t("settings:opencode.provider")}
                  </label>
                  <input
                    id="af-opencode-plan"
                    className="af-set-input af-set-input--sm af-set-input--mono"
                    type="text"
                    value={opcodeDraft}
                    onChange={(e) => setOpcodeDraft(e.target.value)}
                    placeholder={t("settings:opencode.providerPlaceholder")}
                    autoComplete="off"
                  />
                  {opencodeSaving ? (
                    <p className="af-set-hint af-set-hint--inline" aria-live="polite">
                      {t("settings:opencode.saving")}
                    </p>
                  ) : null}
                  {opencodeErr ? (
                    <p className="af-err af-set-hint af-set-hint--inline" role="alert">
                      {opencodeErr}
                    </p>
                  ) : null}
                </div>
                {opencodeReady ? (
                  <>
                    <p className="af-set-cli-mono af-set-cli-mono--block">
                      {t("settings:cursor.modelList.count", { count: modelLists.opencode.length }) +
                        " · " +
                        getFetchedAtText(modelLists.opencodeFetchedAt)}
                    </p>
                    <pre
                      className="af-set-model-preview"
                      aria-label={t("settings:opencode.modelPreviewLabel")}
                    >
                      {modelLists.opencode.join("\n")}
                    </pre>
                  </>
                ) : null}
                <button
                  type="button"
                  className="af-set-btn-outline"
                  onClick={() => refreshModelLists()}
                  disabled={listsLoading}
                >
                  {listsLoading ? t("settings:cursor.modelList.fetching") : t("settings:cursor.modelList.refresh")}
                </button>
              </section>

              <section className="af-set-card af-set-card--narrow af-set-card--high">
                <div className="af-set-card-head af-set-card-head--spread">
                  <h2 className="af-set-h2 af-set-h2--caps">{t("settings:claudeCode.title")}</h2>
                  <span
                    className={
                      "af-set-badge" + (claudeCodeReady ? " af-set-badge--ok" : " af-set-badge--err")
                    }
                  >
                    {claudeCodeReady
                      ? t("settings:claudeCode.status.ready")
                      : t("settings:claudeCode.status.notFound")}
                  </span>
                </div>
                <div className="af-set-cli-block">
                  <div className="af-set-cli-icon">
                    <span className="material-symbols-outlined af-set-icon--tertiary">
                      {claudeCodeReady ? "check_circle" : "hourglass_empty"}
                    </span>
                  </div>
                  <div>
                    <p className="af-set-cli-title">
                      {claudeCodeReady
                        ? t("settings:cursor.modelList.cached")
                        : t("settings:cursor.modelList.empty")}
                    </p>
                    <p className="af-set-cli-mono">
                      {claudeCodeReady
                        ? t("settings:cursor.modelList.count", { count: modelLists.claudeCode.length }) +
                          " · " +
                          getFetchedAtText(modelLists.claudeCodeFetchedAt)
                        : t("settings:cursor.modelList.refresh")}
                    </p>
                  </div>
                </div>
                <p className="af-set-p">{t("settings:claudeCode.description")}</p>
                {claudeCodeReady ? (
                  <pre
                    className="af-set-model-preview"
                    aria-label={t("settings:claudeCode.modelPreviewLabel")}
                  >
                    {modelLists.claudeCode.join("\n")}
                  </pre>
                ) : null}
                <button
                  type="button"
                  className="af-set-btn-outline"
                  onClick={() => refreshModelLists()}
                  disabled={listsLoading}
                >
                  {listsLoading ? t("settings:cursor.modelList.fetching") : t("settings:cursor.modelList.refresh")}
                </button>
              </section>

              <section className="af-set-card af-set-card--wide af-set-card--low af-set-env">
                <div className="af-set-env-head">
                  <div className="af-set-card-head">
                    <div className="af-set-env-icon-wrap">
                      <span className="material-symbols-outlined af-set-icon--primary">variables</span>
                    </div>
                    <h2 className="af-set-h2">{t("settings:env.title")}</h2>
                  </div>
                  <span className="af-set-env-note">{t("settings:env.note")}</span>
                </div>

                <div className="af-set-env-rows">
                  {envRows.map((row) => (
                    <div key={row.id} className="af-set-env-row">
                      <div className="af-set-env-cell">
                        <span className="af-set-env-k">{t("settings:env.key")}</span>
                        <code className="af-set-code-key">{row.key || "—"}</code>
                      </div>
                      <div className="af-set-env-cell af-set-env-cell--grow">
                        <span className="af-set-env-k">{t("settings:env.value")}</span>
                        <code className="af-set-code-val">{maskValue(row.value)}</code>
                      </div>
                      <div className="af-set-env-actions">
                        <button
                          type="button"
                          className="af-set-env-del"
                          aria-label={t("settings:env.delete", { key: row.key })}
                          onClick={() => removeEnvRow(row.id)}
                        >
                          <span className="material-symbols-outlined">delete_outline</span>
                        </button>
                      </div>
                    </div>
                  ))}

                  <div className="af-set-env-row af-set-env-row--draft">
                    <div className="af-set-env-cell">
                      <input
                        className="af-set-input af-set-input--dashed af-set-input--mono"
                        placeholder="KEY_NAME"
                        value={draftKey}
                        onChange={(e) => setDraftKey(e.target.value)}
                        aria-label={t("settings:env.newKey")}
                      />
                    </div>
                    <div className="af-set-env-cell af-set-env-cell--grow">
                      <input
                        className="af-set-input af-set-input--dashed af-set-input--mono"
                        type="password"
                        placeholder={t("settings:env.newValue")}
                        value={draftVal}
                        onChange={(e) => setDraftVal(e.target.value)}
                        aria-label={t("settings:env.newValue")}
                      />
                    </div>
                    <div className="af-set-env-actions">
                      <button
                        type="button"
                        className="af-set-btn-add"
                        onClick={addEnvRow}
                        disabled={!draftKey.trim()}
                      >
                        <span className="material-symbols-outlined">add</span>
                        {t("settings:env.add")}
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            </div>

            <aside className="af-settings-rail" aria-label={t("settings:title")}>
              <div className="af-set-rail-card af-set-rail-card--accent">
                <div className="af-set-rail-inner">
                  <h3 className="af-set-rail-h3">{t("settings:system.title")}</h3>
                  <div className="af-set-health-line">
                    <span className="af-set-pulse-dot" aria-hidden />
                    <span className="af-set-health-label">
                      {!contextErr && !listsErr ? t("settings:system.normal") : t("settings:system.abnormal")}
                    </span>
                  </div>
                  <div className="af-set-meter">
                    <div className="af-set-meter-row">
                      <span>{t("settings:system.cursorModels")}</span>
                      <span>{modelLists.cursor.length}</span>
                    </div>
                    <div className="af-set-meter-bar">
                      <div
                        className="af-set-meter-fill"
                        style={{
                          width: `${Math.min(100, modelLists.cursor.length > 0 ? 12 + modelLists.cursor.length * 3 : 4)}%`,
                        }}
                      />
                    </div>
                  </div>
                  <div className="af-set-meter">
                    <div className="af-set-meter-row">
                      <span>{t("settings:system.opencodeModels")}</span>
                      <span>{modelLists.opencode.length}</span>
                    </div>
                    <div className="af-set-meter-bar">
                      <div
                        className="af-set-meter-fill"
                        style={{
                          width: `${Math.min(100, modelLists.opencode.length > 0 ? 12 + modelLists.opencode.length * 3 : 4)}%`,
                        }}
                      />
                    </div>
                  </div>
                  <div className="af-set-meter">
                    <div className="af-set-meter-row">
                      <span>{t("settings:system.claudeCodeModels")}</span>
                      <span>{modelLists.claudeCode.length}</span>
                    </div>
                    <div className="af-set-meter-bar">
                      <div
                        className="af-set-meter-fill"
                        style={{
                          width: `${Math.min(100, modelLists.claudeCode.length > 0 ? 12 + modelLists.claudeCode.length * 3 : 4)}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
                <div className="af-set-rail-watermark" aria-hidden>
                  <span className="material-symbols-outlined">vital_signs</span>
                </div>
              </div>

              <div className="af-set-rail-card">
                <h3 className="af-set-rail-h3 af-set-rail-h3--sm">{t("settings:language.title")}</h3>
                <div className="af-set-language-selector">
                  <select
                    className="af-set-input af-set-input--sm"
                    value={currentLang}
                    onChange={handleLanguageChange}
                    aria-label={t("settings:language.description")}
                  >
                    {SUPPORTED_LANGUAGES.map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {lang.flag} {lang.name}
                      </option>
                    ))}
                  </select>
                  <p className="af-set-hint">{t("settings:language.description")}</p>
                </div>
              </div>

              </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
