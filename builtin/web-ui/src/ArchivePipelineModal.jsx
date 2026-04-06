import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   flowId: string,
 *   flowSource: string,
 *   onArchived: () => void,
 * }} props
 */
export function ArchivePipelineModal({ open, onClose, flowId, flowSource, onArchived }) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setConfirmText("");
    setError("");
    setSubmitting(false);
    const t = requestAnimationFrame(() => panelRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [open, flowId]);

  if (!open) return null;

  const trimmed = confirmText.trim();
  const matches = trimmed === flowId;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!matches || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const r = await fetch("/api/flow/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flowId,
          flowSource,
          confirmFlowId: trimmed,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(typeof j.error === "string" ? j.error : t("project:archiveModal.archiveFailed"));
        return;
      }
      onArchived();
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
            {t("project:archiveModal.title")}
          </h2>
          <button type="button" className="af-shortcuts-panel__close af-icon-btn" onClick={onClose} aria-label={t("project:archiveModal.close")}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <form className="af-shortcuts-panel__body af-new-pipeline-form" onSubmit={handleSubmit}>
          <p className="af-new-pipeline-lead">
            {t("project:archiveModal.lead", { flowId })}
          </p>
          <label className="af-new-pipeline-field">
            <span className="af-pipeline-drawer-label">{t("project:archiveModal.confirmLabel")}</span>
            <input
              type="text"
              className="af-new-pipeline-input"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={flowId}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={trimmed.length > 0 && !matches}
            />
          </label>

          {error ? <p className="af-err af-new-pipeline-err">{error}</p> : null}

          <div className="af-new-pipeline-actions">
            <button type="button" className="af-btn-secondary" onClick={onClose} disabled={submitting}>
              {t("project:archiveModal.cancel")}
            </button>
            <button type="submit" className="af-btn-primary" disabled={!matches || submitting}>
              {submitting ? t("project:archiveModal.archiving") : t("project:archiveModal.confirmArchive")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
