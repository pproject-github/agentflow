import { useEffect, useId, useRef, useState } from "react";

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
        setError(typeof j.error === "string" ? j.error : "归档失败");
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
            归档流水线
          </h2>
          <button type="button" className="af-shortcuts-panel__close af-icon-btn" onClick={onClose} aria-label="关闭">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <form className="af-shortcuts-panel__body af-new-pipeline-form" onSubmit={handleSubmit}>
          <p className="af-new-pipeline-lead">
            归档后流水线将移入「Archived」列表，仍可从该列表打开与编辑。请在下方输入流水线 ID「<strong>{flowId}</strong>」以确认。
          </p>
          <label className="af-new-pipeline-field">
            <span className="af-pipeline-drawer-label">确认流水线名称</span>
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
              取消
            </button>
            <button type="submit" className="af-btn-primary" disabled={!matches || submitting}>
              {submitting ? "归档中…" : "确认归档"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
