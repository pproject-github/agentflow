import { Handle, Position } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { getHandleColor } from "./nodeSchema.js";
import { IMAGE_TOKEN_RE, addImageFiles, filterImagesReferencedByBody, imageFilesFromClipboardEvent, imageFilesFromDropEvent, normalizeImages } from "./imageAttachments.js";

function modelEntryId(entry) {
  const idx = entry.indexOf(" - ");
  return idx >= 0 ? entry.slice(0, idx).trim() : entry.trim();
}

function getNodeTypeLabel(data) {
  const id = data?.definitionId?.trim();
  // 如果 definitionId 存在且不是默认值"普通"，则显示它
  if (id && id !== "普通") return id;
  // 否则显示 schemaType，避免显示"普通"作为类型标签
  const schemaType = (data?.schemaType ?? "agent").toLowerCase();
  if (schemaType && schemaType !== "普通") return schemaType;
  return "agent";
}

function boolValueFromSlot(slot) {
  return ["true", "1", "yes", "on"].includes(String(slot?.value ?? slot?.default ?? "").trim().toLowerCase());
}

function stopInteractiveEvent(e) {
  e.stopPropagation();
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeImageToken(body, label) {
  const token = `\\[${escapeRegExp(label)}\\]`;
  return String(body || "")
    .replace(new RegExp(`[ \\t]*${token}`, "gi"), "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderImageTokenHighlightHtml(text) {
  const raw = String(text || "");
  let html = "";
  let last = 0;
  IMAGE_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = IMAGE_TOKEN_RE.exec(raw))) {
    html += escapeHtml(raw.slice(last, match.index));
    html += `<span class="af-flow-node__image-token">${escapeHtml(match[0])}</span>`;
    last = match.index + match[0].length;
  }
  html += escapeHtml(raw.slice(last));
  return html || " ";
}

