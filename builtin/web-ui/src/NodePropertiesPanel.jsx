import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BodyPromptEditor } from "./BodyPromptEditor.jsx";
import { CodeDisplayContent } from "./displayRenderers.jsx";
import { VALID_ROLES } from "./flowFormat.js";

/** @type {RegExp} */
const NODE_INSTANCE_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

/** "composer-2-fast - Composer 2 Fast (default)" → "composer-2-fast" */
function modelEntryId(entry) {
  const idx = entry.indexOf(" - ");
  return idx >= 0 ? entry.slice(0, idx).trim() : entry.trim();
}

function reviewSources(snapshot) {
  return Array.isArray(snapshot?.sources) ? snapshot.sources : [];
}

function reviewSourceByPath(snapshot, sourcePath) {
  const sources = reviewSources(snapshot);
  if (sourcePath) return sources.find((source) => source.path === sourcePath) || null;
  return sources[0] || null;
}

function compactSha(value) {
  const text = String(value || "");
  return text ? text.slice(0, 12) : "";
}

function buildReviewDiff(beforeText, afterText) {
  const before = String(beforeText || "").replace(/\r\n/g, "\n").split("\n");
  const after = String(afterText || "").replace(/\r\n/g, "\n").split("\n");
  if (before.length * after.length > 120000) {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < before.length - prefix
      && suffix < after.length - prefix
      && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) suffix += 1;
    return [
      ...before.slice(0, prefix).map((text, index) => ({ type: "same", text, oldNumber: index + 1, newNumber: index + 1 })),
      ...before.slice(prefix, before.length - suffix).map((text, index) => ({ type: "remove", text, oldNumber: prefix + index + 1, newNumber: null })),
      ...after.slice(prefix, after.length - suffix).map((text, index) => ({ type: "add", text, oldNumber: null, newNumber: prefix + index + 1 })),
      ...after.slice(after.length - suffix).map((text, index) => ({
        type: "same",
        text,
        oldNumber: before.length - suffix + index + 1,
        newNumber: after.length - suffix + index + 1,
      })),
    ];
  }
  const rows = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
  for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = after.length - 1; newIndex >= 0; newIndex -= 1) {
      rows[oldIndex][newIndex] = before[oldIndex] === after[newIndex]
        ? rows[oldIndex + 1][newIndex + 1] + 1
        : Math.max(rows[oldIndex + 1][newIndex], rows[oldIndex][newIndex + 1]);
    }
  }
  const diff = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < before.length || newIndex < after.length) {
    if (oldIndex < before.length && newIndex < after.length && before[oldIndex] === after[newIndex]) {
      diff.push({ type: "same", text: before[oldIndex], oldNumber: oldIndex + 1, newNumber: newIndex + 1 });
      oldIndex += 1;
      newIndex += 1;
    } else if (newIndex < after.length && (oldIndex >= before.length || rows[oldIndex][newIndex + 1] >= rows[oldIndex + 1][newIndex])) {
      diff.push({ type: "add", text: after[newIndex], oldNumber: null, newNumber: newIndex + 1 });
      newIndex += 1;
    } else {
      diff.push({ type: "remove", text: before[oldIndex], oldNumber: oldIndex + 1, newNumber: null });
      oldIndex += 1;
    }
  }
  return diff;
}

