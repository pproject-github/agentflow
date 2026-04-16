import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   flowId: string,
 *   flowSource: string,
 *   flowArchived?: boolean,
 *   filePath: string,
 *   fileName: string,
 *   onSaved?: () => void,
 *   onAiEdit?: (content: string) => Promise<string>,
 * }} props
 */
export function FileEditModal({ open, onClose, flowId, flowSource, flowArchived = false, filePath, fileName, onSaved, onAiEdit }) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const textareaRef = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    if (!open || !filePath) return;
    setContent("");
    setOriginalContent("");
    setError("");
    setSuccess("");
    setLoading(true);
    setSaving(false);
    setAiRunning(false);
    const params = new URLSearchParams({
      flowId,
      flowSource,
      archived: flowArchived ? "1" : "0",
      path: filePath,
    });
    (async () => {
      try {
        const r = await fetch(`/api/pipeline-file-content?${params}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        setContent(j.content || "");
        setOriginalContent(j.content || "");
      } catch (e) {
        setError(e.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
    const t = requestAnimationFrame(() => panelRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [open, filePath, flowId, flowSource, flowArchived]);

  if (!open) return null;

  const hasChanges = content !== originalContent;

  async function handleSave(e) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const params = new URLSearchParams({
        flowId,
        flowSource,
        archived: flowArchived ? "1" : "0",
        path: filePath,
      });
      const r = await fetch(`/api/pipeline-file-save?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      setOriginalContent(content);
      setSuccess(t("flow:fileEdit.saved"));
      if (onSaved) onSaved();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleAiEdit() {
    if (!onAiEdit || aiRunning || !content) return;
    setAiRunning(true);
    setError("");
    try {
      const newContent = await onAiEdit(content);
      if (typeof newContent === "string" && newContent) {
        setContent(newContent);
      }
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setAiRunning(false);
    }
  }

  function handleReset() {
    setContent(originalContent);
    setError("");
    setSuccess("");
  }

  const isLargeFile = content.length > 100000;

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
        className="af-shortcuts-panel af-file-edit-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="af-shortcuts-panel__head">
          <h2 id={titleId} className="af-shortcuts-panel__title">
            {fileName || filePath}
          </h2>
          <button type="button" className="af-shortcuts-panel__close af-icon-btn" onClick={onClose} aria-label={t("flow:fileEdit.close")}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="af-file-edit-body">
          {loading ? (
            <div className="af-file-edit-loading">{t("flow:fileEdit.loading")}</div>
          ) : error && !content ? (
            <div className="af-file-edit-error">{error}</div>
          ) : (
            <>
              {isLargeFile && (
                <div className="af-file-edit-warning">
                  {t("flow:fileEdit.largeFileWarning")}
                </div>
              )}
              <textarea
                ref={textareaRef}
                className="af-file-edit-textarea"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                spellCheck={false}
                placeholder={t("flow:fileEdit.placeholder")}
              />
            </>
          )}
        </div>

        {(error || success) && !loading && (
          <div className={`af-file-edit-status${success ? " af-file-edit-status--success" : ""}`}>
            {success || error}
          </div>
        )}

        <div className="af-file-edit-actions">
          <button type="button" className="af-btn-secondary" onClick={handleReset} disabled={!hasChanges || saving || aiRunning}>
            {t("flow:fileEdit.reset")}
          </button>
          {onAiEdit && (
            <button type="button" className="af-btn-secondary af-btn-ai" onClick={handleAiEdit} disabled={aiRunning || saving || !content}>
              {aiRunning ? t("flow:fileEdit.aiRunning") : t("flow:fileEdit.aiEdit")}
            </button>
          )}
          <button type="button" className="af-btn-primary" onClick={handleSave} disabled={!hasChanges || saving || aiRunning}>
            {saving ? t("flow:fileEdit.saving") : t("flow:fileEdit.save")}
          </button>
        </div>
      </div>
    </div>
  );
}