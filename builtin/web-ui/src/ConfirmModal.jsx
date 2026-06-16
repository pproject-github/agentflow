import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";

/**
 * 端内风格确认对话框，替代 window.confirm。
 * 可选 `secondaryLabel` + `onSecondary` 在取消与确认之间渲染第三个按钮。
 * @param {{
 *   open: boolean,
 *   title?: string,
 *   message: string | React.ReactNode,
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   destructive?: boolean,
 *   secondaryLabel?: string,
 *   secondaryDestructive?: boolean,
 *   onSecondary?: () => void,
 *   onConfirm: () => void,
 *   onCancel: () => void,
 * }} props
 */
export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive = false,
  secondaryLabel,
  secondaryDestructive = false,
  onSecondary,
  onConfirm,
  onCancel,
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef(/** @type {HTMLDivElement | null} */ (null));

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => panelRef.current?.focus());
    function onKey(e) {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  const confirmText = confirmLabel ?? t("common:common.confirm", "确定");
  const cancelText = cancelLabel ?? t("common:common.cancel", "取消");
  const titleText = title ?? t("common:common.confirmTitle", "请确认");

  return (
    <div
      className="af-shortcuts-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
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
            {titleText}
          </h2>
          <button
            type="button"
            className="af-shortcuts-panel__close af-icon-btn"
            onClick={onCancel}
            aria-label={cancelText}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="af-shortcuts-panel__body af-new-pipeline-form">
          <p className="af-new-pipeline-lead">{message}</p>
          <div className="af-new-pipeline-actions">
            <button type="button" className="af-btn-secondary" onClick={onCancel}>
              {cancelText}
            </button>
            {secondaryLabel && onSecondary ? (
              <button
                type="button"
                className={secondaryDestructive ? "af-btn-secondary af-btn-destructive" : "af-btn-secondary"}
                onClick={onSecondary}
              >
                {secondaryLabel}
              </button>
            ) : null}
            <button
              type="button"
              className={destructive ? "af-btn-primary af-btn-destructive" : "af-btn-primary"}
              onClick={onConfirm}
              autoFocus
            >
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