function normalizeGuideList(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function NodeGuideDialog({ nodeTitle, definitionId, description, guide, inputs, outputs, onClose }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const summary = String(guide?.summary || description || "").trim();
  const prerequisites = normalizeGuideList(guide?.prerequisites);
  const steps = normalizeGuideList(guide?.steps);
  const notes = normalizeGuideList(guide?.notes);
  const example = String(guide?.example || "").trim();

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const copyExample = async () => {
    if (!example || typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(example);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (_) {}
  };

  const renderSlots = (slots, kind) => (
    <div className="af-node-guide__slots">
      {(Array.isArray(slots) ? slots : []).map((slot, index) => {
        const name = String(slot?.name || `#${index + 1}`);
        const type = String(slot?.type || "node");
        const defaultValue = String(slot?.default ?? slot?.value ?? "");
        return (
          <div key={`${kind}-${index}-${name}`} className="af-node-guide__slot">
            <div className="af-node-guide__slot-head">
              <code>{name}</code>
              <span>{type}</span>
              <em className={slot?.required ? "is-required" : ""}>
                {slot?.required ? t("flow:node.guideRequired") : t("flow:node.guideOptional")}
              </em>
            </div>
            {slot?.description ? <p>{String(slot.description)}</p> : null}
            {defaultValue !== "" ? <small>{t("flow:node.guideDefault", { value: defaultValue })}</small> : null}
          </div>
        );
      })}
    </div>
  );

  return createPortal(
    <div
      className="af-node-guide nodrag"
      role="presentation"
      onClick={onClose}
      onPointerDown={stopInteractiveEvent}
      onMouseDown={stopInteractiveEvent}
      onWheel={stopInteractiveEvent}
    >
      <section
        className="af-node-guide__panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${nodeTitle} · ${t("flow:node.guideTitle")}`}
        onClick={stopInteractiveEvent}
      >
        <header className="af-node-guide__header">
          <div className="af-node-guide__heading">
            <span className="material-symbols-outlined" aria-hidden="true">help</span>
            <div>
              <h2>{nodeTitle}</h2>
              <p>{definitionId} · {t("flow:node.guideTitle")}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label={t("flow:node.guideClose")} title={t("flow:node.guideClose")}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </header>
        <div className="af-node-guide__content">
          {summary ? (
            <section>
              <h3>{t("flow:node.guideSummary")}</h3>
              <p>{summary}</p>
            </section>
          ) : null}
          {prerequisites.length ? (
            <section>
              <h3>{t("flow:node.guidePrerequisites")}</h3>
              <ul>{prerequisites.map((item, index) => <li key={`pre-${index}`}>{item}</li>)}</ul>
            </section>
          ) : null}
          {steps.length ? (
            <section>
              <h3>{t("flow:node.guideSteps")}</h3>
              <ol>{steps.map((item, index) => <li key={`step-${index}`}>{item}</li>)}</ol>
            </section>
          ) : null}
          {inputs?.length ? (
            <section>
              <h3>{t("flow:node.guideInputs")}</h3>
              {renderSlots(inputs, "input")}
            </section>
          ) : null}
          {outputs?.length ? (
            <section>
              <h3>{t("flow:node.guideOutputs")}</h3>
              {renderSlots(outputs, "output")}
            </section>
          ) : null}
          {example ? (
            <section>
              <div className="af-node-guide__section-heading">
                <h3>{t("flow:node.guideExample")}</h3>
                <button type="button" className="af-node-guide__copy" onClick={copyExample}>
                  <span className="material-symbols-outlined" aria-hidden="true">{copied ? "check" : "content_copy"}</span>
                  {copied ? t("flow:node.guideCopied") : t("flow:node.guideCopy")}
                </button>
              </div>
              <pre>{example}</pre>
            </section>
          ) : null}
          {notes.length ? (
            <section>
              <h3>{t("flow:node.guideNotes")}</h3>
              <ul>{notes.map((item, index) => <li key={`note-${index}`}>{item}</li>)}</ul>
            </section>
          ) : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function promptEditorHeightForText(el, text) {
  const style = window.getComputedStyle(el);
  const lineHeight = Number.parseFloat(style.lineHeight) || 18;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
  const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
  const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
  const lineCount = String(text || "").split(/\r\n|\r|\n/).length;
  const rows = Math.min(Math.max(lineCount, 2), 8);
  return Math.ceil(rows * lineHeight + paddingTop + paddingBottom + borderTop + borderBottom);
}

export function FlowNode({
  data,
  selected,
  id,
  deleteNode,
  onProvideExpand,
  onProvideValueChange,
  onNodeBodyChange,
  onNodeImagesChange,
  modelLists,
  onModelChange,
  deferTextCommit = false,
}) {
  const { t } = useTranslation();
  const inputs = data?.inputs ?? [];
  const outputs = data?.outputs ?? [];
  const schemaType = (data?.schemaType ?? "agent").toLowerCase();
  const typeLabel = getNodeTypeLabel(data);
  const isRunMode = data?.isRunMode ?? false;
  const readOnly = Boolean(data?.readOnly);
  const isExecuting = data?.isExecuting ?? false;
  const isDim = data?.isDim ?? false;
  const nodeStatus = data?.nodeStatus ?? null;
  const nodeElapsed = data?.nodeElapsed ?? null;
  const nodeRunDetail = data?.nodeRunDetail ?? null;
  const definitionId = data?.definitionId || "";
  const isJenkinsBuild = definitionId === "tool_jenkins_build";
  const jenkinsDisplayStatus = String(
    nodeRunDetail?.jenkinsStatus ||
      (nodeRunDetail?.phase === "queued" ? "QUEUED" : nodeRunDetail?.phase === "running" ? "RUNNING" : ""),
  ).toUpperCase();
  const isProvideNode = definitionId.startsWith("provide_");
  const isProvideBool = definitionId === "provide_bool";
  const isProvideText = definitionId === "provide_str";
  const isProvideFile = definitionId === "provide_file";
  const isProvidePassword = definitionId === "provide_password";
  const isSubAgent = definitionId === "agent_subAgent";
  const isAgentToBool = definitionId === "control_agent_toBool";
  const hasInlineBodyEditor = (isSubAgent || isAgentToBool) && !isRunMode;
  const provideBoolValue = isProvideBool ? boolValueFromSlot(outputs[0]) : false;
  const provideValue = isProvideNode ? String(outputs[0]?.value ?? outputs[0]?.default ?? data?.body ?? "") : "";
  const bodyValue = String(data?.body || "");
  const nodeTitle = data?.displayLabel || data?.label || t("flow:node.fallbackLabel");
  const bodyPreview = !isProvideNode && !hasInlineBodyEditor && data?.showBodyPreview ? String(data?.body || "").trim() : "";
  const images = normalizeImages(data?.images);
  const hasNodeBodyContent =
    isProvideBool ||
    isProvideText ||
    isProvideFile ||
    isProvidePassword ||
    hasInlineBodyEditor ||
    Boolean(bodyPreview);
  const provideComposingRef = useRef(false);
  const bodyComposingRef = useRef(false);
  const bodyPromptStackRef = useRef(null);
  const bodyTextareaRef = useRef(null);
  const bodyBackdropRef = useRef(null);
  const bodyPromptScrollbarTrackRef = useRef(null);
  const bodyFullscreenTextareaRef = useRef(null);
  const [provideDraft, setProvideDraft] = useState(provideValue);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [bodyDraft, setBodyDraft] = useState(bodyValue);
  const [bodyComposing, setBodyComposing] = useState(false);
  const [bodyPromptScrollbar, setBodyPromptScrollbar] = useState({ visible: false, top: 0, height: 100 });
  const [bodyFullscreenEditor, setBodyFullscreenEditor] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  const updateBodyPromptScrollbar = useCallback(() => {
    const el = bodyTextareaRef.current;
    if (!el) return;
    const scrollHeight = Math.max(1, el.scrollHeight);
    const clientHeight = Math.max(1, el.clientHeight);
    const visible = scrollHeight > clientHeight + 1;
    const height = visible ? Math.max(12, (clientHeight / scrollHeight) * 100) : 100;
    const maxTop = Math.max(0, 100 - height);
    const top = visible ? Math.min(maxTop, (el.scrollTop / Math.max(1, scrollHeight - clientHeight)) * maxTop) : 0;
    setBodyPromptScrollbar({ visible, top, height });
  }, []);

  useEffect(() => {
    if (!provideComposingRef.current) setProvideDraft(provideValue);
  }, [id, provideValue]);

  useEffect(() => {
    if (!bodyComposingRef.current) setBodyDraft(bodyValue);
  }, [id, bodyValue]);

  useEffect(() => {
    const el = bodyTextareaRef.current;
    if (!el) return;
    if (hasInlineBodyEditor) {
      el.style.minHeight = "";
      el.style.height = "";
      if (bodyBackdropRef.current) {
        bodyBackdropRef.current.style.minHeight = "";
        bodyBackdropRef.current.style.height = "";
      }
      return;
    }
    const desiredHeight = promptEditorHeightForText(el, bodyDraft);
    el.style.minHeight = `${desiredHeight}px`;
    el.style.height = "";
    if (bodyBackdropRef.current) {
      bodyBackdropRef.current.style.minHeight = `${desiredHeight}px`;
      bodyBackdropRef.current.style.height = "";
    }
  }, [bodyDraft, hasInlineBodyEditor]);

  useEffect(() => {
    if (!hasInlineBodyEditor) return undefined;
    const frame = window.requestAnimationFrame(updateBodyPromptScrollbar);
    const el = bodyTextareaRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return () => window.cancelAnimationFrame(frame);
    }
    const observer = new ResizeObserver(updateBodyPromptScrollbar);
    observer.observe(el);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [bodyDraft, hasInlineBodyEditor, updateBodyPromptScrollbar]);

  useEffect(() => {
    const el = bodyPromptStackRef.current;
    const notifyResize = data?.onNodeContentResize;
    if (!hasInlineBodyEditor || !el || !notifyResize || typeof ResizeObserver === "undefined") return undefined;
    let raf = 0;
    const notify = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => notifyResize(id));
    };
    const observer = new ResizeObserver(notify);
    observer.observe(el);
    notify();
    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [data?.onNodeContentResize, hasInlineBodyEditor, id]);

  useEffect(() => {
    if (!bodyFullscreenEditor) return undefined;
    const focusTimer = window.setTimeout(() => {
      const el = bodyFullscreenTextareaRef.current;
      if (!el) return;
      el.focus();
      const pos = el.value.length;
      el.setSelectionRange(pos, pos);
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [bodyFullscreenEditor]);

  const cursorList = Array.isArray(modelLists?.cursor) ? modelLists.cursor : [];
  const opencodeList = Array.isArray(modelLists?.opencode) ? modelLists.opencode : [];
  const claudeCodeList = Array.isArray(modelLists?.claudeCode) ? modelLists.claudeCode : [];
  const codexList = Array.isArray(modelLists?.codex) ? modelLists.codex : [];
  const rawModel = (data?.model ?? "").trim();
  const needsModel = schemaType === "agent" && !definitionId.startsWith("tool_nodejs");

  const cursorIds = new Set(cursorList.map(modelEntryId));
  const opencodeIds = new Set(opencodeList.map(modelEntryId));
  const claudeCodeIds = new Set(claudeCodeList.map(modelEntryId));
  const codexIds = new Set(codexList.map(modelEntryId));

  const normalizedModelForSelect = (() => {
    if (!rawModel) return "";
    if (
      rawModel.startsWith("cursor:") ||
      rawModel.startsWith("opencode:") ||
      rawModel.startsWith("codex:") ||
      rawModel.startsWith("claude-code:")
    ) return rawModel;
    if (claudeCodeIds.has(rawModel)) return `claude-code:${rawModel}`;
    if (codexIds.has(rawModel)) return `codex:${rawModel}`;
    if (opencodeIds.has(rawModel)) return `opencode:${rawModel}`;
    if (cursorIds.has(rawModel)) return `cursor:${rawModel}`;
    return rawModel;
  })();

  const modelNotInLists =
    rawModel &&
    !normalizedModelForSelect.startsWith("cursor:") &&
    !normalizedModelForSelect.startsWith("opencode:") &&
    !normalizedModelForSelect.startsWith("codex:") &&
    !normalizedModelForSelect.startsWith("claude-code:") &&
    !cursorIds.has(rawModel) &&
    !opencodeIds.has(rawModel) &&
    !claudeCodeIds.has(rawModel) &&
    !codexIds.has(rawModel);

  const displayModel = rawModel.startsWith("cursor:")
    ? rawModel.slice(7)
    : rawModel.startsWith("opencode:")
      ? rawModel.slice(9)
      : rawModel.startsWith("codex:")
        ? rawModel.slice(6)
      : rawModel.startsWith("claude-code:")
        ? rawModel.slice(12)
        : rawModel;

  const handleModelChange = (e) => {
    if (readOnly) return;
    const newModel = e.target.value;
    if (onModelChange) {
      onModelChange(id, newModel);
    }
  };

  const handleDelete = (e) => {
    e.stopPropagation();
    if (readOnly) return;
    if (deleteNode) {
      deleteNode(id);
    }
  };

  const handleExpand = (e) => {
    e.stopPropagation();
    if (onProvideExpand) {
      onProvideExpand();
    }
  };

  const handleProvideBoolChange = (e) => {
    e.stopPropagation();
    if (readOnly) return;
    onProvideValueChange?.(id, e.target.value === "true" ? "true" : "false");
  };

  const handleProvideValueChange = (e) => {
    e.stopPropagation();
    if (readOnly) return;
    const next = e.target.value;
    setProvideDraft(next);
    if (!deferTextCommit && !provideComposingRef.current) {
      onProvideValueChange?.(id, next);
    }
  };

  const handleProvideCompositionStart = (e) => {
    e.stopPropagation();
    provideComposingRef.current = true;
  };

  const handleProvideCompositionEnd = (e) => {
    e.stopPropagation();
    if (readOnly) return;
    provideComposingRef.current = false;
    const next = e.currentTarget.value;
    setProvideDraft(next);
    if (!deferTextCommit) onProvideValueChange?.(id, next);
  };

  const handleProvideValueBlur = () => {
    if (readOnly) return;
    if (deferTextCommit && provideDraft === provideValue) return;
    onProvideValueChange?.(id, provideDraft);
  };

  const handleProvideFilePick = (e) => {
    e.stopPropagation();
    if (readOnly) return;
    if (typeof data?.onOpenProvideFilePicker === "function") {
      data.onOpenProvideFilePicker(id, provideDraft);
      return;
    }
    const next = window.prompt("文件路径", provideDraft);
    if (next != null) {
      setProvideDraft(next);
      onProvideValueChange?.(id, next);
    }
  };

  const handleTogglePasswordVisible = (e) => {
    e.stopPropagation();
    setPasswordVisible((value) => !value);
  };

  const commitNodeBody = (next) => {
    setBodyDraft(next);
    onNodeBodyChange?.(id, next);
    if (onNodeImagesChange) {
      const filtered = filterImagesReferencedByBody(images, next);
      if (filtered.length !== images.length || filtered.some((img, idx) => img.id !== images[idx]?.id)) {
        onNodeImagesChange(id, filtered);
      }
    }
  };

  const handleNodeBodyChange = (e) => {
    e.stopPropagation();
    if (readOnly) return;
    const next = e.target.value;
    if (deferTextCommit || bodyComposingRef.current) {
      setBodyDraft(next);
    } else {
      commitNodeBody(next);
    }
  };

  const handleNodeBodyCompositionStart = (e) => {
    e.stopPropagation();
    if (readOnly) return;
    bodyComposingRef.current = true;
    setBodyComposing(true);
  };

  const handleNodeBodyCompositionEnd = (e) => {
    e.stopPropagation();
    if (readOnly) return;
    bodyComposingRef.current = false;
    setBodyComposing(false);
    const next = e.currentTarget.value;
    if (deferTextCommit) setBodyDraft(next);
    else commitNodeBody(next);
  };

  const handleNodeBodyBlur = () => {
    if (readOnly) return;
    bodyComposingRef.current = false;
    setBodyComposing(false);
    if (deferTextCommit && bodyDraft === bodyValue) return;
    commitNodeBody(bodyDraft);
  };

  const openBodyFullscreenEditor = (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (readOnly) return;
    setBodyFullscreenEditor(true);
  };

  const closeBodyFullscreenEditor = () => {
    setBodyFullscreenEditor(false);
    handleNodeBodyBlur();
  };

  const handleBodyFullscreenKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      closeBodyFullscreenEditor();
    }
  };

  const scrollBodyPromptToRatio = useCallback((ratio) => {
    const el = bodyTextareaRef.current;
    if (!el) return;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.min(1, Math.max(0, ratio)) * maxScroll;
    updateBodyPromptScrollbar();
  }, [updateBodyPromptScrollbar]);

  const bodyPromptPointerRatioFromTrack = useCallback((clientY, grabOffsetPx = 0) => {
    const track = bodyPromptScrollbarTrackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const thumbPx = (bodyPromptScrollbar.height / 100) * rect.height;
    const maxTopPx = Math.max(1, rect.height - thumbPx);
    return (clientY - rect.top - grabOffsetPx) / maxTopPx;
  }, [bodyPromptScrollbar.height]);

  const handleBodyPromptScrollbarPointerDown = useCallback((event) => {
    if (!bodyPromptScrollbar.visible) return;
    event.preventDefault();
    event.stopPropagation();
    const track = bodyPromptScrollbarTrackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const thumbTopPx = (bodyPromptScrollbar.top / 100) * rect.height;
    const thumbHeightPx = (bodyPromptScrollbar.height / 100) * rect.height;
    const insideThumb = event.clientY >= rect.top + thumbTopPx && event.clientY <= rect.top + thumbTopPx + thumbHeightPx;
    const grabOffsetPx = insideThumb ? event.clientY - rect.top - thumbTopPx : thumbHeightPx / 2;
    scrollBodyPromptToRatio(bodyPromptPointerRatioFromTrack(event.clientY, grabOffsetPx));
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture?.(pointerId);
    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      scrollBodyPromptToRatio(bodyPromptPointerRatioFromTrack(moveEvent.clientY, grabOffsetPx));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [
    bodyPromptPointerRatioFromTrack,
    bodyPromptScrollbar.height,
    bodyPromptScrollbar.top,
    bodyPromptScrollbar.visible,
    scrollBodyPromptToRatio,
  ]);

  const attachImages = async (files) => {
    if (readOnly) return;
    const next = await addImageFiles({ files, body: bodyDraft, images });
    if (!next) return;
    setBodyDraft(next.body);
    onNodeBodyChange?.(id, next.body);
    onNodeImagesChange?.(id, next.images);
  };

  const handleRemoveImage = (e, image) => {
    e.stopPropagation();
    if (readOnly) return;
    const nextImages = images.filter((item) => item.id !== image.id);
    const nextBody = removeImageToken(bodyDraft, image.label);
    setBodyDraft(nextBody);
    onNodeBodyChange?.(id, nextBody);
    onNodeImagesChange?.(id, nextImages);
  };

  const handlePromptPaste = (e) => {
    if (readOnly) return;
    const files = imageFilesFromClipboardEvent(e);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    attachImages(files).catch(() => {});
  };

  const handlePromptDrop = (e) => {
    if (readOnly) return;
    const files = imageFilesFromDropEvent(e);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    attachImages(files).catch(() => {});
  };

  const handlePromptScroll = () => {
    const ta = bodyTextareaRef.current;
    const bd = bodyBackdropRef.current;
    if (!ta || !bd) return;
    bd.scrollTop = ta.scrollTop;
    bd.scrollLeft = ta.scrollLeft;
  };

  return (
    <div
      className={
        "af-flow-node" +
        (selected ? " af-flow-node--selected" : "") +
        (isExecuting ? " af-flow-node--executing" : "") +
        (nodeStatus === "success" ? " af-flow-node--done" : "") +
        (nodeStatus === "failed" ? " af-flow-node--failed" : "") +
        (nodeStatus === "outcome_failed" ? " af-flow-node--failed" : "") +
        (nodeStatus === "waiting" ? " af-flow-node--waiting" : "") +
        (nodeStatus === "running" && !isExecuting ? " af-flow-node--running-disk" : "") +
        (isDim ? " af-flow-node--dim" : "") +
        (hasInlineBodyEditor ? " af-flow-node--inline-body-editor" : "") +
        (isProvideText ? " af-flow-node--provide-text" : "") +
        (isProvidePassword ? " af-flow-node--provide-password" : "") +
        " af-flow-node--" + schemaType.replace(/[^a-z0-9_-]/g, "")
      }
      data-schema={schemaType}
    >
      <div className="af-flow-node__chrome">
        <span className="af-flow-node__title af-flow-node__title--chrome" title={`${nodeTitle}${id ? ` (${id})` : ""}${typeLabel ? ` · ${typeLabel}` : ""}`}>{nodeTitle}</span>
        {!isRunMode && needsModel && (
          <div className="af-flow-node__model-wrap nodrag" onPointerDown={stopInteractiveEvent} onMouseDown={stopInteractiveEvent} onClick={stopInteractiveEvent}>
            <select
              className="af-flow-node__model nodrag"
              value={normalizedModelForSelect}
              onChange={handleModelChange}
              onPointerDown={stopInteractiveEvent}
              onMouseDown={stopInteractiveEvent}
              onClick={stopInteractiveEvent}
              aria-label={t("flow:node.model")}
              title={displayModel || t("flow:node.defaultModel")}
              disabled={readOnly}
            >
              <option value="">{t("flow:node.defaultModel")}</option>
              {modelNotInLists && (
                <option value={rawModel}>
                  {rawModel}
                </option>
              )}
              {cursorList.length > 0 && (
                <optgroup label="Cursor">
                  {cursorList.map((m) => (
                    <option key={`c-${m}`} value={`cursor:${modelEntryId(m)}`}>
                      {modelEntryId(m)}
                    </option>
                  ))}
                </optgroup>
              )}
              {opencodeList.length > 0 && (
                <optgroup label="OpenCode">
                  {opencodeList.map((m) => (
                    <option key={`o-${m}`} value={`opencode:${modelEntryId(m)}`}>
                      {modelEntryId(m)}
                    </option>
                  ))}
                </optgroup>
              )}
              {codexList.length > 0 && (
                <optgroup label="Codex">
                  {codexList.map((m) => (
                    <option key={`codex-${m}`} value={`codex:${modelEntryId(m)}`}>
                      {modelEntryId(m)}
                    </option>
                  ))}
                </optgroup>
              )}
              {claudeCodeList.length > 0 && (
                <optgroup label="Claude Code">
                  {claudeCodeList.map((m) => (
                    <option key={`cc-${m}`} value={`claude-code:${modelEntryId(m)}`}>
                      {modelEntryId(m)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <span className="af-flow-node__model-arrow material-symbols-outlined">expand_more</span>
          </div>
        )}
        {isExecuting && (
          <span className="af-flow-node__status-badge af-flow-node__status-badge--executing">
            EXECUTING
          </span>
        )}
        {nodeStatus === "running" && !isExecuting && (
          <span className="af-flow-node__status-badge af-flow-node__status-badge--running-disk" title={t("flow:node.diskRunning")}>
            RUNNING
          </span>
        )}
        {nodeStatus === "success" && (
          <span className="af-flow-node__status-badge af-flow-node__status-badge--done">
            {isJenkinsBuild && jenkinsDisplayStatus
              ? jenkinsDisplayStatus
              : nodeElapsed != null && String(nodeElapsed).trim() !== "" ? nodeElapsed : "--"}
          </span>
        )}
        {nodeStatus === "waiting" && (
          <span className="af-flow-node__status-badge af-flow-node__status-badge--waiting">
            {nodeRunDetail?.phase === "queued" ? "QUEUED" : nodeRunDetail?.phase === "triggering" ? "TRIGGERING" : "BUILDING"}
          </span>
        )}
        {nodeStatus === "outcome_failed" && (
          <span className="af-flow-node__status-badge af-flow-node__status-badge--failed">
            {jenkinsDisplayStatus || "FAILED"}
          </span>
        )}
        {nodeStatus === "failed" && (
          <span className="af-flow-node__status-badge af-flow-node__status-badge--failed">
            FAILED
          </span>
        )}
        <button
          type="button"
          className="af-flow-node__guide-button nodrag"
          onClick={(event) => {
            event.stopPropagation();
            setGuideOpen(true);
          }}
          onPointerDown={stopInteractiveEvent}
          onMouseDown={stopInteractiveEvent}
          aria-label={t("flow:node.openGuide")}
          title={t("flow:node.openGuide")}
        >
          <span className="material-symbols-outlined">help</span>
        </button>
        {!isRunMode && isProvideNode && !isProvideBool && !isProvideText && !isProvideFile && !isProvidePassword && (
          <button
            type="button"
            className="af-flow-node__expand"
            onClick={handleExpand}
            aria-label={t("flow:node.expandProvide")}
            title={t("flow:node.expandProvide")}
          >
            <span className="material-symbols-outlined">open_in_full</span>
          </button>
        )}
        {!isRunMode && (
          <button
            type="button"
            className="af-flow-node__delete"
            disabled={readOnly}
            onClick={handleDelete}
            aria-label={t("flow:node.deleteNode")}
            title={t("flow:node.deleteNode")}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        )}
      </div>
      <div className="af-flow-node__body">
        <div className="af-flow-node__ports af-flow-node__ports--in">
          {inputs.map((slot, i) => {
            if (slot.showOnNode === false) return null;
            const tip = t("flow:node.inputTooltip", { name: slot.name || `#${i}`, type: slot.type }) +
              (slot.default != null && slot.default !== "" ? t("flow:node.defaultSuffix", { value: slot.default }) : "");
            const label = slot.name || `#${i + 1}`;
            return (
              <div key={`in-${i}`} className="af-flow-node__port-row" title={tip}>
                <span className="af-flow-node__port-label af-flow-node__port-label--in">
                  {label}{slot.required ? <span className="af-flow-node__port-required">*</span> : null}
                </span>
                <Handle
                  type="target"
                  position={Position.Left}
                  id={`input-${i}`}
                  className="af-flow-node__handle"
                  style={{ background: getHandleColor(slot.type) }}
                  title={tip}
                />
              </div>
            );
          })}
        </div>
        <div className="af-flow-node__title-wrap">
          {isRunMode && isJenkinsBuild && nodeRunDetail ? (
            <div className="af-flow-node__jenkins-runtime">
              <div className="af-flow-node__jenkins-runtime-main">
                <span className="material-symbols-outlined" aria-hidden="true">
                  {nodeStatus === "waiting" ? "progress_activity" : nodeStatus === "success" ? "check_circle" : "error"}
                </span>
                <span>{nodeRunDetail.message || jenkinsDisplayStatus || "Jenkins Build"}</span>
              </div>
              {nodeRunDetail.buildNumber ? <small>Build #{nodeRunDetail.buildNumber}</small> : null}
              {nodeRunDetail.url || nodeRunDetail.qrUrl ? (
                <div className="af-flow-node__jenkins-runtime-links nodrag">
                  {nodeRunDetail.url ? (
                    <a href={nodeRunDetail.url} target="_blank" rel="noreferrer" onPointerDown={stopInteractiveEvent} onClick={stopInteractiveEvent}>
                      查看结果
                    </a>
                  ) : null}
                  {nodeRunDetail.qrUrl ? (
                    <a href={nodeRunDetail.qrUrl} target="_blank" rel="noreferrer" onPointerDown={stopInteractiveEvent} onClick={stopInteractiveEvent}>
                      二维码
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {isProvideBool ? (
            <select
              className={"af-flow-node__bool-select nodrag" + (provideBoolValue ? " af-flow-node__bool-select--true" : "")}
              value={provideBoolValue ? "true" : "false"}
              onChange={handleProvideBoolChange}
              onPointerDown={stopInteractiveEvent}
              onMouseDown={stopInteractiveEvent}
              onClick={stopInteractiveEvent}
              aria-label="Boolean value"
              title={provideBoolValue ? "true" : "false"}
              disabled={readOnly}
            >
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
          ) : isProvideText ? (
            <textarea
              className="af-flow-node__inline-text nodrag"
              value={provideDraft}
              onChange={handleProvideValueChange}
              onCompositionStart={handleProvideCompositionStart}
              onCompositionEnd={handleProvideCompositionEnd}
              onBlur={handleProvideValueBlur}
              onPointerDown={stopInteractiveEvent}
              onMouseDown={stopInteractiveEvent}
              onClick={stopInteractiveEvent}
              placeholder="输入文本"
              rows={2}
              readOnly={readOnly}
            />
          ) : isProvideFile ? (
            <div className="af-flow-node__file-value nodrag" onPointerDown={stopInteractiveEvent} onMouseDown={stopInteractiveEvent} onClick={stopInteractiveEvent}>
              <input
                className="af-flow-node__file-input nodrag"
                value={provideDraft}
                onChange={handleProvideValueChange}
                onCompositionStart={handleProvideCompositionStart}
                onCompositionEnd={handleProvideCompositionEnd}
                onBlur={handleProvideValueBlur}
                placeholder="选择或输入文件路径"
                title={provideDraft || "选择或输入文件路径"}
                readOnly={readOnly}
              />
              <button
                type="button"
                className="af-flow-node__file-picker nodrag"
                disabled={readOnly}
                onClick={handleProvideFilePick}
                aria-label="选择文件"
                title="选择文件"
              >
                <span className="material-symbols-outlined">folder_open</span>
              </button>
            </div>
          ) : isProvidePassword ? (
            <div className="af-flow-node__password-value nodrag" onPointerDown={stopInteractiveEvent} onMouseDown={stopInteractiveEvent} onClick={stopInteractiveEvent}>
              <input
                className="af-flow-node__password-input nodrag"
                type={passwordVisible ? "text" : "password"}
                value={provideDraft}
                onChange={handleProvideValueChange}
                onCompositionStart={handleProvideCompositionStart}
                onCompositionEnd={handleProvideCompositionEnd}
                onBlur={handleProvideValueBlur}
                placeholder="输入密码或密钥"
                title={passwordVisible ? provideDraft : "密码已隐藏"}
                // This is a pipeline secret, not an account credential. Tell
                // browser password managers not to offer save/update prompts.
                autoComplete="new-password"
                name="agentflow-secret"
                readOnly={readOnly}
              />
              <button
                type="button"
                className="af-flow-node__password-toggle nodrag"
                disabled={readOnly}
                onClick={handleTogglePasswordVisible}
                aria-label={passwordVisible ? "隐藏密码" : "预览密码"}
                title={passwordVisible ? "隐藏密码" : "预览密码"}
              >
                <span className="material-symbols-outlined">{passwordVisible ? "visibility_off" : "visibility"}</span>
              </button>
            </div>
          ) : hasInlineBodyEditor ? (
            <div
              ref={bodyPromptStackRef}
              className={
                "af-flow-node__prompt-stack nodrag" +
                (bodyComposing ? " af-flow-node__prompt-stack--composing" : "")
              }
            >
              <pre
                ref={bodyBackdropRef}
                className="af-flow-node__prompt-backdrop"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: renderImageTokenHighlightHtml(bodyDraft) + "\n" }}
              />
              <textarea
                ref={bodyTextareaRef}
                className="af-flow-node__prompt-editor nodrag"
                value={bodyDraft}
                onChange={handleNodeBodyChange}
                onCompositionStart={handleNodeBodyCompositionStart}
                onCompositionEnd={handleNodeBodyCompositionEnd}
                onBlur={handleNodeBodyBlur}
                onPaste={handlePromptPaste}
                onDrop={handlePromptDrop}
                onScroll={(e) => {
                  handlePromptScroll(e);
                  updateBodyPromptScrollbar();
                }}
                onPointerDown={stopInteractiveEvent}
                onMouseDown={stopInteractiveEvent}
                onClick={stopInteractiveEvent}
                onKeyDown={stopInteractiveEvent}
                onDragOver={(e) => {
                  if (imageFilesFromDropEvent(e).length > 0) e.preventDefault();
                }}
                placeholder={isAgentToBool ? "输入判断条件 / prompt" : "输入 prompt"}
                rows={2}
                readOnly={readOnly}
              />
              {!readOnly && (
                <button
                  type="button"
                  className="af-flow-node__prompt-expand nodrag"
                  onPointerDown={stopInteractiveEvent}
                  onMouseDown={stopInteractiveEvent}
                  onClick={openBodyFullscreenEditor}
                  aria-label="放大编辑"
                  title="放大编辑"
                >
                  <span className="material-symbols-outlined">open_in_full</span>
                </button>
              )}
              <div
                ref={bodyPromptScrollbarTrackRef}
                className={"af-flow-node__prompt-scrollbar" + (bodyPromptScrollbar.visible ? " af-flow-node__prompt-scrollbar--visible" : "")}
                onPointerDown={handleBodyPromptScrollbarPointerDown}
                aria-hidden="true"
              >
                <span style={{ height: `${bodyPromptScrollbar.height}%`, top: `${bodyPromptScrollbar.top}%` }} />
              </div>
            </div>
          ) : null}
          {hasInlineBodyEditor && images.length > 0 ? (
            <div className="af-flow-node__image-chips">
              {images.map((img, idx) => (
                <span key={img.id || idx} className="af-flow-node__image-chip" title={img.name}>
                  <img src={img.dataUrl} alt="" />
                  <span>[{img.label || `image ${idx + 1}`}]</span>
                  <button
                    type="button"
                    className="af-flow-node__image-remove nodrag"
                    disabled={readOnly}
                    onClick={(e) => handleRemoveImage(e, img)}
                    onPointerDown={stopInteractiveEvent}
                    onMouseDown={stopInteractiveEvent}
                    aria-label={`删除 ${img.label || `image ${idx + 1}`}`}
                    title="删除图片"
                  >
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {bodyPreview ? (
            <span className="af-flow-node__prompt-preview" title={bodyPreview}>
              {bodyPreview}
            </span>
          ) : null}
          {!hasNodeBodyContent ? (
            <span className="af-flow-node__body-title" title={nodeTitle}>
              {nodeTitle}
            </span>
          ) : null}
        </div>
        <div className="af-flow-node__ports af-flow-node__ports--out">
          {outputs.map((slot, i) => {
            if (slot.showOnNode === false) return null;
            const tip = t("flow:node.outputTooltip", { name: slot.name || `#${i}`, type: slot.type }) +
              (slot.default != null && slot.default !== "" ? t("flow:node.defaultSuffix", { value: slot.default }) : "");
            const label = slot.name || `#${i + 1}`;
            return (
              <div key={`out-${i}`} className="af-flow-node__port-row" title={tip}>
                <span className="af-flow-node__port-label af-flow-node__port-label--out">
                  {label}{slot.required ? <span className="af-flow-node__port-required">*</span> : null}
                </span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={`output-${i}`}
                  className="af-flow-node__handle"
                  style={{ background: getHandleColor(slot.type) }}
                  title={tip}
                />
              </div>
            );
          })}
        </div>
      </div>
      {bodyFullscreenEditor ? createPortal(
        <div
          className="af-flow-node-full-editor nodrag"
          onPointerDown={stopInteractiveEvent}
          onMouseDown={stopInteractiveEvent}
          onClick={stopInteractiveEvent}
          onWheel={stopInteractiveEvent}
        >
          <div className="af-flow-node-full-editor__panel">
            <div className="af-flow-node-full-editor__header">
              <div>
                <div className="af-flow-node-full-editor__title">{nodeTitle}</div>
                <div className="af-flow-node-full-editor__hint">编辑 prompt，Esc 关闭</div>
              </div>
              <button
                type="button"
                className="af-flow-node-full-editor__close"
                onClick={closeBodyFullscreenEditor}
                aria-label="关闭"
                title="关闭"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <textarea
              ref={bodyFullscreenTextareaRef}
              className="af-flow-node-full-editor__textarea"
              value={bodyDraft}
              onChange={handleNodeBodyChange}
              onCompositionStart={handleNodeBodyCompositionStart}
              onCompositionEnd={handleNodeBodyCompositionEnd}
              onPaste={handlePromptPaste}
              onDrop={handlePromptDrop}
              onKeyDown={handleBodyFullscreenKeyDown}
              onDragOver={(e) => {
                if (imageFilesFromDropEvent(e).length > 0) e.preventDefault();
              }}
              placeholder={isAgentToBool ? "输入判断条件 / prompt" : "输入 prompt"}
              readOnly={readOnly}
            />
          </div>
        </div>,
        document.body,
      ) : null}
      {guideOpen ? (
        <NodeGuideDialog
          nodeTitle={nodeTitle}
          definitionId={definitionId}
          description={data?.description}
          guide={data?.guide}
          inputs={inputs}
          outputs={outputs}
          onClose={() => setGuideOpen(false)}
        />
      ) : null}
    </div>
  );
}

export const FLOW_NODE_TYPE = "flowNode";
