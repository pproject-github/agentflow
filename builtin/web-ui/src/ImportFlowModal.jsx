import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { peekSuggestedFlowIdFromZipFile } from "./zipPeekSuggestion.js";

/** 与 bin/lib/flow-write.mjs USER_PIPELINE_ID_RE 一致 */
const PIPELINE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * 由父组件在存在待导入文件时挂载；卸载即关闭。
 * @param {{ file: File, onClose: () => void, onImported: (flow: { id: string, source: string }) => void }} props
 */
export function ImportFlowModal({ file, onClose, onImported }) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const fileInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const [flowId, setFlowId] = useState("");
  const [targetSpace, setTargetSpace] = useState(/** @type {"user" | "workspace"} */ ("user"));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [pickedFile, setPickedFile] = useState(/** @type {File | null} */ (null));

  const activeFile = pickedFile ?? file;

  useEffect(() => {
    const frameId = requestAnimationFrame(() => panelRef.current?.focus());
    return () => cancelAnimationFrame(frameId);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const name = activeFile.name || "";
      const lower = name.toLowerCase();
      let suggested = "";

      if (lower.endsWith(".zip")) {
        suggested = (await peekSuggestedFlowIdFromZipFile(activeFile)) || "";
        if (!suggested) {
          const stem = name.replace(/\.zip$/i, "");
          if (PIPELINE_ID_RE.test(stem)) suggested = stem;
        }
      } else if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
        const stem = name.replace(/\.ya?ml$/i, "");
        if (PIPELINE_ID_RE.test(stem)) suggested = stem;
      }

      if (!cancelled) setFlowId(suggested);
    })();

    return () => {
      cancelled = true;
    };
  }, [activeFile]);

  const trimmedId = flowId.trim();
  const idOk = trimmedId.length > 0 && PIPELINE_ID_RE.test(trimmedId);

  async function submitForm(e) {
    e.preventDefault();
    if (!idOk || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const fd = new FormData();
      fd.set("flowId", trimmedId);
      fd.set("targetSpace", targetSpace);
      fd.set("file", activeFile, activeFile.name);
      const r = await fetch("/api/flows/import", {
        method: "POST",
        body: fd,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(typeof j.error === "string" ? j.error : t("project:importModal.importFailed"));
        return;
      }
      onImported({ id: j.flowId, source: j.flowSource ?? "user" });
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="af-shortcuts-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="af-shortcuts-panel af-new-pipeline-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="af-shortcuts-panel__head">
          <h2 id={titleId} className="af-shortcuts-panel__title">
            {t("project:importModal.title")}
          </h2>
          <button type="button" className="af-shortcuts-panel__close af-icon-btn" onClick={onClose} aria-label={t("project:importModal.close")}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <form className="af-shortcuts-panel__body af-new-pipeline-form" onSubmit={submitForm}>
          <p className="af-new-pipeline-lead">
            {t("project:importModal.lead", { filename: activeFile.name })}
          </p>

          <input
            ref={fileInputRef}
            type="file"
            className="af-import-file-input"
            accept=".yaml,.yml,.zip,application/zip"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setPickedFile(f);
              e.target.value = "";
            }}
          />

          <label className="af-pipeline-drawer-field">
            <span className="af-pipeline-drawer-label">{t("project:importModal.nameLabel")}</span>
            <input
              className="af-new-pipeline-input"
              type="text"
              name="importFlowId"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("project:importModal.namePlaceholder")}
              value={flowId}
              onChange={(e) => setFlowId(e.target.value)}
              aria-invalid={trimmedId.length > 0 && !idOk}
            />
            <span className="af-pipeline-drawer-muted af-new-pipeline-hint">
              {t("project:importModal.nameHint")}
            </span>
          </label>

          <fieldset className="af-new-pipeline-fieldset">
            <legend className="af-pipeline-drawer-label">{t("project:importModal.locationLabel")}</legend>
            <label className="af-new-pipeline-radio">
              <input
                type="radio"
                name="importTargetSpace"
                value="user"
                checked={targetSpace === "user"}
                onChange={() => setTargetSpace("user")}
              />
              <span>{t("project:importModal.userDir")}</span>
            </label>
            <label className="af-new-pipeline-radio">
              <input
                type="radio"
                name="importTargetSpace"
                value="workspace"
                checked={targetSpace === "workspace"}
                onChange={() => setTargetSpace("workspace")}
              />
              <span>{t("project:importModal.workspaceDir")}</span>
            </label>
          </fieldset>

          <div className="af-import-repick">
            <button type="button" className="af-btn-secondary af-import-repick-btn" onClick={() => fileInputRef.current?.click()}>
              {t("project:importModal.changeFile")}
            </button>
          </div>

          {error ? <p className="af-err af-new-pipeline-err">{error}</p> : null}

          <div className="af-new-pipeline-actions">
            <button type="button" className="af-btn-secondary" onClick={onClose} disabled={submitting}>
              {t("project:importModal.cancel")}
            </button>
            <button type="submit" className="af-btn-primary" disabled={!idOk || submitting}>
              {submitting ? t("project:importModal.importing") : t("project:importModal.importAndOpen")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
