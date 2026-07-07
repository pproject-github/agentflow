import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES, changeLanguage } from "../i18n";

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

/** @typedef {{ id: string, key: string, value: string, scope?: "user" | "global" }} EnvRow */

function newId() {
  return `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isValidEnvKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key || "").trim());
}

/** @param {unknown} raw @param {"user" | "global"} fallbackScope */
function parseEnvRows(raw, fallbackScope = "user") {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const k = String(/** @type {{ key?: unknown }} */ (x).key ?? "").trim();
    const v = String(/** @type {{ value?: unknown }} */ (x).value ?? "");
    const id = String(/** @type {{ id?: unknown }} */ (x).id ?? "").trim() || newId();
    const rawScope = String(/** @type {{ scope?: unknown }} */ (x).scope ?? fallbackScope).trim();
    const scope = rawScope === "global" ? "global" : "user";
    if (!k && !v) continue;
    out.push({ id, key: k, value: v, scope });
  }
  return out;
}

function stripEnvRowsForSave(rows) {
  return parseEnvRows(rows).map(({ key, value }) => ({ key, value }));
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

export default function SettingsPage({ authUser }) {
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
  const [envRows, setEnvRows] = useState([]);
  const [envErr, setEnvErr] = useState("");
  const [envSaving, setEnvSaving] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [draftVal, setDraftVal] = useState("");
  const [draftGlobal, setDraftGlobal] = useState(false);
  const [visibleEnvIds, setVisibleEnvIds] = useState(() => new Set());
  const [opcodeDraft, setOpcodeDraft] = useState("");
  const [feedbackItems, setFeedbackItems] = useState([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackErr, setFeedbackErr] = useState("");
  const [allowlistFileUsers, setAllowlistFileUsers] = useState([]);
  const [allowlistEnvUsers, setAllowlistEnvUsers] = useState([]);
  const [allowlistPath, setAllowlistPath] = useState("");
  const [allowlistDraft, setAllowlistDraft] = useState("");
  const [allowlistLoading, setAllowlistLoading] = useState(false);
  const [allowlistSaving, setAllowlistSaving] = useState(false);
  const [allowlistErr, setAllowlistErr] = useState("");
  const [dataRootDraft, setDataRootDraft] = useState("");
  const [dataRootConfig, setDataRootConfig] = useState(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageSaving, setStorageSaving] = useState(false);
  const [storageErr, setStorageErr] = useState("");
  /** 与服务器（或首次加载的本地回退）已同步的 Provider，用于防抖保存时去重 */
  const lastSyncedOpencode = useRef(/** @type {string | null} */ (null));
  const opencodeConfigReady = useRef(false);
  const envConfigReady = useRef(false);
  const lastSyncedEnv = useRef("");

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

  const loadUserEnv = useCallback(async () => {
    setEnvErr("");
    try {
      const r = await fetch("/api/user-env");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      const personalRows = parseEnvRows(Array.isArray(j.env) ? j.env : [], "user").map((row) => ({ ...row, scope: "user" }));
      const globalRows = authUser?.isAdmin
        ? parseEnvRows(Array.isArray(j.globalEnv) ? j.globalEnv : [], "global").map((row) => ({ ...row, scope: "global" }))
        : [];
      const rows = [...globalRows, ...personalRows];
      lastSyncedEnv.current = JSON.stringify(rows);
      setEnvRows(rows);
    } catch (e) {
      setEnvRows([]);
      setEnvErr(String(/** @type {{ message?: string }} */ (e).message || e));
    } finally {
      envConfigReady.current = true;
    }
  }, [authUser?.isAdmin]);

  const loadFeedback = useCallback(async () => {
    if (!authUser?.isAdmin) return;
    setFeedbackLoading(true);
    setFeedbackErr("");
    try {
      const r = await fetch("/api/feedback");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      setFeedbackItems(Array.isArray(j.feedback) ? j.feedback : []);
    } catch (e) {
      setFeedbackErr(String(/** @type {{ message?: string }} */ (e).message || e));
    } finally {
      setFeedbackLoading(false);
    }
  }, [authUser?.isAdmin]);

  const loadUserAllowlist = useCallback(async () => {
    if (!authUser?.isAdmin) return;
    setAllowlistLoading(true);
    setAllowlistErr("");
    try {
      const r = await fetch("/api/admin/user-allowlist");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      const allowlist = j.allowlist && typeof j.allowlist === "object" ? j.allowlist : {};
      setAllowlistFileUsers(Array.isArray(allowlist.fileUsers) ? allowlist.fileUsers.map(String) : []);
      setAllowlistEnvUsers(Array.isArray(allowlist.envUsers) ? allowlist.envUsers.map(String) : []);
      setAllowlistPath(typeof allowlist.path === "string" ? allowlist.path : "");
    } catch (e) {
      setAllowlistErr(String(/** @type {{ message?: string }} */ (e).message || e));
    } finally {
      setAllowlistLoading(false);
    }
  }, [authUser?.isAdmin]);

  const saveUserAllowlist = useCallback(async (users) => {
    if (!authUser?.isAdmin) return;
    setAllowlistSaving(true);
    setAllowlistErr("");
    try {
      const r = await fetch("/api/admin/user-allowlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ users }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      const allowlist = j.allowlist && typeof j.allowlist === "object" ? j.allowlist : {};
      setAllowlistFileUsers(Array.isArray(allowlist.fileUsers) ? allowlist.fileUsers.map(String) : []);
      setAllowlistEnvUsers(Array.isArray(allowlist.envUsers) ? allowlist.envUsers.map(String) : []);
      setAllowlistPath(typeof allowlist.path === "string" ? allowlist.path : "");
    } catch (e) {
      setAllowlistErr(String(/** @type {{ message?: string }} */ (e).message || e));
    } finally {
      setAllowlistSaving(false);
    }
  }, [authUser?.isAdmin]);

  const loadStorageConfig = useCallback(async () => {
    if (!authUser?.isAdmin) return;
    setStorageLoading(true);
    setStorageErr("");
    try {
      const r = await fetch("/api/admin/storage-config");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      const config = j.config && typeof j.config === "object" ? j.config : {};
      setDataRootConfig(config);
      setDataRootDraft(typeof config.dataRoot === "string" ? config.dataRoot : "");
    } catch (e) {
      setStorageErr(String(/** @type {{ message?: string }} */ (e).message || e));
    } finally {
      setStorageLoading(false);
    }
  }, [authUser?.isAdmin]);

  const saveStorageConfig = useCallback(async () => {
    if (!authUser?.isAdmin) return;
    setStorageSaving(true);
    setStorageErr("");
    try {
      const r = await fetch("/api/admin/storage-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataRoot: dataRootDraft.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      const config = j.config && typeof j.config === "object" ? j.config : {};
      setDataRootConfig(config);
      setDataRootDraft(typeof config.dataRoot === "string" ? config.dataRoot : "");
    } catch (e) {
      setStorageErr(String(/** @type {{ message?: string }} */ (e).message || e));
    } finally {
      setStorageSaving(false);
    }
  }, [authUser?.isAdmin, dataRootDraft]);

  const saveUserEnv = useCallback(async (rows) => {
    const normalized = parseEnvRows(rows);
    const personalRows = normalized.filter((row) => row.scope !== "global");
    const globalRows = normalized.filter((row) => row.scope === "global");
    setEnvSaving(true);
    setEnvErr("");
    try {
      const r = await fetch("/api/user-env", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          env: stripEnvRowsForSave(personalRows),
          ...(authUser?.isAdmin ? { globalEnv: stripEnvRowsForSave(globalRows) } : {}),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      const nextPersonalRows = parseEnvRows(Array.isArray(j.env) ? j.env : [], "user").map((row) => ({ ...row, scope: "user" }));
      const nextGlobalRows = authUser?.isAdmin
        ? parseEnvRows(Array.isArray(j.globalEnv) ? j.globalEnv : [], "global").map((row) => ({ ...row, scope: "global" }))
        : [];
      const nextRows = [...nextGlobalRows, ...nextPersonalRows];
      lastSyncedEnv.current = JSON.stringify(nextRows);
      setEnvRows(nextRows);
    } catch (e) {
      setEnvErr(String(/** @type {{ message?: string }} */ (e).message || e));
    } finally {
      setEnvSaving(false);
    }
  }, [authUser?.isAdmin]);

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
    loadUserEnv();
    if (authUser?.isAdmin) {
      void loadFeedback();
      void loadUserAllowlist();
      void loadStorageConfig();
    }
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
  }, [authUser?.isAdmin, loadContext, loadFeedback, loadLists, loadStorageConfig, loadUserAllowlist, loadUserEnv]);

  useEffect(() => {
    if (!envConfigReady.current) return;
    const serialized = JSON.stringify(parseEnvRows(envRows));
    if (serialized === lastSyncedEnv.current) return;
    const t = setTimeout(() => {
      void saveUserEnv(envRows);
    }, 350);
    return () => clearTimeout(t);
  }, [envRows, saveUserEnv]);

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
  const allowlistEnabled = allowlistFileUsers.length > 0 || allowlistEnvUsers.length > 0;

  const copyWorkspace = useCallback(() => {
    if (!workspaceRoot) return;
    void navigator.clipboard?.writeText(workspaceRoot);
  }, [workspaceRoot]);

  const addEnvRow = useCallback(() => {
    const k = draftKey.trim();
    const v = draftVal;
    if (!k) return;
    if (!isValidEnvKey(k)) {
      setEnvErr(t("settings:env.invalidKey"));
      return;
    }
    setEnvRows((rows) => [...rows, { id: newId(), key: k, value: v, scope: authUser?.isAdmin && draftGlobal ? "global" : "user" }]);
    setDraftKey("");
    setDraftVal("");
  }, [authUser?.isAdmin, draftGlobal, draftKey, draftVal, t]);

  const removeEnvRow = useCallback((id) => {
    setEnvRows((rows) => rows.filter((r) => r.id !== id));
  }, []);

  const updateEnvRow = useCallback((id, patch) => {
    setEnvRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }, []);

  const toggleEnvValueVisible = useCallback((id) => {
    setVisibleEnvIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const addAllowlistUser = useCallback(() => {
    const username = allowlistDraft.trim();
    if (!username) return;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(username)) {
      setAllowlistErr("用户名须以字母开头，仅可使用字母、数字、下划线与连字符，最多 64 字符");
      return;
    }
    const exists = new Set(allowlistFileUsers.map((item) => String(item || "").trim().toLowerCase()));
    if (exists.has(username.toLowerCase())) {
      setAllowlistDraft("");
      return;
    }
    setAllowlistDraft("");
    void saveUserAllowlist([...allowlistFileUsers, username]);
  }, [allowlistDraft, allowlistFileUsers, saveUserAllowlist]);

  const removeAllowlistUser = useCallback((username) => {
    const target = String(username || "").trim().toLowerCase();
    if (!target) return;
    void saveUserAllowlist(allowlistFileUsers.filter((item) => String(item || "").trim().toLowerCase() !== target));
  }, [allowlistFileUsers, saveUserAllowlist]);

  const handleLanguageChange = useCallback((e) => {
    const newLang = e.target.value;
    changeLanguage(newLang);
  }, []);

  

  const getFetchedAtText = (iso) => {
    const formatted = formatFetchedAt(iso, currentLang);
    if (!formatted) return t("settings:cursor.modelList.never");
    return t("settings:cursor.modelList.fetchedAt", { time: formatted });
  };

  const formatFeedbackTime = (iso) => {
    const formatted = formatFetchedAt(iso, currentLang);
    return formatted || String(iso || "");
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
            {envErr ? <p className="af-err af-settings-api-hint">{envErr}</p> : null}
            {storageErr ? <p className="af-err af-settings-api-hint">{storageErr}</p> : null}
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
                  <span className="af-set-env-note">
                    {envSaving ? t("settings:env.saving") : authUser?.isAdmin ? t("settings:env.noteAdmin") : t("settings:env.note")}
                  </span>
                </div>

                <div className={"af-set-env-rows" + (authUser?.isAdmin ? " af-set-env-rows--admin" : "")}>
                  <div className="af-set-env-row af-set-env-row--header" aria-hidden>
                    <span>{t("settings:env.key")}</span>
                    {authUser?.isAdmin ? <span>{t("settings:env.scope")}</span> : null}
                    <span>{t("settings:env.value")}</span>
                    <span></span>
                  </div>
                  {envRows.map((row) => (
                    <div key={row.id} className={"af-set-env-row" + (authUser?.isAdmin ? " af-set-env-row--scoped" : "")}>
                      <div className="af-set-env-cell">
                        <input
                          className="af-set-env-inline af-set-env-inline--key"
                          value={row.key}
                          onChange={(e) => updateEnvRow(row.id, { key: e.target.value })}
                          aria-label={t("settings:env.key")}
                          spellCheck={false}
                        />
                      </div>
                      {authUser?.isAdmin ? (
                        <div className="af-set-env-cell af-set-env-cell--scope">
                          <div className="af-set-env-scope-switch" role="group" aria-label={t("settings:env.scope")}>
                            <button
                              type="button"
                              className={row.scope !== "global" ? "is-active" : ""}
                              onClick={() => updateEnvRow(row.id, { scope: "user" })}
                            >
                              {t("settings:env.personal")}
                            </button>
                            <button
                              type="button"
                              className={row.scope === "global" ? "is-active" : ""}
                              onClick={() => updateEnvRow(row.id, { scope: "global" })}
                            >
                              {t("settings:env.global")}
                            </button>
                          </div>
                        </div>
                      ) : null}
                      <div className="af-set-env-cell af-set-env-cell--grow af-set-env-cell--value">
                        <input
                          className="af-set-env-inline af-set-env-inline--value"
                          type={visibleEnvIds.has(row.id) ? "text" : "password"}
                          value={row.value}
                          onChange={(e) => updateEnvRow(row.id, { value: e.target.value })}
                          placeholder={maskValue(row.value) || t("settings:env.newValue")}
                          aria-label={t("settings:env.value")}
                        />
                        <button
                          type="button"
                          className="af-set-env-value-toggle"
                          onClick={() => toggleEnvValueVisible(row.id)}
                          aria-label={visibleEnvIds.has(row.id) ? "Hide value" : "Show value"}
                        >
                          <span className="material-symbols-outlined">{visibleEnvIds.has(row.id) ? "visibility_off" : "visibility"}</span>
                        </button>
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

                  <div className={"af-set-env-row af-set-env-row--draft" + (authUser?.isAdmin ? " af-set-env-row--scoped" : "")}>
                    <div className="af-set-env-cell">
                      <input
                        className="af-set-env-inline af-set-env-inline--key"
                        placeholder="KEY_NAME"
                        value={draftKey}
                        onChange={(e) => setDraftKey(e.target.value)}
                        aria-label={t("settings:env.newKey")}
                      />
                    </div>
                    {authUser?.isAdmin ? (
                      <div className="af-set-env-cell af-set-env-cell--scope">
                        <div className="af-set-env-scope-switch" role="group" aria-label={t("settings:env.scope")}>
                          <button
                            type="button"
                            className={!draftGlobal ? "is-active" : ""}
                            onClick={() => setDraftGlobal(false)}
                          >
                            {t("settings:env.personal")}
                          </button>
                          <button
                            type="button"
                            className={draftGlobal ? "is-active" : ""}
                            onClick={() => setDraftGlobal(true)}
                          >
                            {t("settings:env.global")}
                          </button>
                        </div>
                      </div>
                    ) : null}
                    <div className="af-set-env-cell af-set-env-cell--grow af-set-env-cell--value">
                      <input
                        className="af-set-env-inline af-set-env-inline--value"
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

              {authUser?.isAdmin ? (
                <section className="af-set-card af-set-card--wide af-set-card--low">
                  <div className="af-set-env-head">
                    <div className="af-set-card-head">
                      <div className="af-set-env-icon-wrap">
                        <span className="material-symbols-outlined af-set-icon--primary">hard_drive_2</span>
                      </div>
                      <div>
                        <h2 className="af-set-h2">AgentFlow Data Root</h2>
                        <p className="af-set-card-subtitle">配置整个 AgentFlow 数据目录的位置，保存时会迁移当前数据。</p>
                      </div>
                    </div>
                    <span className={"af-set-badge" + (dataRootConfig?.envLocked ? " af-set-badge--err" : " af-set-badge--ok")}>
                      {dataRootConfig?.envLocked ? "Env locked" : "Configurable"}
                    </span>
                    <button
                      type="button"
                      className="af-set-btn-outline af-set-btn-outline--compact"
                      onClick={() => void loadStorageConfig()}
                      disabled={storageLoading || storageSaving}
                    >
                      {storageLoading ? "刷新中..." : "刷新"}
                    </button>
                  </div>
                  {storageErr ? <p className="af-err af-set-hint af-set-hint--inline">{storageErr}</p> : null}
                  <label className="af-set-label-sm" htmlFor="af-agentflow-data-root">
                    Data Root
                  </label>
                  <div className="af-set-input-wrap">
                    <input
                      id="af-agentflow-data-root"
                      className="af-set-input af-set-input--mono"
                      type="text"
                      value={dataRootDraft}
                      onChange={(e) => setDataRootDraft(e.target.value)}
                      placeholder="/data1/services/mengmai/agentflow"
                      autoComplete="off"
                      disabled={Boolean(dataRootConfig?.envLocked) || storageSaving}
                    />
                    <button
                      type="button"
                      className="af-set-input-suffix"
                      onClick={() => void saveStorageConfig()}
                      aria-label="保存 AgentFlow Data Root"
                      disabled={storageSaving || Boolean(dataRootConfig?.envLocked)}
                    >
                      <span className="material-symbols-outlined">{storageSaving ? "hourglass_empty" : "save"}</span>
                    </button>
                  </div>
                  <p className="af-set-hint">
                    当前目录：<code>{dataRootConfig?.dataRoot || dataRootDraft || "-"}</code>
                    {dataRootConfig?.configPath ? <>；配置文件：<code>{dataRootConfig.configPath}</code></> : null}
                  </p>
                  <p className="af-set-hint">
                    这个目录包含 <code>users/</code>、<code>pipelines/</code>、<code>runBuild/</code>、<code>auth/</code> 和 admin 配置。
                    保存到新绝对路径时会复制旧目录内容；旧目录不会自动删除。
                    {dataRootConfig?.envLocked ? " 当前设置了 AGENTFLOW_HOME，需要改环境变量才能生效。" : ""}
                  </p>
                </section>
              ) : null}

              {authUser?.isAdmin ? (
                <section className="af-set-card af-set-card--wide af-set-card--allowlist">
                  <div className="af-set-env-head">
                    <div className="af-set-card-head">
                      <div className="af-set-env-icon-wrap">
                        <span className="material-symbols-outlined af-set-icon--primary">manage_accounts</span>
                      </div>
                      <div>
                        <h2 className="af-set-h2">{t("settings:allowlist.title")}</h2>
                        <p className="af-set-card-subtitle">{t("settings:allowlist.description")}</p>
                      </div>
                    </div>
                    <span className={"af-set-badge" + (allowlistEnabled ? " af-set-badge--ok" : " af-set-badge--muted")}>
                      {allowlistEnabled ? t("settings:allowlist.enabled") : t("settings:allowlist.open")}
                    </span>
                    <button
                      type="button"
                      className="af-set-btn-outline af-set-btn-outline--compact"
                      onClick={() => void loadUserAllowlist()}
                      disabled={allowlistLoading}
                    >
                      {allowlistLoading ? t("settings:allowlist.refreshing") : t("common:common.refresh")}
                    </button>
                  </div>
                  {allowlistErr ? <p className="af-err af-set-hint af-set-hint--inline">{allowlistErr}</p> : null}
                  {allowlistPath ? <p className="af-set-hint af-set-hint--inline">{t("settings:allowlist.file")}：<code>{allowlistPath}</code></p> : null}
                  <div className="af-allowlist-grid">
                    <div className="af-allowlist-main">
                      <div className="af-allowlist-head">
                        <span>{t("settings:allowlist.fileList")}</span>
                        <span>{allowlistSaving ? t("settings:allowlist.saving") : t("settings:allowlist.userCount", { count: allowlistFileUsers.length })}</span>
                      </div>
                      <div className="af-allowlist-list">
                        {allowlistFileUsers.length > 0 ? allowlistFileUsers.map((username) => (
                          <div key={username} className="af-allowlist-row">
                            <span className="af-allowlist-name">{username}</span>
                            <button
                              type="button"
                              className="af-set-env-del"
                              onClick={() => removeAllowlistUser(username)}
                              aria-label={t("settings:allowlist.remove", { username })}
                              disabled={allowlistSaving}
                            >
                              <span className="material-symbols-outlined">delete_outline</span>
                            </button>
                          </div>
                        )) : (
                          <div className="af-allowlist-empty">{t("settings:allowlist.emptyFile")}</div>
                        )}
                      </div>
                      <div className="af-allowlist-add">
                        <input
                          className="af-set-input af-set-input--sm af-set-input--mono"
                          value={allowlistDraft}
                          onChange={(e) => setAllowlistDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") addAllowlistUser();
                          }}
                          placeholder="username"
                          autoComplete="off"
                        />
                        <button
                          type="button"
                          className="af-set-btn-add"
                          onClick={addAllowlistUser}
                          disabled={allowlistSaving || !allowlistDraft.trim()}
                        >
                          <span className="material-symbols-outlined">add</span>
                          {t("settings:allowlist.add")}
                        </button>
                      </div>
                    </div>
                    <div className="af-allowlist-side">
                      <div className="af-allowlist-head">
                        <span>{t("settings:allowlist.envList")}</span>
                        <span>{t("settings:allowlist.readonly")}</span>
                      </div>
                      <div className="af-allowlist-env-list">
                        {allowlistEnvUsers.length > 0 ? allowlistEnvUsers.map((username) => (
                          <code key={username}>{username}</code>
                        )) : (
                          <span>{t("settings:allowlist.emptyEnv")}</span>
                        )}
                      </div>
                      <p className="af-set-hint af-set-hint--inline">{t("settings:allowlist.unionHint")}</p>
                    </div>
                  </div>
                </section>
              ) : null}

              {authUser?.isAdmin ? (
                <section className="af-set-card af-set-card--wide af-set-card--feedback">
                  <div className="af-set-env-head">
                    <div className="af-set-card-head">
                      <div className="af-set-env-icon-wrap">
                        <span className="material-symbols-outlined af-set-icon--primary">rate_review</span>
                      </div>
                      <h2 className="af-set-h2">意见反馈</h2>
                    </div>
                    <button
                      type="button"
                      className="af-set-btn-outline af-set-btn-outline--compact"
                      onClick={() => void loadFeedback()}
                      disabled={feedbackLoading}
                    >
                      {feedbackLoading ? "刷新中..." : "刷新"}
                    </button>
                  </div>
                  {feedbackErr ? <p className="af-err af-set-hint af-set-hint--inline">{feedbackErr}</p> : null}
                  <div className="af-feedback-list">
                    {feedbackItems.length > 0 ? feedbackItems.map((item) => (
                      <article key={item.id} className="af-feedback-item">
                        <header className="af-feedback-item__head">
                          <div>
                            <h3>{item.title || "未命名反馈"}</h3>
                            <p>
                              <span>{item.username || item.userId || "unknown"}</span>
                              <span>{formatFeedbackTime(item.createdAt)}</span>
                            </p>
                          </div>
                          {item.contact ? <span className="af-feedback-item__contact">{item.contact}</span> : null}
                        </header>
                        <p className="af-feedback-item__content">{item.content}</p>
                        {item.pageUrl ? <code className="af-feedback-item__url">{item.pageUrl}</code> : null}
                      </article>
                    )) : (
                      <div className="af-feedback-empty">
                        {feedbackLoading ? "正在加载反馈..." : "暂无反馈"}
                      </div>
                    )}
                  </div>
                </section>
              ) : null}
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