function NodeExecutionReview({ review, loading, error, onReload }) {
  const [mode, setMode] = useState("draft");
  const [sourcePath, setSourcePath] = useState("");
  const [expanded, setExpanded] = useState(false);
  const draft = review?.draft || null;
  const stable = review?.stable || null;
  const availablePaths = useMemo(() => {
    const seen = new Set();
    return [...reviewSources(draft), ...reviewSources(stable)].filter((source) => {
      if (!source?.path || seen.has(source.path)) return false;
      seen.add(source.path);
      return true;
    });
  }, [draft, stable]);

  useEffect(() => {
    setMode("draft");
    setSourcePath("");
    setExpanded(false);
  }, [review?.nodeId]);

  useEffect(() => {
    if (!availablePaths.length) return;
    if (!availablePaths.some((source) => source.path === sourcePath)) setSourcePath(availablePaths[0].path);
  }, [availablePaths, sourcePath]);

  const draftSource = reviewSourceByPath(draft, sourcePath);
  const stableSource = reviewSourceByPath(stable, sourcePath);
  const activeSnapshot = mode === "stable" ? stable : draft;
  const activeSource = mode === "stable" ? stableSource : draftSource;
  const diff = useMemo(() => (
    mode === "diff" ? buildReviewDiff(stableSource?.content || "", draftSource?.content || "") : []
  ), [draftSource?.content, mode, stableSource?.content]);
  const contentChanged = Boolean(draftSource || stableSource) && draftSource?.sha256 !== stableSource?.sha256;

  const viewer = mode === "diff" ? (
    <div className="af-node-review-diff" role="table" aria-label="Draft 与 Stable 执行内容差异">
      {diff.map((line, index) => (
        <div className={`af-node-review-diff__line is-${line.type}`} role="row" key={`${line.type}-${line.oldNumber || 0}-${line.newNumber || 0}-${index}`}>
          <span>{line.oldNumber || ""}</span>
          <span>{line.newNumber || ""}</span>
          <strong>{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</strong>
          <code>{line.text || " "}</code>
        </div>
      ))}
    </div>
  ) : activeSource ? (
    <CodeDisplayContent
      content={activeSource.content}
      language={activeSource.language}
      fileName={activeSource.path}
      defaultWrap={activeSource.language === "markdown" || activeSource.language === "text"}
    />
  ) : (
    <div className="af-node-review-empty">当前版本没有这份执行内容。</div>
  );

  if (loading && !review) return <div className="af-node-review-empty">正在解析节点执行内容…</div>;
  return (
    <section className="af-node-review">
      <div className="af-node-review-summary">
        <div>
          <span className={`af-node-review-status${draft?.reviewable ? " is-reviewable" : " is-warning"}`}>
            <span className="material-symbols-outlined" aria-hidden>{draft?.reviewable ? "verified" : "warning"}</span>
            {draft?.reviewable ? "执行内容可审查" : "没有可解析的执行内容"}
          </span>
          <small>{draft?.definitionId || stable?.definitionId || review?.nodeId || "节点"}</small>
        </div>
        <button type="button" className="af-icon-btn" onClick={onReload} disabled={loading} title="重新解析">
          <span className="material-symbols-outlined" aria-hidden>refresh</span>
        </button>
      </div>
      {error ? <div className="af-node-review-error">{error}</div> : null}
      {[...(draft?.errors || []), ...(stable?.errors || [])].map((message, index) => (
        <div className="af-node-review-error" key={`${message}-${index}`}>{message}</div>
      ))}
      <div className="af-node-review-meta">
        {draft?.package ? <span>Package <code>{draft.package.id}@{draft.package.version}</code></span> : null}
        {draft?.package?.contentSha256 ? <span>SHA <code>{compactSha(draft.package.contentSha256)}</code></span> : null}
        {draft?.model ? <span>Model <code>{draft.model}</code></span> : null}
      </div>
      <div className="af-node-review-mode" role="tablist" aria-label="执行内容版本">
        <button type="button" className={mode === "draft" ? "is-active" : ""} onClick={() => setMode("draft")}>Draft</button>
        <button type="button" className={mode === "stable" ? "is-active" : ""} onClick={() => setMode("stable")} disabled={!stable}>
          {review?.stableReleaseId ? `Stable ${review.stableReleaseId}` : "Stable"}
        </button>
        <button type="button" className={mode === "diff" ? "is-active" : ""} onClick={() => setMode("diff")} disabled={!stable}>
          对比{stable && contentChanged ? " · 有变化" : ""}
        </button>
      </div>
      {availablePaths.length ? (
        <div className="af-node-review-files" aria-label="执行文件">
          {availablePaths.map((source) => (
            <button type="button" className={source.path === sourcePath ? "is-active" : ""} onClick={() => setSourcePath(source.path)} key={source.path}>
              <span className="material-symbols-outlined" aria-hidden>{source.kind === "prompt" ? "notes" : "code"}</span>
              <span>{source.title || source.path}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="af-node-review-source-head">
        <div>
          <strong>{mode === "diff" ? (draftSource?.path || stableSource?.path || "执行内容") : (activeSource?.path || "执行内容")}</strong>
          <small>
            {mode === "diff"
              ? `${compactSha(stableSource?.sha256) || "新增"} → ${compactSha(draftSource?.sha256) || "已删除"}`
              : `${activeSnapshot?.label || "Draft"}${activeSource?.sha256 ? ` · SHA ${compactSha(activeSource.sha256)}` : ""}`}
          </small>
        </div>
        <button type="button" className="af-icon-btn" onClick={() => setExpanded(true)} disabled={!activeSource && mode !== "diff"} title="全屏审查">
          <span className="material-symbols-outlined" aria-hidden>open_in_full</span>
        </button>
      </div>
      <div className="af-node-review-viewer">{viewer}</div>
      {expanded ? (
        <div className="af-node-props-expand-overlay" role="dialog" aria-modal="true" aria-label="全屏审查节点执行内容" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setExpanded(false);
        }}>
          <div className="af-node-review-expand-panel">
            <div className="af-node-props-expand-head">
              <div className="af-node-review-expand-title">
                <strong>{draft?.definitionId || stable?.definitionId}</strong>
                <span>{mode === "diff" ? "Draft 与 Stable 对比" : activeSource?.path}</span>
              </div>
              <button type="button" className="af-icon-btn" onClick={() => setExpanded(false)} aria-label="关闭全屏审查">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="af-node-review-expand-content">{viewer}</div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * @param {{
 *   kind: "input" | "output",
 *   label: string,
 *   slots: { type: string, name: string, default: string, description?: string, required?: boolean, showOnNode?: boolean }[],
 *   onSlotsChange: (next: { type: string, name: string, default: string, description?: string, required?: boolean, showOnNode?: boolean }[]) => void,
 *   disabled: boolean,
 *   requiredReadonly?: boolean,
 * }} p
 */
function IoPinsEditor({ kind, label, slots, onSlotsChange, disabled, requiredReadonly = true }) {
  const { t } = useTranslation();
  const add = () => onSlotsChange([...slots, { type: "text", name: "", default: "", required: false, showOnNode: false }]);
  const removeAt = (i) => onSlotsChange(slots.filter((_, j) => j !== i));
  const patch = (i, field, value) => {
    const next = slots.map((s, j) => {
      if (j !== i) return s;
      const patched = { ...s, [field]: value };
      if (field === "required" && value === true) patched.showOnNode = true;
      return patched;
    });
    onSlotsChange(next);
  };
  const handlePrefix = kind === "input" ? "input" : "output";

  return (
    <div className="af-node-props-field af-node-props-field--io">
      <div className="af-node-props-io-head">
        <span className="af-node-props-label">{label}</span>
        <button
          type="button"
          className="af-btn-ghost af-node-props-io-add"
          onClick={add}
          disabled={disabled}
          aria-label={t("flow:nodeProps.addPinAriaLabel", { label })}
        >
          {t("flow:nodeProps.addPin")}
        </button>
      </div>
      <p className="af-node-props-io-hint">
        {t("flow:nodeProps.handleHint", { prefix: handlePrefix })}
      </p>
      {slots.length === 0 ? <p className="af-node-props-io-empty">{kind === "input" ? t("flow:nodeProps.noInputPins") : t("flow:nodeProps.noOutputPins")}</p> : null}
      {slots.length > 0 ? (
        <div className="af-node-props-io-table" role="group" aria-label={label}>
          <div className="af-node-props-io-table-head" aria-hidden>
            <span>{t("flow:nodeProps.handle")}</span>
            <span>{t("flow:nodeProps.type")}</span>
            <span>{t("flow:nodeProps.name")}</span>
            <span>{t("flow:nodeProps.defaultValue")}</span>
            <span>{t("flow:nodeProps.description")}</span>
            <span>{t("flow:nodeProps.required")}</span>
            <span>{t("flow:nodeProps.showOnNode")}</span>
            <span />
          </div>
          {slots.map((s, i) => (
            <div key={`${handlePrefix}-${i}`} className="af-node-props-io-row">
              <span className="af-node-props-io-handle" title={`${handlePrefix}-${i}`}>
                {handlePrefix}-{i}
              </span>
              <select
                className="af-node-props-input af-node-props-io-cell"
                value={s.type}
                onChange={(e) => patch(i, "type", e.target.value)}
                disabled={disabled}
                aria-label={t("flow:nodeProps.pinTypeAriaLabel", { label, index: i })}
              >
                {["node", "text", "file", "bool", "json"].map((typ) => (
                  <option key={typ} value={typ}>{typ}</option>
                ))}
              </select>
              <input
                type="text"
                className="af-node-props-input af-node-props-io-cell"
                value={s.name}
                onChange={(e) => patch(i, "name", e.target.value)}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                aria-label={t("flow:nodeProps.pinNameAriaLabel", { label, index: i })}
              />
              <input
                type="text"
                className="af-node-props-input af-node-props-io-cell"
                value={s.default}
                onChange={(e) => patch(i, "default", e.target.value)}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                aria-label={t("flow:nodeProps.pinDefaultAriaLabel", { label, index: i })}
              />
              <input
                type="text"
                className="af-node-props-input af-node-props-io-cell"
                value={s.description || ""}
                onChange={(e) => patch(i, "description", e.target.value)}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                aria-label={t("flow:nodeProps.pinDescriptionAriaLabel", { label, index: i })}
              />
              <label className="af-node-props-io-flag" title={t("flow:nodeProps.requiredHint")}>
                <input
                  type="checkbox"
                  checked={Boolean(s.required)}
                  onChange={(e) => {
                    if (!requiredReadonly) patch(i, "required", e.target.checked);
                  }}
                  disabled={disabled || requiredReadonly}
                  aria-label={t("flow:nodeProps.pinRequiredAriaLabel", { label, index: i })}
                />
              </label>
              <label className="af-node-props-io-flag" title={t("flow:nodeProps.showOnNodeHint")}>
                <input
                  type="checkbox"
                  checked={s.showOnNode !== false}
                  onChange={(e) => patch(i, "showOnNode", e.target.checked)}
                  disabled={disabled}
                  aria-label={t("flow:nodeProps.pinShowOnNodeAriaLabel", { label, index: i })}
                />
              </label>
              <button
                type="button"
                className="af-icon-btn af-node-props-io-remove"
                onClick={() => removeAt(i)}
                disabled={disabled}
                aria-label={t("flow:nodeProps.deletePinAriaLabel", { label, index: i })}
                title={t("flow:nodeProps.deletePin")}
              >
                <span className="material-symbols-outlined">delete</span>
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * @param {{
 *   draft: {
 *     id: string,
 *     newId: string,
 *     label: string,
 *     role: string,
 *     model: string,
 *     body: string,
 *     images?: Array<any>,
 *     script?: string,
 *     scriptRef?: string,
 *     implementationRef?: string,
 *     implementationMode?: string,
 *     inputs: { type: string, name: string, default: string, description?: string, required?: boolean, showOnNode?: boolean }[],
 *     outputs: { type: string, name: string, default: string, description?: string, required?: boolean, showOnNode?: boolean }[],
 *   } | null,
 *   setDraft: (fn: (d: any) => any) => void,
 *   definitionId: string,
 *   systemPromptReadonly: string,
 *   modelLists: { cursor: string[], opencode: string[] },
 *   disabled: boolean,
 *   onIdBlur: () => void,
 *   onClose: () => void,
 *   onPublishToMarketplace?: (draft: any, definitionId: string) => Promise<any>,
 *   allowEditRequiredPins?: boolean,
 *   error: string,
 *   ioSlots: { inputs?: { name?: string, type?: string }[], outputs?: { name?: string, type?: string }[] },
 *   executionReview?: any,
 *   executionReviewLoading?: boolean,
 *   executionReviewError?: string,
 *   onReloadExecutionReview?: () => void,
 * }} props
 */
export function NodePropertiesPanel({
  draft,
  setDraft,
  definitionId,
  systemPromptReadonly,
  modelLists,
  disabled,
  onIdBlur,
  onClose,
  onPublishToMarketplace,
  allowEditRequiredPins = false,
  error,
  ioSlots,
  executionReview,
  executionReviewLoading = false,
  executionReviewError = "",
  onReloadExecutionReview,
}) {
  const { t } = useTranslation();
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const [scriptExpanded, setScriptExpanded] = useState(false);
  const [publishState, setPublishState] = useState({ status: "idle", message: "" });
  const [panelTab, setPanelTab] = useState(disabled ? "review" : "config");

  useEffect(() => {
    setPanelTab(disabled ? "review" : "config");
  }, [disabled, draft?.id]);

  const update = useCallback(
    (patch) => {
      setDraft((d) => (d ? { ...d, ...patch } : d));
    },
    [setDraft],
  );

  const { cursorList, opencodeList, claudeCodeList, codexList, currentNotInLists } = useMemo(() => {
    const cursor = Array.isArray(modelLists?.cursor) ? modelLists.cursor : [];
    const opencode = Array.isArray(modelLists?.opencode) ? modelLists.opencode : [];
    const claudeCode = Array.isArray(modelLists?.claudeCode) ? modelLists.claudeCode : [];
    const codex = Array.isArray(modelLists?.codex) ? modelLists.codex : [];
    const idSet = new Set([...cursor, ...opencode, ...claudeCode, ...codex].map(modelEntryId));
    const m = (draft?.model ?? "").trim();
    const mBare = m.startsWith("cursor:")
      ? m.slice(7)
      : m.startsWith("opencode:")
        ? m.slice(9)
        : m.startsWith("codex:")
          ? m.slice(6)
          : m.startsWith("claude-code:")
            ? m.slice(12)
            : m;
    const extra = m && !idSet.has(mBare) ? m : "";
    return { cursorList: cursor, opencodeList: opencode, claudeCodeList: claudeCode, codexList: codex, currentNotInLists: extra };
  }, [modelLists, draft?.model]);

  if (!draft) return null;

  const scriptStr = String(draft.script ?? "");
  const showScriptSection =
    definitionId === "tool_nodejs" || definitionId === "control_while" || scriptStr.trim() !== "";
  const canPublish = typeof onPublishToMarketplace === "function" && !disabled && draft?.newId;
  const publishCurrentNode = async () => {
    if (!canPublish) return;
    setPublishState({ status: "running", message: t("flow:nodeProps.publishRunning") });
    try {
      const result = await onPublishToMarketplace(draft, definitionId);
      setPublishState({
        status: "success",
        message: result?.definitionId
          ? t("flow:nodeProps.publishSuccessWithId", { id: result.definitionId })
          : t("flow:nodeProps.publishSuccess"),
      });
    } catch (e) {
      setPublishState({ status: "error", message: String(e?.message || e) });
    }
  };

  return (
    <>
      <div className="af-pipeline-drawer-head af-node-props-head">
        <h2 className="af-pipeline-drawer-title">{t("flow:nodeProps.title")}</h2>
        <div className="af-node-props-head-actions">
          <button
            type="button"
            className="af-btn-ghost af-node-props-market-btn"
            onClick={publishCurrentNode}
            disabled={!canPublish || publishState.status === "running"}
            title={t("flow:nodeProps.publishToMarketplaceHint")}
          >
            <span className="material-symbols-outlined" aria-hidden>inventory_2</span>
            {publishState.status === "running" ? t("flow:nodeProps.publishing") : t("flow:nodeProps.publishToMarketplace")}
          </button>
          <button type="button" className="af-btn-ghost af-node-props-close-secondary" onClick={onClose}>
            {t("common:common.close")}
          </button>
        </div>
      </div>

      <div className="af-pipeline-drawer-body af-node-props-body">
        {error ? <p className="af-err af-node-props-err">{error}</p> : null}
        {publishState.message ? (
          <p className={`af-node-props-market-status af-node-props-market-status--${publishState.status}`}>
            {publishState.message}
          </p>
        ) : null}

        <div className="af-node-props-tabs" role="tablist" aria-label="节点属性视图">
          <button type="button" className={panelTab === "config" ? "is-active" : ""} onClick={() => setPanelTab("config")}>配置</button>
          <button type="button" className={panelTab === "review" ? "is-active" : ""} onClick={() => setPanelTab("review")}>
            <span className="material-symbols-outlined" aria-hidden>fact_check</span>
            执行内容
          </button>
        </div>

        {panelTab === "config" ? (
          <>

        <label className="af-pipeline-drawer-field af-node-props-field">
          <span className="af-node-props-label">{t("flow:node.nodeType")}</span>
          <div className="af-pipeline-drawer-readonly af-node-props-readonly-mono">{definitionId}</div>
        </label>

        <label className="af-pipeline-drawer-field af-node-props-field">
          <span className="af-node-props-label">
            {t("flow:nodeProps.instanceId")}
            <span className="af-node-props-hint">{t("flow:node.displayNameHint")}</span>
          </span>
          <input
            type="text"
            className="af-node-props-input"
            value={draft.newId}
            onChange={(e) => update({ newId: e.target.value })}
            onBlur={onIdBlur}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            aria-label={t("flow:nodeProps.instanceId")}
          />
        </label>

        <label className="af-pipeline-drawer-field af-node-props-field">
          <span className="af-node-props-label">{t("flow:node.displayName")}（LABEL）</span>
          <input
            type="text"
            className="af-node-props-input"
            value={draft.label}
            onChange={(e) => update({ label: e.target.value })}
            disabled={disabled}
            spellCheck={false}
          />
        </label>

        <label className="af-pipeline-drawer-field af-node-props-field">
          <span className="af-node-props-label">{t("flow:node.role")}（ROLE）</span>
          <select
            className="af-node-props-select"
            value={VALID_ROLES.includes(draft.role) ? draft.role : t("flow:roles.normal")}
            onChange={(e) => update({ role: e.target.value })}
            disabled={disabled}
          >
            {VALID_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        <label className="af-pipeline-drawer-field af-node-props-field">
          <span className="af-node-props-label">{t("flow:node.model")}（MODEL）</span>
          <span className="af-node-props-sublabel">{t("flow:node.modelHint")}</span>
          <select
            className="af-node-props-select"
            value={(() => {
              const dm = (draft.model || "").trim();
              if (!dm) return "";
              return currentNotInLists ? currentNotInLists : dm;
            })()}
            onChange={(e) => update({ model: e.target.value })}
            disabled={disabled}
            aria-label={t("flow:nodeProps.modelAriaLabel")}
          >
            <option value="">{t("flow:node.defaultModel")}</option>
            {currentNotInLists ? (
              <option value={currentNotInLists}>
                {currentNotInLists}{t("flow:nodeProps.yamlValueNotInList")}
              </option>
            ) : null}
            {cursorList.length > 0 ? (
              <optgroup label="Cursor">
                {cursorList.map((m) => (
                  <option key={`c-${m}`} value={modelEntryId(m)}>
                    {m}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {opencodeList.length > 0 ? (
              <optgroup label="OpenCode">
                {opencodeList.map((m) => (
                  <option key={`o-${m}`} value={`opencode:${modelEntryId(m)}`}>
                    {m}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {codexList.length > 0 ? (
              <optgroup label="Codex">
                {codexList.map((m) => (
                  <option key={`codex-${m}`} value={`codex:${modelEntryId(m)}`}>
                    {m}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {claudeCodeList.length > 0 ? (
              <optgroup label="Claude Code">
                {claudeCodeList.map((m) => (
                  <option key={`cc-${m}`} value={`claude-code:${modelEntryId(m)}`}>
                    {m}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>

        <IoPinsEditor
          kind="input"
          label={t("flow:nodeProps.inputPins")}
          slots={Array.isArray(draft.inputs) ? draft.inputs : []}
          onSlotsChange={(next) => update({ inputs: next })}
          disabled={disabled}
          requiredReadonly={!allowEditRequiredPins}
        />
        <IoPinsEditor
          kind="output"
          label={t("flow:nodeProps.outputPins")}
          slots={Array.isArray(draft.outputs) ? draft.outputs : []}
          onSlotsChange={(next) => update({ outputs: next })}
          disabled={disabled}
          requiredReadonly={!allowEditRequiredPins}
        />

        {showScriptSection ? (
          <div className="af-pipeline-drawer-field af-node-props-field af-node-props-field--prompt">
            <div className="af-node-props-prompt-head">
              <span className="af-node-props-label">
                {t("flow:node.directCommand")}（script）
                <span className="af-node-props-hint">{t("flow:node.scriptHint")}</span>
              </span>
              <button
                type="button"
                className="af-icon-btn af-node-props-expand"
                onClick={() => setScriptExpanded(true)}
                aria-label={t("flow:nodeProps.expandEditScript")}
                title={t("flow:nodeProps.expand")}
                disabled={disabled}
              >
                <span className="material-symbols-outlined">open_in_full</span>
              </button>
            </div>
            <BodyPromptEditor
              value={scriptStr}
              onChange={(next) => update({ script: next })}
              disabled={disabled}
              placeholder={t("flow:nodeProps.scriptPlaceholder")}
              rows={6}
              textareaClassName="af-pipeline-drawer-textarea af-node-props-body-textarea af-node-props-script-textarea"
              ioSlots={ioSlots}
              variant="drawer"
            />
          </div>
        ) : null}

        <label className="af-pipeline-drawer-field af-node-props-field">
          <span className="af-node-props-label">Script file（scriptRef）</span>
          <span className="af-node-props-sublabel">Relative path under this flow, for example nodes/{draft.id}/script.mjs</span>
          <input
            type="text"
            className="af-node-props-input"
            value={draft.scriptRef || ""}
            onChange={(e) => update({ scriptRef: e.target.value })}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <label className="af-pipeline-drawer-field af-node-props-field">
          <span className="af-node-props-label">Implementation file（implementationRef）</span>
          <span className="af-node-props-sublabel">Relative path under this flow, for example nodes/{draft.id}/implementation.md</span>
          <input
            type="text"
            className="af-node-props-input"
            value={draft.implementationRef || ""}
            onChange={(e) => update({ implementationRef: e.target.value })}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <label className="af-pipeline-drawer-field af-node-props-field">
          <span className="af-node-props-label">Implementation mode</span>
          <select
            className="af-node-props-select"
            value={draft.implementationMode || ""}
            onChange={(e) => update({ implementationMode: e.target.value })}
            disabled={disabled}
          >
            <option value="">auto</option>
            <option value="script">script</option>
            <option value="steps">steps</option>
            <option value="hybrid">hybrid</option>
          </select>
        </label>

        <div className="af-pipeline-drawer-field af-node-props-field af-node-props-field--prompt">
          <div className="af-node-props-prompt-head">
            <span className="af-node-props-label">{t("flow:node.userPrompt")}</span>
            <button
              type="button"
              className="af-icon-btn af-node-props-expand"
              onClick={() => setBodyExpanded(true)}
              aria-label={t("flow:nodeProps.expandEdit")}
              title={t("flow:nodeProps.expand")}
              disabled={disabled}
            >
              <span className="material-symbols-outlined">open_in_full</span>
            </button>
          </div>
          <BodyPromptEditor
            value={draft.body}
            onChange={(next) => update({ body: next })}
            images={draft.images}
            onImagesChange={(next) => update({ images: next })}
            disabled={disabled}
            placeholder={t("flow:nodeProps.bodyPlaceholder")}
            rows={8}
            textareaClassName="af-pipeline-drawer-textarea af-node-props-body-textarea"
            ioSlots={ioSlots}
            variant="drawer"
          />
        </div>

        <label className="af-pipeline-drawer-field af-node-props-field">
          <span className="af-node-props-label">{t("flow:node.systemDescription")}</span>
          <textarea
            className="af-pipeline-drawer-textarea af-node-props-system-readonly"
            rows={4}
            readOnly
            value={systemPromptReadonly || t("flow:nodeProps.noDescription")}
            spellCheck={false}
          />
        </label>
          </>
        ) : (
          <NodeExecutionReview
            review={executionReview}
            loading={executionReviewLoading}
            error={executionReviewError}
            onReload={onReloadExecutionReview}
          />
        )}
      </div>

      {scriptExpanded ? (
        <div
          className="af-node-props-expand-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("flow:nodeProps.editScript")}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setScriptExpanded(false);
          }}
        >
          <div className="af-node-props-expand-panel">
            <div className="af-node-props-expand-head">
              <span className="af-node-props-expand-title">{t("flow:node.directCommand")}</span>
              <button type="button" className="af-icon-btn" onClick={() => setScriptExpanded(false)} aria-label={t("flow:nodeProps.collapse")}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <BodyPromptEditor
              value={scriptStr}
              onChange={(next) => update({ script: next })}
              disabled={disabled}
              placeholder={t("flow:nodeProps.scriptPlaceholderExpand")}
              rows={16}
              textareaClassName="af-node-props-expand-textarea"
              ioSlots={ioSlots}
              variant="expand"
            />
          </div>
        </div>
      ) : null}

      {bodyExpanded ? (
        <div
          className="af-node-props-expand-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("flow:nodeProps.editUserPrompt")}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setBodyExpanded(false);
          }}
        >
          <div className="af-node-props-expand-panel">
            <div className="af-node-props-expand-head">
              <span className="af-node-props-expand-title">{t("flow:node.body")}</span>
              <button type="button" className="af-icon-btn" onClick={() => setBodyExpanded(false)} aria-label={t("flow:nodeProps.collapse")}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <BodyPromptEditor
              value={draft.body}
              onChange={(next) => update({ body: next })}
              images={draft.images}
              onImagesChange={(next) => update({ images: next })}
              disabled={disabled}
              placeholder={t("flow:nodeProps.bodyPlaceholderExpand")}
              rows={16}
              textareaClassName="af-node-props-expand-textarea"
              ioSlots={ioSlots}
              variant="expand"
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

export { NODE_INSTANCE_ID_RE };
