import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const PIPELINE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const GUIDE_KEY = "af:newPipelineGuide";

export function NewPipelineModal({ open, onClose, onCreated }) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [targetSpace, setTargetSpace] = useState("user");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setTargetSpace("user");
    setError("");
    setSubmitting(false);
    
    const needGuide = localStorage.getItem(GUIDE_KEY) === "true";
    if (needGuide) {
      setShowGuide(true);
    }
    
    const raf = requestAnimationFrame(() => panelRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const hideGuide = () => {
    localStorage.removeItem(GUIDE_KEY);
    setShowGuide(false);
  };

  if (!open) return null;

  const trimmedName = name.trim();
  const nameOk = trimmedName.length > 0 && PIPELINE_ID_RE.test(trimmedName);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!nameOk || submitting) return;
    setSubmitting(true);
    setError("");
    hideGuide();
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
        if (e.target === e.currentTarget) {
          hideGuide();
          onClose();
        }
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
          <div className="af-new-pipeline-types">
            <div className="af-new-pipeline-type" title={t("onboarding:newPipeline.typeNode")}>
              <span className="af-new-pipeline-type-dot" style={{ background: "#ff9800" }} />
              <span className="af-new-pipeline-type-label">node</span>
            </div>
            <div className="af-new-pipeline-type" title={t("onboarding:newPipeline.typeStr")}>
              <span className="af-new-pipeline-type-dot" style={{ background: "#2196f3" }} />
              <span className="af-new-pipeline-type-label">str</span>
            </div>
            <div className="af-new-pipeline-type" title={t("onboarding:newPipeline.typeFile")}>
              <span className="af-new-pipeline-type-dot" style={{ background: "#4caf50" }} />
              <span className="af-new-pipeline-type-label">file</span>
            </div>
            <div className="af-new-pipeline-type" title={t("onboarding:newPipeline.typeBool")}>
              <span className="af-new-pipeline-type-dot" style={{ background: "#9c27b0" }} />
              <span className="af-new-pipeline-type-label">bool</span>
            </div>
          </div>
          <button type="button" className="af-shortcuts-panel__close af-icon-btn" onClick={() => { hideGuide(); onClose(); }} aria-label={t("project:newPipelineModal.close")}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {showGuide ? (
          <div className="af-new-pipeline-guide">
            <div className="af-new-pipeline-guide-content">
              <span className="material-symbols-outlined af-new-pipeline-guide-icon">lightbulb</span>
              <div className="af-new-pipeline-guide-text">
                <p><strong>{t("onboarding:newPipeline.guideTitle")}</strong></p>
                <p>{t("onboarding:newPipeline.guideDesc")}</p>
              </div>
              <button type="button" className="af-new-pipeline-guide-close" onClick={hideGuide}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
          </div>
        ) : null}

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
              {showGuide ? t("onboarding:newPipeline.nameHintGuide") : t("project:newPipelineModal.nameHint")}
            </span>
          </label>

          <label className="af-pipeline-drawer-field">
            <span className="af-pipeline-drawer-label">{t("project:newPipelineModal.descLabel")}</span>
            <textarea
              className="af-pipeline-drawer-textarea af-new-pipeline-textarea"
              name="pipelineDescription"
              rows={3}
              placeholder={showGuide ? t("onboarding:newPipeline.descPlaceholderGuide") : t("project:newPipelineModal.descPlaceholder")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            {showGuide ? (
              <span className="af-pipeline-drawer-muted af-new-pipeline-guide-hint">
                {t("onboarding:newPipeline.descHintGuide")}
              </span>
            ) : null}
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
            <button type="button" className="af-btn-secondary" onClick={() => { hideGuide(); onClose(); }} disabled={submitting}>
              {t("project:newPipelineModal.cancel")}
            </button>
            <button type="submit" className="af-btn-primary" disabled={!nameOk || submitting}>
              {submitting ? t("project:newPipelineModal.creating") : (showGuide ? t("onboarding:newPipeline.createGuide") : t("project:newPipelineModal.createAndOpen"))}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}