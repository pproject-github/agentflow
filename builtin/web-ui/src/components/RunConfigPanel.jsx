import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";

function RunConfigPanel({
  flowId,
  flowSource,
  flowArchived,
  provideNodes,
  edges,
  nodes,
  onCliInputsChange,
  onBackToEdit,
}) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState({});
  const [activePreset, setActivePreset] = useState(null);
  const [inputValues, setInputValues] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newPresetName, setNewPresetName] = useState("");
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [expandedProvide, setExpandedProvide] = useState(
    /** @type {null | { instanceId: string, label: string, content: string }} */ (null),
  );
  const expandedRef = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  const mountedRef = useRef(true);
  const defaultValuesRef = useRef({});

  const defaultValues = useMemo(() => {
    const defaults = {};
    for (const node of provideNodes) {
      const outputDefault = node.data?.outputs?.[0]?.default;
      if (outputDefault != null && outputDefault !== "") {
        defaults[node.id] = String(outputDefault);
      }
    }
    defaultValuesRef.current = defaults;
    return defaults;
  }, [provideNodes]);

  const cliInputSlotNames = useMemo(() => {
    const mapping = {};
    for (const node of nodes) {
      if (!node.data?.inputs) continue;
      const inputSlots = node.data.inputs;
      for (let i = 0; i < inputSlots.length; i++) {
        const slot = inputSlots[i];
        if (!slot?.name) continue;
        const edge = edges.find(
          (e) => e.target === node.id && e.targetHandle === `input-${i}`
        );
        if (!edge?.source) continue;
        const sourceNode = provideNodes.find((p) => p.id === edge.source);
        if (sourceNode) {
          mapping[edge.source] = slot.name;
        }
      }
    }
    return mapping;
  }, [nodes, edges, provideNodes]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!flowId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const params = new URLSearchParams({
      flowId,
      flowSource: flowSource || "user",
    });
    if (flowArchived) params.set("archived", "1");
    fetch(`/api/flow/run-config?${params.toString()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!mountedRef.current) return;
        setPresets(data.presets || {});
        setActivePreset(data.activePreset || null);
        const presetValues = data.activePreset && data.presets?.[data.activePreset]
          ? data.presets[data.activePreset]
          : {};
        setInputValues({ ...defaultValuesRef.current, ...presetValues });
        setLoading(false);
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setInputValues(defaultValuesRef.current);
        setLoading(false);
      });
  }, [flowId, flowSource, flowArchived]);

  useEffect(() => {
    if (!onCliInputsChange) return;
    const cliInputs = {};
    for (const [instanceId, value] of Object.entries(inputValues)) {
      const slotName = cliInputSlotNames[instanceId];
      if (!slotName) continue;
      const node = provideNodes.find((p) => p.id === instanceId);
      if (!node) continue;
      const definitionId = node.data?.definitionId || "";
      if (definitionId.startsWith("provide_file")) {
        cliInputs[slotName] = { type: "file", path: value };
      } else {
        cliInputs[slotName] = { type: "str", value };
      }
    }
    onCliInputsChange(cliInputs);
  }, [inputValues, cliInputSlotNames, provideNodes, onCliInputsChange]);

  const handleValueChange = useCallback((instanceId, value) => {
    setInputValues((prev) => ({ ...prev, [instanceId]: value }));
  }, []);

  const handlePresetSelect = useCallback((presetName) => {
    if (presetName === activePreset) return;
    setActivePreset(presetName);
    if (presetName && presets[presetName]) {
      setInputValues({ ...defaultValuesRef.current, ...presets[presetName] });
    } else {
      setInputValues(defaultValuesRef.current);
    }
  }, [activePreset, presets]);

  const handleSavePreset = useCallback(async () => {
    if (!newPresetName.trim()) return;
    setSaving(true);
    try {
      const newPresets = { ...presets, [newPresetName.trim()]: inputValues };
      const payload = {
        flowId,
        flowSource,
        archived: flowArchived,
        presets: newPresets,
        activePreset: newPresetName.trim(),
      };
      const resp = await fetch("/api/flow/run-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        setPresets(newPresets);
        setActivePreset(newPresetName.trim());
        setNewPresetName("");
        setShowSaveDialog(false);
      }
    } finally {
      setSaving(false);
    }
  }, [flowId, flowSource, flowArchived, presets, inputValues, newPresetName]);

  const handleDeletePreset = useCallback(async () => {
    if (!activePreset) return;
    setSaving(true);
    try {
      const newPresets = { ...presets };
      delete newPresets[activePreset];
      const nextPreset = Object.keys(newPresets)[0] || null;
      const payload = {
        flowId,
        flowSource,
        archived: flowArchived,
        presets: newPresets,
        activePreset: nextPreset,
      };
      const resp = await fetch("/api/flow/run-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        setPresets(newPresets);
        setActivePreset(nextPreset);
        if (nextPreset && newPresets[nextPreset]) {
          setInputValues({ ...defaultValuesRef.current, ...newPresets[nextPreset] });
        } else {
          setInputValues(defaultValuesRef.current);
        }
      }
    } finally {
      setSaving(false);
    }
  }, [flowId, flowSource, flowArchived, presets, activePreset]);

  const handleUpdatePreset = useCallback(async () => {
    if (!activePreset) return;
    setSaving(true);
    try {
      const newPresets = { ...presets, [activePreset]: inputValues };
      const payload = {
        flowId,
        flowSource,
        archived: flowArchived,
        presets: newPresets,
        activePreset,
      };
      const resp = await fetch("/api/flow/run-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        setPresets(newPresets);
      }
    } finally {
      setSaving(false);
    }
  }, [flowId, flowSource, flowArchived, presets, activePreset, inputValues]);

  const presetOptions = Object.keys(presets);
  const hasPresets = presetOptions.length > 0;

  if (loading) {
    return (
      <aside className="af-run-config-panel">
        <div className="af-run-config-loading">{t("common.loading")}</div>
      </aside>
    );
  }

  return (
    <aside className="af-run-config-panel">
      <div className="af-run-config-preset">
        <label className="af-run-config-preset-label">
          {t("flow:runConfig.preset")}
        </label>
        <div className="af-run-config-preset-row">
          <select
            className="af-run-config-preset-select"
            value={activePreset || ""}
            onChange={(e) => handlePresetSelect(e.target.value || null)}
            disabled={saving}
          >
            <option value="">{t("flow:runConfig.default")}</option>
            {presetOptions.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <button
            type="button"
            className="af-run-config-preset-btn af-run-config-preset-btn--new"
            onClick={() => setShowSaveDialog(true)}
            disabled={saving}
            title={t("flow:runConfig.newPreset")}
          >
            <span className="material-symbols-outlined" aria-hidden>add</span>
          </button>
          {activePreset && (
            <button
              type="button"
              className="af-run-config-preset-btn af-run-config-preset-btn--save"
              onClick={handleUpdatePreset}
              disabled={saving}
              title={t("flow:runConfig.savePreset")}
            >
              <span className="material-symbols-outlined" aria-hidden>save</span>
            </button>
          )}
          {activePreset && (
            <button
              type="button"
              className="af-run-config-preset-btn af-run-config-preset-btn--delete"
              onClick={handleDeletePreset}
              disabled={saving}
              title={t("flow:runConfig.deletePreset")}
            >
              <span className="material-symbols-outlined" aria-hidden>delete</span>
            </button>
          )}
        </div>
      </div>

      {showSaveDialog && (
        <div className="af-run-config-save-dialog">
          <input
            type="text"
            className="af-run-config-save-input"
            placeholder={t("flow:runConfig.presetNamePlaceholder")}
            value={newPresetName}
            onChange={(e) => setNewPresetName(e.target.value)}
            disabled={saving}
          />
          <div className="af-run-config-save-actions">
            <button
              type="button"
              className="af-btn-primary"
              onClick={handleSavePreset}
              disabled={saving || !newPresetName.trim()}
            >
              {saving ? t("common.saving") : t("common.save")}
            </button>
            <button
              type="button"
              className="af-btn-outline"
              onClick={() => {
                setShowSaveDialog(false);
                setNewPresetName("");
              }}
              disabled={saving}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      <div className="af-run-config-inputs">
        <div className="af-run-config-inputs-header">
          {t("flow:runConfig.inputParams")}
        </div>
        {provideNodes.length === 0 ? (
          <div className="af-run-config-empty">
            {t("flow:runConfig.noProvideNodes")}
          </div>
        ) : (
          <div className="af-run-config-input-list">
            {provideNodes.map((node) => {
              const definitionId = node.data?.definitionId || "";
              const isFile = definitionId.startsWith("provide_file");
              const label = node.data?.label || node.id;
              const instanceId = node.id;
              const value = inputValues[instanceId] || "";
              return (
                <div key={instanceId} className="af-run-config-input-item">
                  <div className="af-run-config-input-head">
                    <span
                      className={
                        "af-run-config-input-icon material-symbols-outlined" +
                        (isFile ? " af-run-config-input-icon--file" : "")
                      }
                      aria-hidden
                    >
                      {isFile ? "description" : "text_fields"}
                    </span>
                    <span className="af-run-config-input-label">{label}</span>
                    <button
                      type="button"
                      className="af-run-config-input-expand"
                      onClick={() => setExpandedProvide({ instanceId, label, content: value })}
                      aria-label={t("flow:runConfig.expandInput")}
                      title={t("flow:runConfig.expandInput")}
                    >
                      <span className="material-symbols-outlined">open_in_full</span>
                    </button>
                  </div>
                  <div className="af-run-config-input-id">{instanceId}</div>
                  <input
                    type="text"
                    className="af-run-config-input-field"
                    value={value}
                    onChange={(e) => handleValueChange(instanceId, e.target.value)}
                    placeholder={
                      isFile
                        ? t("flow:runConfig.filePathPlaceholder")
                        : t("flow:runConfig.stringValuePlaceholder")
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {expandedProvide && createPortal(
        <div className="af-provide-edit-overlay">
          <div className="af-provide-edit-modal" role="dialog" aria-modal="true">
            <div className="af-provide-edit-modal__head">
              <span className="material-symbols-outlined">edit_document</span>
              <span className="af-provide-edit-modal__title">{expandedProvide.label}</span>
              <button
                type="button"
                className="af-provide-edit-modal__close"
                onClick={() => setExpandedProvide(null)}
                aria-label={t("common:close")}
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="af-provide-edit-modal__body">
              <textarea
                ref={expandedRef}
                className="af-provide-edit-modal__textarea"
                defaultValue={expandedProvide.content}
                autoFocus
              />
            </div>
            <div className="af-provide-edit-modal__foot">
              <button
                type="button"
                className="af-provide-edit-modal__btn af-provide-edit-modal__btn--save"
                onClick={() => {
                  if (!expandedProvide || !expandedRef.current) return;
                  handleValueChange(expandedProvide.instanceId, expandedRef.current.value);
                  setExpandedProvide(null);
                }}
              >
                <span className="material-symbols-outlined">save</span>
                {t("flow:provideEdit.save")}
              </button>
              <button
                type="button"
                className="af-provide-edit-modal__btn"
                onClick={() => setExpandedProvide(null)}
              >
                <span className="material-symbols-outlined">close</span>
                {t("flow:provideEdit.cancel")}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </aside>
  );
}

export default RunConfigPanel;