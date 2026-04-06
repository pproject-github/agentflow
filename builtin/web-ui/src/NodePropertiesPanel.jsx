import { useCallback, useMemo, useState } from "react";
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
  const add = () => onSlotsChange([...slots, { type: "节点", name: "", default: "" }]);
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
          aria-label={`添加${label}`}
        >
          添加引脚
        </button>
      </div>
      <p className="af-node-props-io-hint">
        与画布上 Handle 序号一致（{handlePrefix}-0、{handlePrefix}-1…）。增删或调整顺序后，原有连线可能失效，保存后请留意校验提示。
      </p>
      {slots.length === 0 ? <p className="af-node-props-io-empty">当前无{kind === "input" ? "输入" : "输出"}引脚</p> : null}
      {slots.length > 0 ? (
        <div className="af-node-props-io-table" role="group" aria-label={label}>
          <div className="af-node-props-io-table-head" aria-hidden>
            <span>Handle</span>
            <span>类型</span>
            <span>名称</span>
            <span>默认值 / value</span>
            <span />
          </div>
          {slots.map((s, i) => (
            <div key={`${handlePrefix}-${i}`} className="af-node-props-io-row">
              <span className="af-node-props-io-handle" title={`${handlePrefix}-${i}`}>
                {handlePrefix}-{i}
              </span>
              <input
                type="text"
                className="af-node-props-input af-node-props-io-cell"
                value={s.type}
                onChange={(e) => patch(i, "type", e.target.value)}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                aria-label={`${label} ${i} 类型`}
              />
              <input
                type="text"
                className="af-node-props-input af-node-props-io-cell"
                value={s.name}
                onChange={(e) => patch(i, "name", e.target.value)}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                aria-label={`${label} ${i} 名称`}
              />
              <input
                type="text"
                className="af-node-props-input af-node-props-io-cell"
                value={s.default}
                onChange={(e) => patch(i, "default", e.target.value)}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                aria-label={`${label} ${i} 默认值`}
              />
              <button
                type="button"
                className="af-icon-btn af-node-props-io-remove"
                onClick={() => removeAt(i)}
                disabled={disabled}
                aria-label={`删除 ${label} ${i}`}
                title="删除此引脚"
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
        <h2 className="af-pipeline-drawer-title">节点属性</h2>
        <div className="af-node-props-head-actions">
          <button type="button" className="af-btn-primary af-node-props-save" disabled={disabled} onClick={onSave}>
            保存
          </button>
          <button type="button" className="af-btn-ghost af-node-props-close-secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      <div className="af-pipeline-drawer-body af-node-props-body">
        {error ? <p className="af-err af-node-props-err">{error}</p> : null}

        <label className="af-pipeline-drawer-field af-node-props-field">
          <span className="af-node-props-label">节点类型</span>
          <div className="af-pipeline-drawer-readonly af-node-props-readonly-mono">{definitionId}</div>
        </label>

        <label className="af-pipeline-drawer-field af-node-props-field">
          <span className="af-node-props-label">
            实例 ID（NAME）
            <span className="af-node-props-hint">（字母、数字、下划线、短横线，勿以数字开头）</span>
          </span>
          <input
            type="text"
            className="af-node-props-input"
            value={draft.newId}
            onChange={(e) => update({ newId: e.target.value })}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            aria-label="实例 ID"
          />
        </label>

        <label className="af-pipeline-drawer-field af-node-props-field">
          <span className="af-node-props-label">显示名称（LABEL）</span>
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
          <span className="af-node-props-label">角色（ROLE）</span>
          <select
            className="af-node-props-select"
            value={VALID_ROLES.includes(draft.role) ? draft.role : "普通"}
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
          <span className="af-node-props-label">模型（MODEL）</span>
          <span className="af-node-props-sublabel">来自 ~/agentflow/model-lists.json；UI 服务启动时会后台执行 agentflow update-model-lists</span>
          <select
            className="af-node-props-select"
            value={(() => {
              const dm = (draft.model || "").trim();
              if (!dm) return "";
              return currentNotInLists ? currentNotInLists : dm;
            })()}
            onChange={(e) => update({ model: e.target.value })}
            disabled={disabled}
            aria-label="模型"
          >
            <option value="">默认</option>
            {currentNotInLists ? (
              <option value={currentNotInLists}>
                {currentNotInLists}（YAML 中的值，不在当前列表）
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
          label="输入引脚（INPUT）"
          slots={Array.isArray(draft.inputs) ? draft.inputs : []}
          onSlotsChange={(next) => update({ inputs: next })}
          disabled={disabled}
        />
        <IoPinsEditor
          kind="output"
          label="输出引脚（OUTPUT）"
          slots={Array.isArray(draft.outputs) ? draft.outputs : []}
          onSlotsChange={(next) => update({ outputs: next })}
          disabled={disabled}
        />

        {showScriptSection ? (
          <div className="af-pipeline-drawer-field af-node-props-field af-node-props-field--prompt">
            <div className="af-node-props-prompt-head">
              <span className="af-node-props-label">
                直接执行命令（script）
                <span className="af-node-props-hint">（tool_nodejs：有 script 时跳过 AI，由流水线执行）</span>
              </span>
              <button
                type="button"
                className="af-icon-btn af-node-props-expand"
                onClick={() => setScriptExpanded(true)}
                aria-label="展开编辑 script"
                title="展开"
                disabled={disabled}
              >
                <span className="material-symbols-outlined">open_in_full</span>
              </button>
            </div>
            <BodyPromptEditor
              value={scriptStr}
              onChange={(next) => update({ script: next })}
              disabled={disabled}
              placeholder="instances.*.script，完整 shell 命令；支持 ${workspaceRoot}、${flowDir}、${runDir} 与各槽位名（勿对占位符再包双引号）"
              rows={6}
              textareaClassName="af-pipeline-drawer-textarea af-node-props-body-textarea af-node-props-script-textarea"
              ioSlots={ioSlots}
              variant="drawer"
            />
          </div>
        ) : null}

        <div className="af-pipeline-drawer-field af-node-props-field af-node-props-field--prompt">
          <div className="af-node-props-prompt-head">
            <span className="af-node-props-label">用户提示（USER PROMPT / body）</span>
            <button
              type="button"
              className="af-icon-btn af-node-props-expand"
              onClick={() => setBodyExpanded(true)}
              aria-label="展开编辑"
              title="展开"
              disabled={disabled}
            >
              <span className="material-symbols-outlined">open_in_full</span>
            </button>
          </div>
          <BodyPromptEditor
            value={draft.body}
            onChange={(next) => update({ body: next })}
            disabled={disabled}
            placeholder="instances.*.body，支持多行与 ${变量}；输入 ${ 选择槽位"
            rows={8}
            textareaClassName="af-pipeline-drawer-textarea af-node-props-body-textarea"
            ioSlots={ioSlots}
            variant="drawer"
          />
        </div>

        <label className="af-pipeline-drawer-field af-node-props-field">
          <span className="af-node-props-label">系统说明（只读，来自节点定义）</span>
          <textarea
            className="af-pipeline-drawer-textarea af-node-props-system-readonly"
            rows={4}
            readOnly
            value={systemPromptReadonly || "（当前节点定义无 description）"}
            spellCheck={false}
          />
        </label>
      </div>

      {scriptExpanded ? (
        <div
          className="af-node-props-expand-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="编辑 script"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setScriptExpanded(false);
          }}
        >
          <div className="af-node-props-expand-panel">
            <div className="af-node-props-expand-head">
              <span className="af-node-props-expand-title">直接执行命令（script）</span>
              <button type="button" className="af-icon-btn" onClick={() => setScriptExpanded(false)} aria-label="收起">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <BodyPromptEditor
              value={scriptStr}
              onChange={(next) => update({ script: next })}
              disabled={disabled}
              placeholder="instances.*.script，完整 shell 命令；勿对 ${workspaceRoot}、${flowDir} 等占位符再包双引号"
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
          aria-label="编辑用户提示"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setBodyExpanded(false);
          }}
        >
          <div className="af-node-props-expand-panel">
            <div className="af-node-props-expand-head">
              <span className="af-node-props-expand-title">用户提示（body）</span>
              <button type="button" className="af-icon-btn" onClick={() => setBodyExpanded(false)} aria-label="收起">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <BodyPromptEditor
              value={draft.body}
              onChange={(next) => update({ body: next })}
              disabled={disabled}
              placeholder="instances.*.body，支持多行与 ${变量}"
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
