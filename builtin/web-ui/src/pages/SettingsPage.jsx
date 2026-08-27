import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES, changeLanguage } from "../i18n";

/** 与服务器 config.json 同步的本地缓存（离线时回退） */
const OPCODE_PLAN_KEY = "agentflow-settings-opencode-plan-v1";
const CURSOR_API_KEYS_ENV = "CURSOR_API_KEYS";
const CURSOR_API_KEY_COOLDOWN_ENV = "AGENTFLOW_CURSOR_API_KEY_COOLDOWN_MINUTES";
const CURSOR_API_KEY_RESOURCE_COOLDOWN_ENV = "AGENTFLOW_CURSOR_API_KEY_RESOURCE_EXHAUSTED_COOLDOWN_MINUTES";
const ADMIN_ONLY_ENV_KEYS = new Set([
  CURSOR_API_KEYS_ENV,
  CURSOR_API_KEY_COOLDOWN_ENV,
  CURSOR_API_KEY_RESOURCE_COOLDOWN_ENV,
  "CURSOR_API_KEY_COOLDOWN_MINUTES",
]);
const MODEL_LIST_KEYS = ["cursor", "opencode", "claudeCode", "codex"];

function emptyModelListsPayload() {
  return {
    cursor: [],
    opencode: [],
    claudeCode: [],
    codex: [],
    cursorFetchedAt: null,
    opencodeFetchedAt: null,
    claudeCodeFetchedAt: null,
    codexFetchedAt: null,
  };
}

function modelEntryId(entry) {
  const text = String(entry || "").trim();
  const idx = text.indexOf(" - ");
  return idx >= 0 ? text.slice(0, idx).trim() : text;
}

function normalizeHiddenModelsPayload(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const key of MODEL_LIST_KEYS) {
    out[key] = Array.isArray(src[key])
      ? [...new Set(src[key].map(modelEntryId).filter(Boolean))]
      : [];
  }
  return out;
}

/** @param {unknown} ml */
function normalizeModelListsPayload(ml) {
  if (!ml || typeof ml !== "object") {
    return emptyModelListsPayload();
  }
  const o = /** @type {{ cursor?: unknown, opencode?: unknown, claudeCode?: unknown, codex?: unknown, cursorFetchedAt?: unknown, opencodeFetchedAt?: unknown, claudeCodeFetchedAt?: unknown, codexFetchedAt?: unknown }} */ (ml);
  return {
    cursor: Array.isArray(o.cursor) ? o.cursor.map(String) : [],
    opencode: Array.isArray(o.opencode) ? o.opencode.map(String) : [],
    claudeCode: Array.isArray(o.claudeCode) ? o.claudeCode.map(String) : [],
    codex: Array.isArray(o.codex) ? o.codex.map(String) : [],
    cursorFetchedAt: o.cursorFetchedAt ?? null,
    opencodeFetchedAt: o.opencodeFetchedAt ?? null,
    claudeCodeFetchedAt: o.claudeCodeFetchedAt ?? null,
    codexFetchedAt: o.codexFetchedAt ?? null,
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

function parseCursorApiKeyRecords(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const normalizeRecord = (item, index) => {
    if (typeof item === "string") {
      const key = item.trim();
      if (!key) return null;
      return {
        id: `legacy_${index}_${key.slice(-6)}`,
        name: `Key ${index + 1}`,
        key,
        createdAt: "",
      };
    }
    if (!item || typeof item !== "object") return null;
    const key = String(item.key ?? "").trim();
    if (!key) return null;
    return {
      id: String(item.id ?? "").trim() || newId(),
      name: String(item.name ?? "").trim() || `Key ${index + 1}`,
      key,
      createdAt: String(item.createdAt ?? "").trim(),
    };
  };
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeRecord).filter(Boolean);
    }
  } catch (_) {}
  return text
    .split(",")
    .map((part, index) => normalizeRecord(part, index))
    .filter(Boolean);
}

function serializeCursorApiKeyRecords(records) {
  const clean = Array.isArray(records)
    ? records
        .map((item, index) => ({
          id: String(item?.id || "").trim() || newId(),
          name: String(item?.name || "").trim() || `Key ${index + 1}`,
          key: String(item?.key || "").trim(),
          createdAt: String(item?.createdAt || "").trim() || new Date().toISOString(),
        }))
        .filter((item) => item.key)
    : [];
  return JSON.stringify(clean);
}

function maskCursorApiKey(key) {
  const v = String(key || "").trim();
  if (!v) return "";
  if (v.length <= 10) return maskValue(v);
  return `${v.slice(0, 4)}${"•".repeat(Math.min(18, v.length - 8))}${v.slice(-4)}`;
}

