import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   flowId: string,
 *   flowSource: string,
 *   flowArchived?: boolean,
 *   workspaceId?: string,
 *   leaveShared?: boolean,
 *   onDeleted: () => void,
 * }} props
 */
export function DeletePipelineModal({ open, onClose, flowId, flowSource, flowArchived = false, workspaceId = "", leaveShared = false, onDeleted }) {
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
  const matches = leaveShared || trimmed === flowId;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!matches || submitting) return;
    setSubmitting(true);
    setError("");
    let timer = null;
    try {
      const ac = new AbortController();
      timer = setTimeout(() => ac.abort(), 15000);
      const r = await fetch("/api/flow/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flowId,
          flowSource,
          confirmFlowId: leaveShared ? flowId : trimmed,
          flowArchived,
          workspaceId,
        }),
        signal: ac.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(typeof j.error === "string" ? j.error : t("project:deleteModal.deleteFailed"));
        return;
      }
      // 清理浏览器侧的 AI Composer 对话记录（key 形如 af:composer-sessions:<flowId>:<flowSource>[:archived]）
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (!k) continue;
          if (
            k.startsWith(`af:composer-sessions:${flowId}:${flowSource}`) ||
            k.startsWith(`af:composer-active-session:${flowId}:${flowSource}`) ||
            k.startsWith(`af:workspace-composer:${flowId}:${flowSource}`)
          ) {
            localStorage.removeItem(k);
          }
        }
      } catch {
        // 忽略 localStorage 异常
      }
      await onDeleted();
    } catch (err) {
      if (err?.name === "AbortError") {
        setError(t("project:deleteModal.deleteTimeout"));
        return;
      }
      setError(String(err?.message || err));
    } finally {
      if (timer) clearTimeout(timer);
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
            {leaveShared ? "退出共享 Workspace" : t("project:deleteModal.title")}
          </h2>
          <button type="button" className="af-shortcuts-panel__close af-icon-btn" onClick={onClose} aria-label={t("project:deleteModal.close")}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <form className="af-shortcuts-panel__body af-new-pipeline-form" onSubmit={handleSubmit}>
          <p className="af-new-pipeline-lead">
            {leaveShared
              ? `退出后，${flowId} 将从你的项目列表移除；源项目和其他成员的数据不会被删除。`
              : t("project:deleteModal.lead", { flowId })}
          </p>
          {!leaveShared ? (
            <label className="af-new-pipeline-field">
              <span className="af-pipeline-drawer-label">{t("project:deleteModal.confirmLabel")}</span>
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
          ) : null}

          {error ? <p className="af-err af-new-pipeline-err">{error}</p> : null}

          <div className="af-new-pipeline-actions">
            <button type="button" className="af-btn-secondary" onClick={onClose} disabled={submitting}>
              {t("project:deleteModal.cancel")}
            </button>
            <button type="submit" className="af-btn-primary af-btn-destructive" disabled={!matches || submitting}>
              {submitting
                ? leaveShared ? "退出中..." : t("project:deleteModal.deleting")
                : leaveShared ? "确认退出" : t("project:deleteModal.confirmDelete")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
