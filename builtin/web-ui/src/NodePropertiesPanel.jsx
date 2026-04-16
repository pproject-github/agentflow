import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BodyPromptEditor } from "./BodyPromptEditor.jsx";
import { VALID_ROLES } from "./flowFormat.js";

/** @type {RegExp} */
const NODE_INSTANCE_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

/** "composer-2-fast - Composer 2 Fast (default)" → "composer-2-fast" */
function modelEntryId(entry) {
  const idx = entry.indexOf(" - ");
  return idx >= 0 ? entry.slice(0, idx).trim() : entry.trim();
}

/**
 * @param {{
 *   kind: "input" | "output",
 *   label: string,
 *   slots: { type: string, name: string, default: string }[],
 *   onSlotsChange: (next: { type: string, name: string, default: string }[]) => void,
 *   disabled: boolean,
 * }} p
 */
function IoPinsEditor({ kind, label, slots, onSlotsChange, disabled }) {
  const { t } = useTranslation();
  const add = () => onSlotsChange([...slots, { type: "node", name: "", default: "" }]);
  const removeAt = (i) => onSlotsChange(slots.filter((_, j) => j !== i));
  const patch = (i, field, value) => {
    const next = slots.map((s, j) => (j === i ? { ...s, [field]: value } : s));
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
                {["node", "text", "file", "bool"].map((typ) => (
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
 *     script?: string,
 *     inputs: { type: string, name: string, default: string }[],
 *     outputs: { type: string, name: string, default: string }[],
 *   } | null,
 *   setDraft: (fn: (d: any) => any) => void,
 *   definitionId: string,
 *   systemPromptReadonly: string,
 *   modelLists: { cursor: string[], opencode: string[] },
 *   disabled: boolean,
 *   onSave: () => void,
 *   onClose: () => void,
 *   error: string,
 *   ioSlots: { inputs?: { name?: string, type?: string }[], outputs?: { name?: string, type?: string }[] },
 * }} props
 */
export function NodePropertiesPanel({
  draft,
  setDraft,
  definitionId,
  systemPromptReadonly,
  modelLists,
  disabled,
  onSave,
  onClose,
  error,
  ioSlots,
}) {
  const { t } = useTranslation();
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const [scriptExpanded, setScriptExpanded] = useState(false);

  const update = useCallback(
    (patch) => {
      setDraft((d) => (d ? { ...d, ...patch } : d));
    },
    [setDraft],
  );

  const { cursorList, opencodeList, currentNotInLists } = useMemo(() => {
    const cursor = Array.isArray(modelLists?.cursor) ? modelLists.cursor : [];
    const opencode = Array.isArray(modelLists?.opencode) ? modelLists.opencode : [];
    const idSet = new Set([...cursor, ...opencode].map(modelEntryId));
    const m = (draft?.model ?? "").trim();
    const extra = m && !idSet.has(m) ? m : "";
    return { cursorList: cursor, opencodeList: opencode, currentNotInLists: extra };
  }, [modelLists, draft?.model]);

  if (!draft) return null;

  const scriptStr = String(draft.script ?? "");
  const showScriptSection =
    definitionId === "tool_nodejs" || scriptStr.trim() !== "";

  return (
    <>
      <div className="af-pipeline-drawer-head af-node-props-head">
        <h2 className="af-pipeline-drawer-title">{t("flow:nodeProps.title")}</h2>
        <div className="af-node-props-head-actions">
          <button type="button" className="af-btn-primary af-node-props-save" disabled={disabled} onClick={onSave}>
            {t("common:common.save")}
          </button>
          <button type="button" className="af-btn-ghost af-node-props-close-secondary" onClick={onClose}>
            {t("common:common.close")}
          </button>
        </div>
      </div>

      <div className="af-pipeline-drawer-body af-node-props-body">
        {error ? <p className="af-err af-node-props-err">{error}</p> : null}

        <label className="af-pipeline-drawer-field af-node-props-field">
          <span className="af-node-props-label">{t("flow:node.nodeType")}</span>
          <div className="af-pipeline-drawer-readonly af-node-props-readonly-mono">{definitionId}</div>
        </label>

        <label className="af-pipeline-drawer-field af-node-props-field">
          <span className="af-node-props-label">
            {t("flow:node.displayName")}
            <span className="af-node-props-hint">{t("flow:node.displayNameHint")}</span>
          </span>
          <input
            type="text"
            className="af-node-props-input"
            value={draft.newId}
            onChange={(e) => update({ newId: e.target.value })}
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
                  <option key={`o-${m}`} value={modelEntryId(m)}>
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
        />
        <IoPinsEditor
          kind="output"
          label={t("flow:nodeProps.outputPins")}
          slots={Array.isArray(draft.outputs) ? draft.outputs : []}
          onSlotsChange={(next) => update({ outputs: next })}
          disabled={disabled}
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
