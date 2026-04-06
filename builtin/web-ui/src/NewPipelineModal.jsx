import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** 与 bin/lib/flow-write.mjs USER_PIPELINE_ID_RE 一致 */
const PIPELINE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * @param {{ open: boolean, onClose: () => void, onCreated: (flow: { id: string, source: string }) => void }} props
 */
export function NewPipelineModal({ open, onClose, onCreated }) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [targetSpace, setTargetSpace] = useState(/** @type {"user" | "workspace"} */ ("user"));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setTargetSpace("user");
    setError("");
    setSubmitting(false);
    const t = requestAnimationFrame(() => panelRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [open]);

  if (!open) return null;

  const trimmedName = name.trim();
  const nameOk = trimmedName.length > 0 && PIPELINE_ID_RE.test(trimmedName);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!nameOk || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const r = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flowId: trimmedName,
          description: description.trim(),
          targetSpace,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(typeof j.error === "string" ? j.error : t("project:newPipelineModal.createFailed"));
        return;
      }
      onCreated({ id: j.flowId, source: j.flowSource ?? "user" });
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
            {t("project:newPipelineModal.title")}
          </h2>
          <button type="button" className="af-shortcuts-panel__close af-icon-btn" onClick={onClose} aria-label={t("project:newPipelineModal.close")}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <form className="af-shortcuts-panel__body af-new-pipeline-form" onSubmit={handleSubmit}>
          <p className="af-new-pipeline-lead">
            {t("project:newPipelineModal.lead")}
          </p>

          <label className="af-pipeline-drawer-field">
            <span className="af-pipeline-drawer-label">{t("project:newPipelineModal.nameLabel")}</span>
            <input
              className="af-new-pipeline-input"
              type="text"
              name="pipelineName"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("project:newPipelineModal.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={trimmedName.length > 0 && !nameOk}
            />
            <span className="af-pipeline-drawer-muted af-new-pipeline-hint">
              {t("project:newPipelineModal.nameHint")}
            </span>
          </label>

          <label className="af-pipeline-drawer-field">
            <span className="af-pipeline-drawer-label">{t("project:newPipelineModal.descLabel")}</span>
            <textarea
              className="af-pipeline-drawer-textarea af-new-pipeline-textarea"
              name="pipelineDescription"
              rows={3}
              placeholder={t("project:newPipelineModal.descPlaceholder")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          <fieldset className="af-new-pipeline-fieldset">
            <legend className="af-pipeline-drawer-label">{t("project:newPipelineModal.locationLabel")}</legend>
            <label className="af-new-pipeline-radio">
              <input
                type="radio"
                name="targetSpace"
                value="user"
                checked={targetSpace === "user"}
                onChange={() => setTargetSpace("user")}
              />
              <span>{t("project:newPipelineModal.userDir")}</span>
            </label>
            <label className="af-new-pipeline-radio">
              <input
                type="radio"
                name="targetSpace"
                value="workspace"
                checked={targetSpace === "workspace"}
                onChange={() => setTargetSpace("workspace")}
              />
              <span>{t("project:newPipelineModal.workspaceDir")}</span>
            </label>
          </fieldset>

          {error ? <p className="af-err af-new-pipeline-err">{error}</p> : null}

          <div className="af-new-pipeline-actions">
            <button type="button" className="af-btn-secondary" onClick={onClose} disabled={submitting}>
              {t("project:newPipelineModal.cancel")}
            </button>
            <button type="submit" className="af-btn-primary" disabled={!nameOk || submitting}>
              {submitting ? t("project:newPipelineModal.creating") : t("project:newPipelineModal.createAndOpen")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