function formatCursorCooldown(seconds) {
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.ceil(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function CursorApiKeyStatus({ status }) {
  if (!status || status.status === "loading") {
    return (
      <div className="af-set-cursor-runtime">
        <span className="af-set-cursor-runtime-badge is-loading">
          <span className="material-symbols-outlined">sync</span>
          状态同步中
        </span>
      </div>
    );
  }
  const cooling = status?.status === "cooling_down";
  const degraded = status?.degraded === true;
  const category = status?.errorCategory === "resource_exhausted" ? "资源耗尽" : "明确限额";
  const label = cooling ? `冷却中 · ${category}` : degraded ? `降级可用 · ${status.activeModelName || "Composer"}` : "Auto 可用";
  return (
    <div className="af-set-cursor-runtime">
      <span className={`af-set-cursor-runtime-badge ${cooling ? "is-cooling" : degraded ? "is-degraded" : "is-available"}`}>
        <span className="material-symbols-outlined">{cooling ? "schedule" : degraded ? "swap_horiz" : "check_circle"}</span>
        {label}
      </span>
      {cooling ? (
        <span className="af-set-cursor-runtime-detail">
          预计 {status.blockedUntil ? new Date(status.blockedUntil).toLocaleString() : "稍后"} 恢复（{formatCursorCooldown(status.remainingSeconds)}）
        </span>
      ) : null}
      {Array.isArray(status?.laneCooldowns) && status.laneCooldowns.length ? (
        <span className="af-set-cursor-runtime-detail">
          {status.laneCooldowns.map((lane) => `${lane.modelName} 冷却 ${formatCursorCooldown(lane.remainingSeconds)}`).join(" · ")}
        </span>
      ) : null}
      {status?.lastFailure?.errorPreview ? (
        <span className="af-set-cursor-runtime-error" title={status.lastFailure.errorPreview}>
          最近失败：{status.lastFailure.errorPreview}
        </span>
      ) : null}
    </div>
  );
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
    /** @type {{ cursor: string[], opencode: string[], claudeCode: string[], codex: string[], cursorFetchedAt: string | null, opencodeFetchedAt: string | null, claudeCodeFetchedAt: string | null, codexFetchedAt: string | null }} */ ({
      cursor: [],
      opencode: [],
      claudeCode: [],
      codex: [],
      cursorFetchedAt: null,
      opencodeFetchedAt: null,
      claudeCodeFetchedAt: null,
      codexFetchedAt: null,
    }),
  );
  const [allModelLists, setAllModelLists] = useState(emptyModelListsPayload());
  const [hiddenModels, setHiddenModels] = useState(() => normalizeHiddenModelsPayload({}));
  const [modelVisibilitySaving, setModelVisibilitySaving] = useState(false);
  const [modelVisibilityErr, setModelVisibilityErr] = useState("");
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
  const [cursorApiKeyName, setCursorApiKeyName] = useState("");
  const [cursorApiKeyValue, setCursorApiKeyValue] = useState("");
  const [cursorApiKeyGlobal, setCursorApiKeyGlobal] = useState(Boolean(authUser?.isAdmin));
  const [cursorApiKeyStatuses, setCursorApiKeyStatuses] = useState([]);
  const [cursorApiKeyStatusErr, setCursorApiKeyStatusErr] = useState("");
  const [cursorApiKeyTestingId, setCursorApiKeyTestingId] = useState("");
  const [cursorApiKeyReleasingId, setCursorApiKeyReleasingId] = useState("");
  const [cursorApiKeyTestResults, setCursorApiKeyTestResults] = useState({});
  const [opcodeDraft, setOpcodeDraft] = useState("");
  const [allowlistFileUsers, setAllowlistFileUsers] = useState([]);
  const [allowlistEnvUsers, setAllowlistEnvUsers] = useState([]);
  const [allowlistPath, setAllowlistPath] = useState("");
  const [allowlistDraft, setAllowlistDraft] = useState("");
  const [allowlistLoading, setAllowlistLoading] = useState(false);
  const [allowlistSaving, setAllowlistSaving] = useState(false);
  const [allowlistErr, setAllowlistErr] = useState("");
  const [authUsers, setAuthUsers] = useState([]);
  const [authUsersLoading, setAuthUsersLoading] = useState(false);
  const [authUsersErr, setAuthUsersErr] = useState("");
  const [passwordResetUserId, setPasswordResetUserId] = useState("");
  const [passwordResetDraft, setPasswordResetDraft] = useState("");
  const [passwordResetConfirm, setPasswordResetConfirm] = useState("");
  const [passwordResetSaving, setPasswordResetSaving] = useState(false);
  const [passwordResetMessage, setPasswordResetMessage] = useState("");
  const [dataRootDraft, setDataRootDraft] = useState("");
  const [skillsRootDraft, setSkillsRootDraft] = useState("");
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
    setModelVisibilityErr("");
    try {
      const r = await fetch(authUser?.isAdmin ? "/api/model-visibility" : "/api/model-lists");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (authUser?.isAdmin) {
        setModelLists(normalizeModelListsPayload(j.modelLists));
        setAllModelLists(normalizeModelListsPayload(j.allModelLists));
        setHiddenModels(normalizeHiddenModelsPayload(j.hiddenModels));
      } else {
        const normalized = normalizeModelListsPayload(j);
        setModelLists(normalized);
        setAllModelLists(normalized);
        setHiddenModels(normalizeHiddenModelsPayload({}));
      }
    } catch (e) {
      setListsErr(String(/** @type {{ message?: string }} */ (e).message || e));
    } finally {
      setListsLoading(false);
    }
  }, [authUser?.isAdmin]);

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

  const loadAuthUsers = useCallback(async () => {
    if (!authUser?.isAdmin) return;
    setAuthUsersLoading(true);
    setAuthUsersErr("");
    try {
      const r = await fetch("/api/admin/users");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      setAuthUsers(Array.isArray(j.users) ? j.users : []);
    } catch (e) {
      setAuthUsersErr(String(/** @type {{ message?: string }} */ (e).message || e));
    } finally {
      setAuthUsersLoading(false);
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
      setSkillsRootDraft(typeof config.skillsRoot === "string" ? config.skillsRoot : "");
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
        body: JSON.stringify({ dataRoot: dataRootDraft.trim(), skillsRoot: skillsRootDraft.trim(), migrateLegacySkills: true }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      const config = j.config && typeof j.config === "object" ? j.config : {};
      setDataRootConfig(config);
      setDataRootDraft(typeof config.dataRoot === "string" ? config.dataRoot : "");
      setSkillsRootDraft(typeof config.skillsRoot === "string" ? config.skillsRoot : "");
    } catch (e) {
      setStorageErr(String(/** @type {{ message?: string }} */ (e).message || e));
    } finally {
      setStorageSaving(false);
    }
  }, [authUser?.isAdmin, dataRootDraft, skillsRootDraft]);

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
      if (authUser?.isAdmin) {
        await loadLists();
      } else {
        setAllModelLists(normalizeModelListsPayload(j.modelLists));
      }
    } catch (e) {
      setListsErr(String(/** @type {{ message?: string }} */ (e).message || e));
    } finally {
      setListsLoading(false);
    }
  }, [authUser?.isAdmin, loadLists, opcodeDraft]);

  const saveHiddenModels = useCallback(async (nextHiddenModels) => {
    if (!authUser?.isAdmin) return;
    const normalizedHidden = normalizeHiddenModelsPayload(nextHiddenModels);
    setHiddenModels(normalizedHidden);
    setModelVisibilitySaving(true);
    setModelVisibilityErr("");
    try {
      const r = await fetch("/api/model-visibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiddenModels: normalizedHidden }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      setModelLists(normalizeModelListsPayload(j.modelLists));
      setAllModelLists(normalizeModelListsPayload(j.allModelLists));
      setHiddenModels(normalizeHiddenModelsPayload(j.hiddenModels));
    } catch (e) {
      setModelVisibilityErr(String(/** @type {{ message?: string }} */ (e).message || e));
      void loadLists();
    } finally {
      setModelVisibilitySaving(false);
    }
  }, [authUser?.isAdmin, loadLists]);

  const setModelVisible = useCallback((provider, entry, visible) => {
    const key = MODEL_LIST_KEYS.includes(provider) ? provider : "cursor";
    const id = modelEntryId(entry);
    if (!id) return;
    const current = normalizeHiddenModelsPayload(hiddenModels);
    const hiddenSet = new Set(current[key]);
    if (visible) hiddenSet.delete(id);
    else hiddenSet.add(id);
    void saveHiddenModels({ ...current, [key]: Array.from(hiddenSet) });
  }, [hiddenModels, saveHiddenModels]);

  useEffect(() => {
    loadUserEnv();
    if (authUser?.isAdmin) {
      void loadContext();
      void loadLists();
      void loadUserAllowlist();
      void loadAuthUsers();
      void loadStorageConfig();
      void (async () => {
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
    } else {
      setWorkspaceRoot("");
      opencodeConfigReady.current = false;
    }
  }, [authUser?.isAdmin, loadAuthUsers, loadContext, loadLists, loadStorageConfig, loadUserAllowlist, loadUserEnv]);

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
    if (!authUser?.isAdmin) return;
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
            if (authUser?.isAdmin) {
              void loadLists();
            } else {
              setAllModelLists(normalizeModelListsPayload(j.modelLists));
            }
          }
        } catch (e) {
          setOpencodeErr(String(/** @type {{ message?: string }} */ (e).message || e));
        } finally {
          setOpencodeSaving(false);
        }
      })();
    }, 450);
    return () => clearTimeout(t);
  }, [authUser?.isAdmin, loadLists, opcodeDraft]);

  const modelListSource = authUser?.isAdmin ? allModelLists : modelLists;
  const cursorReady = modelListSource.cursor.length > 0;
  const opencodeReady = modelListSource.opencode.length > 0;
  const claudeCodeReady = modelListSource.claudeCode.length > 0;
  const codexReady = modelListSource.codex.length > 0;
  const modelVisibilityHidden = normalizeHiddenModelsPayload(hiddenModels);
  const modelVisibleCounts = {
    cursor: modelLists.cursor.length,
    opencode: modelLists.opencode.length,
    claudeCode: modelLists.claudeCode.length,
    codex: modelLists.codex.length,
  };
  const renderModelListPreview = useCallback((provider, entries, ariaLabel) => {
    const list = Array.isArray(entries) ? entries : [];
    if (!authUser?.isAdmin) {
      return (
        <pre className="af-set-model-preview" aria-label={ariaLabel}>
          {list.join("\n")}
        </pre>
      );
    }
    const hiddenSet = new Set(modelVisibilityHidden[provider] || []);
    return (
      <div className="af-set-model-visibility" aria-label={ariaLabel}>
        <div className="af-set-model-visibility-head">
          <span>展示 {modelVisibleCounts[provider] || 0} / {list.length}</span>
          <span>{modelVisibilitySaving ? "保存中" : "取消勾选后从模型下拉隐藏"}</span>
        </div>
        <div className="af-set-model-visibility-list">
          {list.map((entry) => {
            const id = modelEntryId(entry);
            const visible = !hiddenSet.has(id);
            return (
              <label key={`${provider}-${entry}`} className="af-set-model-visibility-row">
                <input
                  type="checkbox"
                  checked={visible}
                  disabled={modelVisibilitySaving}
                  onChange={(e) => setModelVisible(provider, entry, e.target.checked)}
                />
                <span>{entry}</span>
              </label>
            );
          })}
        </div>
      </div>
    );
  }, [authUser?.isAdmin, modelVisibilityHidden, modelVisibilitySaving, modelVisibleCounts, setModelVisible]);
  const allowlistEnabled = allowlistFileUsers.length > 0 || allowlistEnvUsers.length > 0;
  const visibleEnvRows = authUser?.isAdmin
    ? envRows
    : envRows.filter((row) => !ADMIN_ONLY_ENV_KEYS.has(String(row?.key || "").trim()));
  const cursorApiKeyScope = authUser?.isAdmin && cursorApiKeyGlobal ? "global" : "user";
  const cursorApiKeyRow = useMemo(() => envRows.find((row) => row.key === CURSOR_API_KEYS_ENV && (row.scope || "user") === cursorApiKeyScope) || null, [cursorApiKeyScope, envRows]);
  const cursorApiKeyRecords = useMemo(() => parseCursorApiKeyRecords(cursorApiKeyRow?.value || ""), [cursorApiKeyRow?.value]);
  const cursorCooldownRow = useMemo(() => envRows.find((row) => row.key === CURSOR_API_KEY_COOLDOWN_ENV && (row.scope || "user") === cursorApiKeyScope) || null, [cursorApiKeyScope, envRows]);
  const cursorCooldownMinutes = cursorCooldownRow?.value ? String(cursorCooldownRow.value) : "30";
  const cursorResourceCooldownRow = useMemo(() => envRows.find((row) => row.key === CURSOR_API_KEY_RESOURCE_COOLDOWN_ENV && (row.scope || "user") === cursorApiKeyScope) || null, [cursorApiKeyScope, envRows]);
  const cursorResourceCooldownMinutes = cursorResourceCooldownRow?.value ? String(cursorResourceCooldownRow.value) : "3";
  const cursorApiKeyStatusMap = useMemo(() => new Map(cursorApiKeyStatuses.map((item) => [item.id, item])), [cursorApiKeyStatuses]);
  const cursorAvailableCount = cursorApiKeyRecords.filter((record) => cursorApiKeyStatusMap.get(record.id)?.status === "available").length;
  const cursorCoolingCount = cursorApiKeyRecords.filter((record) => cursorApiKeyStatusMap.get(record.id)?.status === "cooling_down").length;
  const cursorUnknownCount = Math.max(0, cursorApiKeyRecords.length - cursorAvailableCount - cursorCoolingCount);

  const loadCursorApiKeyStatuses = useCallback(async () => {
    if (!authUser?.isAdmin) return;
    try {
      const r = await fetch(`/api/admin/cursor-api-keys/status?scope=${encodeURIComponent(cursorApiKeyScope)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : `HTTP ${r.status}`);
      setCursorApiKeyStatuses(Array.isArray(j.keys) ? j.keys : []);
      setCursorApiKeyStatusErr("");
    } catch (e) {
      setCursorApiKeyStatusErr(String(e?.message || e));
    }
  }, [authUser?.isAdmin, cursorApiKeyScope]);

  useEffect(() => {
    if (!authUser?.isAdmin) return undefined;
    setCursorApiKeyStatuses([]);
    setCursorApiKeyTestResults({});
    void loadCursorApiKeyStatuses();
    const timer = window.setInterval(() => void loadCursorApiKeyStatuses(), 10_000);
    return () => window.clearInterval(timer);
  }, [authUser?.isAdmin, cursorApiKeyRow?.value, loadCursorApiKeyStatuses]);

  const setScopedEnvValue = useCallback((key, value, scope) => {
    const cleanKey = String(key || "").trim();
    if (!cleanKey) return;
    const cleanValue = String(value ?? "");
    setEnvRows((rows) => {
      const existing = rows.find((row) => row.key === cleanKey && (row.scope || "user") === scope);
      if (!cleanValue) {
        return rows.filter((row) => !(row.key === cleanKey && (row.scope || "user") === scope));
      }
      if (existing) {
        return rows.map((row) => (row.id === existing.id ? { ...row, value: cleanValue, scope } : row));
      }
      return [{ id: newId(), key: cleanKey, value: cleanValue, scope }, ...rows];
    });
  }, []);

  const addCursorApiKey = useCallback(() => {
    const key = cursorApiKeyValue.trim();
    if (!key) return;
    const nextRecords = [
      ...cursorApiKeyRecords,
      {
        id: newId(),
        name: cursorApiKeyName.trim() || `Key ${cursorApiKeyRecords.length + 1}`,
        key,
        createdAt: new Date().toISOString(),
      },
    ];
    setScopedEnvValue(CURSOR_API_KEYS_ENV, serializeCursorApiKeyRecords(nextRecords), cursorApiKeyScope);
    setCursorApiKeyName("");
    setCursorApiKeyValue("");
  }, [cursorApiKeyName, cursorApiKeyRecords, cursorApiKeyScope, cursorApiKeyValue, setScopedEnvValue]);

  const removeCursorApiKey = useCallback((id) => {
    const nextRecords = cursorApiKeyRecords.filter((record) => record.id !== id);
    setScopedEnvValue(CURSOR_API_KEYS_ENV, nextRecords.length ? serializeCursorApiKeyRecords(nextRecords) : "", cursorApiKeyScope);
  }, [cursorApiKeyRecords, cursorApiKeyScope, setScopedEnvValue]);

  const updateCursorCooldownMinutes = useCallback((envKey, value, fallback = 30) => {
    const raw = String(value || "").replace(/[^\d]/g, "");
    if (!raw) {
      setScopedEnvValue(envKey, "", cursorApiKeyScope);
      return;
    }
    const minutes = Math.min(1440, Math.max(1, Number(raw) || fallback));
    setScopedEnvValue(envKey, String(minutes), cursorApiKeyScope);
  }, [cursorApiKeyScope, setScopedEnvValue]);

  const testCursorApiKey = useCallback(async (record) => {
    if (!authUser?.isAdmin || !record?.id || cursorApiKeyTestingId) return;
    setCursorApiKeyTestingId(record.id);
    setCursorApiKeyStatusErr("");
    try {
      const r = await fetch("/api/admin/cursor-api-keys/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: record.id, scope: cursorApiKeyScope }),
      });
      const j = await r.json().catch(() => ({}));
      if (Array.isArray(j.keys)) setCursorApiKeyStatuses(j.keys);
      if (j.result) {
        setCursorApiKeyTestResults((results) => ({ ...results, [record.id]: j.result }));
      }
      if (!r.ok && !j.result) throw new Error(typeof j.error === "string" ? j.error : `HTTP ${r.status}`);
    } catch (e) {
      setCursorApiKeyStatusErr(String(e?.message || e));
    } finally {
      setCursorApiKeyTestingId("");
    }
  }, [authUser?.isAdmin, cursorApiKeyScope, cursorApiKeyTestingId]);

  const releaseCursorApiKeyCooldown = useCallback(async (record) => {
    if (!authUser?.isAdmin || !record?.id || cursorApiKeyReleasingId) return;
    setCursorApiKeyReleasingId(record.id);
    setCursorApiKeyStatusErr("");
    try {
      const r = await fetch("/api/admin/cursor-api-keys/cooldown", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: record.id, scope: cursorApiKeyScope }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : `HTTP ${r.status}`);
      setCursorApiKeyStatuses(Array.isArray(j.keys) ? j.keys : []);
    } catch (e) {
      setCursorApiKeyStatusErr(String(e?.message || e));
    } finally {
      setCursorApiKeyReleasingId("");
    }
  }, [authUser?.isAdmin, cursorApiKeyReleasingId, cursorApiKeyScope]);

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
    if (!authUser?.isAdmin && ADMIN_ONLY_ENV_KEYS.has(k)) {
      setEnvErr("该运行基础设施变量仅管理员可配置。");
      return;
    }
    setEnvRows((rows) => [{ id: newId(), key: k, value: v, scope: authUser?.isAdmin && draftGlobal ? "global" : "user" }, ...rows]);
    setDraftKey("");
    setDraftVal("");
  }, [authUser?.isAdmin, draftGlobal, draftKey, draftVal, t]);

  const removeEnvRow = useCallback((id) => {
    setEnvRows((rows) => rows.filter((r) => r.id !== id));
  }, []);

  const updateEnvRow = useCallback((id, patch) => {
    const nextKey = String(patch?.key || "").trim();
    if (!authUser?.isAdmin && nextKey && ADMIN_ONLY_ENV_KEYS.has(nextKey)) {
      setEnvErr("该运行基础设施变量仅管理员可配置。");
      return;
    }
    setEnvRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }, [authUser?.isAdmin]);

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

  const beginPasswordReset = useCallback((userId) => {
    setPasswordResetUserId(String(userId || ""));
    setPasswordResetDraft("");
    setPasswordResetConfirm("");
    setPasswordResetMessage("");
    setAuthUsersErr("");
  }, []);

  const cancelPasswordReset = useCallback(() => {
    setPasswordResetUserId("");
    setPasswordResetDraft("");
    setPasswordResetConfirm("");
  }, []);

  const submitPasswordReset = useCallback(async (event) => {
    event.preventDefault();
    if (!passwordResetUserId || passwordResetSaving) return;
    if (passwordResetDraft.length < 4) {
      setAuthUsersErr(t("settings:accounts.passwordTooShort"));
      return;
    }
    if (passwordResetDraft !== passwordResetConfirm) {
      setAuthUsersErr(t("settings:accounts.passwordMismatch"));
      return;
    }
    setPasswordResetSaving(true);
    setAuthUsersErr("");
    setPasswordResetMessage("");
    try {
      const r = await fetch("/api/admin/users/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: passwordResetUserId, password: passwordResetDraft }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      const username = String(j.user?.username || passwordResetUserId);
      setPasswordResetMessage(t("settings:accounts.resetSuccess", { username }));
      cancelPasswordReset();
      await loadAuthUsers();
    } catch (e) {
      setAuthUsersErr(String(/** @type {{ message?: string }} */ (e).message || e));
    } finally {
      setPasswordResetSaving(false);
    }
  }, [cancelPasswordReset, loadAuthUsers, passwordResetConfirm, passwordResetDraft, passwordResetSaving, passwordResetUserId, t]);

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
              {authUser?.isAdmin ? t("settings:workspace.description") : t("settings:env.note")}
            </p>
            {authUser?.isAdmin && contextErr ? <p className="af-err af-settings-api-hint">{contextErr}</p> : null}
            {authUser?.isAdmin && listsErr ? <p className="af-err af-settings-api-hint">{listsErr}</p> : null}
            {envErr ? <p className="af-err af-settings-api-hint">{envErr}</p> : null}
            {storageErr ? <p className="af-err af-settings-api-hint">{storageErr}</p> : null}
          </header>

          <div className="af-settings-layout">
            <div className="af-settings-bento">
              {authUser?.isAdmin ? (
                <>
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
                  <p className="af-set-hint">当前页面只展示运行时根目录。可被节点加载的代码库和文档目录请在左侧“知识库”里维护。</p>
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
                            (authUser?.isAdmin ? ` / ${modelListSource.cursor.length}` : "") +
                            " · " +
                            getFetchedAtText(modelLists.cursorFetchedAt)
                        : t("settings:cursor.modelList.refresh")}
                    </p>
                  </div>
                </div>
                {cursorReady ? renderModelListPreview("cursor", modelListSource.cursor, t("settings:cursor.modelPreviewLabel")) : null}
                {modelVisibilityErr ? (
                  <p className="af-err af-set-hint af-set-hint--inline" role="alert">
                    {modelVisibilityErr}
                  </p>
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

              <section className="af-set-card af-set-card--wide af-set-card--low af-set-cursor-pool">
                <div className="af-set-env-head">
                  <div className="af-set-card-head">
                    <div className="af-set-env-icon-wrap">
                      <span className="material-symbols-outlined af-set-icon--primary">key</span>
                    </div>
                    <div>
                      <h2 className="af-set-h2">Cursor API Key 池</h2>
                      <p className="af-set-card-subtitle">Auto 明确用量耗尽时，优先在同一 Key 动态切换可用 Composer；其他限流会冷却当前 Key 并尝试下一个。</p>
                    </div>
                  </div>
                  <div className="af-set-cursor-summary" aria-label="Cursor API Key 状态汇总">
                    <span className="af-set-badge af-set-badge--muted">共 {cursorApiKeyRecords.length}</span>
                    <span className="af-set-badge af-set-badge--ok">可用 {cursorAvailableCount}</span>
                    {cursorCoolingCount ? <span className="af-set-badge af-set-cursor-summary-cooling">冷却 {cursorCoolingCount}</span> : null}
                    {cursorUnknownCount ? <span className="af-set-badge af-set-badge--muted">同步中 {cursorUnknownCount}</span> : null}
                  </div>
                </div>

                <div className="af-set-cursor-pool-controls">
                  {authUser?.isAdmin ? (
                    <div className="af-set-env-scope-switch af-set-cursor-scope" role="group" aria-label="Cursor API Key scope">
                      <button
                        type="button"
                        className={!cursorApiKeyGlobal ? "is-active" : ""}
                        onClick={() => setCursorApiKeyGlobal(false)}
                      >
                        个人
                      </button>
                      <button
                        type="button"
                        className={cursorApiKeyGlobal ? "is-active" : ""}
                        onClick={() => setCursorApiKeyGlobal(true)}
                      >
                        全局
                      </button>
                    </div>
                  ) : null}
                  <label className="af-set-cursor-cooldown">
                    <span>明确限额</span>
                    <input
                      className="af-set-input af-set-input--sm af-set-input--mono"
                      inputMode="numeric"
                      value={cursorCooldownMinutes}
                      onChange={(e) => updateCursorCooldownMinutes(CURSOR_API_KEY_COOLDOWN_ENV, e.target.value, 30)}
                    />
                    <span>分钟</span>
                  </label>
                  <label className="af-set-cursor-cooldown">
                    <span>资源耗尽</span>
                    <input
                      className="af-set-input af-set-input--sm af-set-input--mono"
                      inputMode="numeric"
                      value={cursorResourceCooldownMinutes}
                      onChange={(e) => updateCursorCooldownMinutes(CURSOR_API_KEY_RESOURCE_COOLDOWN_ENV, e.target.value, 3)}
                    />
                    <span>分钟</span>
                  </label>
                  <span className="af-set-env-note">{envSaving ? "保存中" : cursorApiKeyScope === "global" ? "全局配置" : "个人配置"}</span>
                </div>

                <div className="af-set-cursor-key-list">
                  {cursorApiKeyRecords.length ? cursorApiKeyRecords.map((record) => {
                    const status = cursorApiKeyStatusMap.get(record.id) || {
                      id: record.id,
                      status: "loading",
                      laneCooldowns: [],
                    };
                    const testResult = cursorApiKeyTestResults[record.id];
                    return (
                      <div key={record.id} className="af-set-cursor-key-row">
                        <div className="af-set-cursor-key-main">
                          <strong>{record.name}</strong>
                          <code>{maskCursorApiKey(record.key)}</code>
                          <span className="af-set-cursor-key-meta">
                            创建于 {record.createdAt ? new Date(record.createdAt).toLocaleString() : "历史配置"}
                            {status.lastUsedAt ? ` · 最近使用 ${new Date(status.lastUsedAt).toLocaleString()}` : " · 尚未使用"}
                          </span>
                        </div>
                        <CursorApiKeyStatus status={status} />
                        <div className="af-set-cursor-key-actions">
                          <button
                            type="button"
                            className="af-set-cursor-action"
                            disabled={Boolean(cursorApiKeyTestingId)}
                            onClick={() => void testCursorApiKey(record)}
                          >
                            <span className="material-symbols-outlined">network_check</span>
                            {cursorApiKeyTestingId === record.id ? "测试中" : "测试"}
                          </button>
                          {status.status === "cooling_down" ? (
                            <button
                              type="button"
                              className="af-set-cursor-action"
                              disabled={Boolean(cursorApiKeyReleasingId)}
                              onClick={() => void releaseCursorApiKeyCooldown(record)}
                            >
                              <span className="material-symbols-outlined">restart_alt</span>
                              {cursorApiKeyReleasingId === record.id ? "解除中" : "解除冷却"}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="af-set-env-del af-set-cursor-key-delete"
                            aria-label={`删除 ${record.name}`}
                            onClick={() => removeCursorApiKey(record.id)}
                          >
                            <span className="material-symbols-outlined">delete_outline</span>
                          </button>
                        </div>
                        {testResult ? (
                          <div className={`af-set-cursor-test-result ${testResult.success ? "is-success" : "is-error"}`}>
                            <span className="material-symbols-outlined">{testResult.success ? "check_circle" : "error"}</span>
                            <span>
                              {testResult.success ? "测试成功" : "测试失败"} · {(Number(testResult.durationMs || 0) / 1000).toFixed(1)}s
                              {testResult.modelName ? ` · ${testResult.modelName}` : ""}
                              {testResult.replyPreview ? ` · ${testResult.replyPreview}` : testResult.errorPreview ? ` · ${testResult.errorPreview}` : ""}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    );
                  }) : (
                    <div className="af-set-cursor-key-empty">还没有配置 Key。配置后 Cursor CLI runner 会自动轮换使用。</div>
                  )}
                </div>

                {cursorApiKeyStatusErr ? <p className="af-err af-set-hint af-set-hint--inline" role="alert">{cursorApiKeyStatusErr}</p> : null}

                <div className="af-set-cursor-key-add">
                  <input
                    className="af-set-input"
                    value={cursorApiKeyName}
                    onChange={(e) => setCursorApiKeyName(e.target.value)}
                    placeholder="名称，例如 Team Key 1"
                  />
                  <input
                    className="af-set-input af-set-input--mono"
                    type="password"
                    value={cursorApiKeyValue}
                    onChange={(e) => setCursorApiKeyValue(e.target.value)}
                    placeholder="Cursor API Key"
                  />
                  <button
                    type="button"
                    className="af-set-btn-add"
                    onClick={addCursorApiKey}
                    disabled={!cursorApiKeyValue.trim()}
                  >
                    <span className="material-symbols-outlined">add</span>
                    添加 Key
                  </button>
                </div>

                <p className="af-set-hint">
                  保存到 {CURSOR_API_KEYS_ENV}；明确限额与资源耗尽分别使用长、短冷却。状态每 10 秒刷新，个人配置会覆盖全局配置。
                </p>
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
                        (authUser?.isAdmin ? ` / ${modelListSource.opencode.length}` : "") +
                        " · " +
                        getFetchedAtText(modelLists.opencodeFetchedAt)}
                    </p>
                    {renderModelListPreview("opencode", modelListSource.opencode, t("settings:opencode.modelPreviewLabel"))}
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
                          (authUser?.isAdmin ? ` / ${modelListSource.claudeCode.length}` : "") +
                          " · " +
                          getFetchedAtText(modelLists.claudeCodeFetchedAt)
                        : t("settings:cursor.modelList.refresh")}
                    </p>
                  </div>
                </div>
                <p className="af-set-p">{t("settings:claudeCode.description")}</p>
                {claudeCodeReady ? renderModelListPreview("claudeCode", modelListSource.claudeCode, t("settings:claudeCode.modelPreviewLabel")) : null}
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
                  <h2 className="af-set-h2 af-set-h2--caps">{t("settings:codex.title")}</h2>
                  <span
                    className={
                      "af-set-badge" + (codexReady ? " af-set-badge--ok" : " af-set-badge--err")
                    }
                  >
                    {codexReady ? t("settings:codex.status.ready") : t("settings:codex.status.notFound")}
                  </span>
                </div>
                <div className="af-set-cli-block">
                  <div className="af-set-cli-icon">
                    <span className="material-symbols-outlined af-set-icon--tertiary">
                      {codexReady ? "check_circle" : "hourglass_empty"}
                    </span>
                  </div>
                  <div>
                    <p className="af-set-cli-title">
                      {codexReady
                        ? t("settings:cursor.modelList.cached")
                        : t("settings:cursor.modelList.empty")}
                    </p>
                    <p className="af-set-cli-mono">
                      {codexReady
                        ? t("settings:cursor.modelList.count", { count: modelLists.codex.length }) +
                          (authUser?.isAdmin ? ` / ${modelListSource.codex.length}` : "") +
                          " · " +
                          getFetchedAtText(modelLists.codexFetchedAt)
                        : t("settings:cursor.modelList.refresh")}
                    </p>
                  </div>
                </div>
                <p className="af-set-p">{t("settings:codex.description")}</p>
                {codexReady ? renderModelListPreview("codex", modelListSource.codex, t("settings:codex.modelPreviewLabel")) : null}
                <button
                  type="button"
                  className="af-set-btn-outline"
                  onClick={() => refreshModelLists()}
                  disabled={listsLoading}
                >
                  {listsLoading ? t("settings:cursor.modelList.fetching") : t("settings:cursor.modelList.refresh")}
                </button>
              </section>
                </>
              ) : null}

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

                  {visibleEnvRows.map((row) => (
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
                  <label className="af-set-label-sm" htmlFor="af-agentflow-skills-root">
                    Skills Root
                  </label>
                  <div className="af-set-input-wrap">
                    <input
                      id="af-agentflow-skills-root"
                      className="af-set-input af-set-input--mono"
                      type="text"
                      value={skillsRootDraft}
                      onChange={(e) => setSkillsRootDraft(e.target.value)}
                      placeholder="/data1/services/mengmai/agentflow/skills"
                      autoComplete="off"
                      disabled={Boolean(dataRootConfig?.skillsEnvLocked) || storageSaving}
                    />
                    <button
                      type="button"
                      className="af-set-input-suffix"
                      onClick={() => void saveStorageConfig()}
                      aria-label="保存 AgentFlow Skills Root"
                      disabled={storageSaving || Boolean(dataRootConfig?.skillsEnvLocked)}
                    >
                      <span className="material-symbols-outlined">{storageSaving ? "hourglass_empty" : "save"}</span>
                    </button>
                  </div>
                  <p className="af-set-hint">
                    当前 Skills：<code>{dataRootConfig?.skillsRoot || skillsRootDraft || "-"}</code>
                    {dataRootConfig?.legacySkillsRootExists ? <>；保存时会补迁移旧目录 <code>{dataRootConfig.legacySkillsRoot}</code> 中缺失的 skills。</> : null}
                  </p>
                  <p className="af-set-hint">
                    SkillHub 新安装、更新和卸载都作用于 Skills Root；普通用户只通过 Workspace 的 Load Skills 使用。
                    {dataRootConfig?.skillsEnvLocked ? " 当前设置了 AGENTFLOW_SKILLS_ROOT，需要改环境变量才能生效。" : ""}
                  </p>
                </section>
              ) : null}

              {authUser?.isAdmin ? (
                <section className="af-set-card af-set-card--wide af-set-card--accounts">
                  <div className="af-set-env-head">
                    <div className="af-set-card-head">
                      <div className="af-set-env-icon-wrap">
                        <span className="material-symbols-outlined af-set-icon--primary">key</span>
                      </div>
                      <div>
                        <h2 className="af-set-h2">{t("settings:accounts.title")}</h2>
                        <p className="af-set-card-subtitle">{t("settings:accounts.description")}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="af-set-btn-outline af-set-btn-outline--compact"
                      onClick={() => void loadAuthUsers()}
                      disabled={authUsersLoading}
                    >
                      {authUsersLoading ? t("settings:accounts.refreshing") : t("common:common.refresh")}
                    </button>
                  </div>
                  {authUsersErr ? <p className="af-err af-set-hint af-set-hint--inline">{authUsersErr}</p> : null}
                  {passwordResetMessage ? <p className="af-set-account-success">{passwordResetMessage}</p> : null}
                  <div className="af-set-account-list">
                    {authUsers.map((user) => {
                      const isCurrent = user.userId === authUser?.userId;
                      const editing = user.userId === passwordResetUserId;
                      return (
                        <div key={user.userId} className={"af-set-account-row" + (editing ? " is-editing" : "")}>
                          <div className="af-set-account-main">
                            <strong>{user.username || user.userId}</strong>
                            <span>
                              <code>{user.userId}</code>
                              {user.isAdmin ? <em>{t("settings:accounts.admin")}</em> : null}
                              {!user.isAdmin ? <em>{user.authProvider === "cas" ? "CAS" : "旧密码"}</em> : null}
                              {isCurrent ? <em>{t("settings:accounts.current")}</em> : null}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="af-set-btn-outline af-set-btn-outline--compact"
                            onClick={() => beginPasswordReset(user.userId)}
                            disabled={isCurrent || user.authProvider === "cas" || passwordResetSaving}
                            title={user.authProvider === "cas" ? "CAS 用户没有本地密码" : isCurrent ? t("settings:accounts.selfResetDisabled") : t("settings:accounts.reset")}
                          >
                            {t("settings:accounts.reset")}
                          </button>
                          {editing ? (
                            <form className="af-set-password-reset" onSubmit={submitPasswordReset}>
                              <input
                                className="af-set-input af-set-input--sm"
                                type="password"
                                value={passwordResetDraft}
                                onChange={(event) => setPasswordResetDraft(event.target.value)}
                                placeholder={t("settings:accounts.newPassword")}
                                autoComplete="new-password"
                                autoFocus
                              />
                              <input
                                className="af-set-input af-set-input--sm"
                                type="password"
                                value={passwordResetConfirm}
                                onChange={(event) => setPasswordResetConfirm(event.target.value)}
                                placeholder={t("settings:accounts.confirmPassword")}
                                autoComplete="new-password"
                              />
                              <button type="button" className="af-set-btn-outline af-set-btn-outline--compact" onClick={cancelPasswordReset} disabled={passwordResetSaving}>
                                {t("common:common.cancel")}
                              </button>
                              <button type="submit" className="af-set-btn-add" disabled={passwordResetSaving || !passwordResetDraft || !passwordResetConfirm}>
                                {passwordResetSaving ? t("settings:accounts.saving") : t("settings:accounts.confirmReset")}
                              </button>
                            </form>
                          ) : null}
                        </div>
                      );
                    })}
                    {!authUsersLoading && authUsers.length === 0 ? <div className="af-allowlist-empty">{t("settings:accounts.empty")}</div> : null}
                  </div>
                  <p className="af-set-hint af-set-hint--inline">{t("settings:accounts.sessionHint")}</p>
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

              <section className="af-settings-rail" aria-label={t("settings:title")}>
              {authUser?.isAdmin ? (
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
                  <div className="af-set-meter">
                    <div className="af-set-meter-row">
                      <span>{t("settings:system.codexModels")}</span>
                      <span>{modelLists.codex.length}</span>
                    </div>
                    <div className="af-set-meter-bar">
                      <div
                        className="af-set-meter-fill"
                        style={{
                          width: `${Math.min(100, modelLists.codex.length > 0 ? 12 + modelLists.codex.length * 3 : 4)}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
                <div className="af-set-rail-watermark" aria-hidden>
                  <span className="material-symbols-outlined">vital_signs</span>
                </div>
              </div>
              ) : null}

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

              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
