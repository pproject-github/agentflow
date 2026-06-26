import { Handle, Position } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
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

export function FlowNode({ data, selected, id, deleteNode, onProvideExpand, onProvideValueChange, onNodeBodyChange, onNodeImagesChange, modelLists, onModelChange }) {
  const { t } = useTranslation();
  const inputs = data?.inputs ?? [];
  const outputs = data?.outputs ?? [];
  const schemaType = (data?.schemaType ?? "agent").toLowerCase();
  const typeLabel = getNodeTypeLabel(data);
  const isRunMode = data?.isRunMode ?? false;
  const isExecuting = data?.isExecuting ?? false;
  const isDim = data?.isDim ?? false;
  const nodeStatus = data?.nodeStatus ?? null;
  const nodeElapsed = data?.nodeElapsed ?? null;
  const definitionId = data?.definitionId || "";
  const isProvideNode = definitionId.startsWith("provide_");
  const isProvideBool = definitionId === "provide_bool";
  const isProvideText = definitionId === "provide_str";
  const isProvideFile = definitionId === "provide_file";
  const isSubAgent = definitionId === "agent_subAgent";
  const hasInlineBodyEditor = isSubAgent && !isRunMode;
  const provideBoolValue = isProvideBool ? boolValueFromSlot(outputs[0]) : false;
  const provideValue = isProvideNode ? String(outputs[0]?.value ?? outputs[0]?.default ?? data?.body ?? "") : "";
  const bodyValue = String(data?.body || "");
  const nodeTitle = data?.displayLabel || data?.label || t("flow:node.fallbackLabel");
  const bodyPreview = !isProvideNode && !hasInlineBodyEditor && data?.showBodyPreview ? String(data?.body || "").trim() : "";
  const images = normalizeImages(data?.images);
  const provideComposingRef = useRef(false);
  const bodyComposingRef = useRef(false);
  const bodyTextareaRef = useRef(null);
  const bodyBackdropRef = useRef(null);
  const [provideDraft, setProvideDraft] = useState(provideValue);
  const [bodyDraft, setBodyDraft] = useState(bodyValue);

  useEffect(() => {
    if (!provideComposingRef.current) setProvideDraft(provideValue);
  }, [id, provideValue]);

  useEffect(() => {
    if (!bodyComposingRef.current) setBodyDraft(bodyValue);
  }, [id, bodyValue]);

  useEffect(() => {
    const el = bodyTextareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 76), 180)}px`;
    if (bodyBackdropRef.current) {
      bodyBackdropRef.current.style.height = el.style.height;
    }
  }, [bodyDraft]);

  const cursorList = Array.isArray(modelLists?.cursor) ? modelLists.cursor : [];
  const opencodeList = Array.isArray(modelLists?.opencode) ? modelLists.opencode : [];
  const claudeCodeList = Array.isArray(modelLists?.claudeCode) ? modelLists.claudeCode : [];
  const rawModel = (data?.model ?? "").trim();
  const needsModel = schemaType === "agent" && !definitionId.startsWith("tool_nodejs");

  const cursorIds = new Set(cursorList.map(modelEntryId));
  const opencodeIds = new Set(opencodeList.map(modelEntryId));
  const claudeCodeIds = new Set(claudeCodeList.map(modelEntryId));

  const normalizedModelForSelect = (() => {
    if (!rawModel) return "";
    if (
      rawModel.startsWith("cursor:") ||
      rawModel.startsWith("opencode:") ||
      rawModel.startsWith("claude-code:")
    ) return rawModel;
    if (claudeCodeIds.has(rawModel)) return `claude-code:${rawModel}`;
    if (opencodeIds.has(rawModel)) return `opencode:${rawModel}`;
    if (cursorIds.has(rawModel)) return `cursor:${rawModel}`;
    return rawModel;
  })();

  const modelNotInLists =
    rawModel &&
    !normalizedModelForSelect.startsWith("cursor:") &&
    !normalizedModelForSelect.startsWith("opencode:") &&
    !normalizedModelForSelect.startsWith("claude-code:") &&
    !cursorIds.has(rawModel) &&
    !opencodeIds.has(rawModel) &&
    !claudeCodeIds.has(rawModel);

  const displayModel = rawModel.startsWith("cursor:")
    ? rawModel.slice(7)
    : rawModel.startsWith("opencode:")
      ? rawModel.slice(9)
      : rawModel.startsWith("claude-code:")
        ? rawModel.slice(12)
        : rawModel;

  const handleModelChange = (e) => {
    const newModel = e.target.value;
    if (onModelChange) {
      onModelChange(id, newModel);
    }
  };

  const handleDelete = (e) => {
    e.stopPropagation();
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
    onProvideValueChange?.(id, e.target.value === "true" ? "true" : "false");
  };

  const handleProvideValueChange = (e) => {
    e.stopPropagation();
    const next = e.target.value;
    setProvideDraft(next);
    if (!provideComposingRef.current) {
      onProvideValueChange?.(id, next);
    }
  };

  const handleProvideCompositionStart = (e) => {
    e.stopPropagation();
    provideComposingRef.current = true;
  };

  const handleProvideCompositionEnd = (e) => {
    e.stopPropagation();
    provideComposingRef.current = false;
    const next = e.currentTarget.value;
    setProvideDraft(next);
    onProvideValueChange?.(id, next);
  };

  const handleProvideValueBlur = () => {
    onProvideValueChange?.(id, provideDraft);
  };

  const handleProvideFilePick = (e) => {
    e.stopPropagation();
    const next = window.prompt("文件路径", provideDraft);
    if (next != null) {
      setProvideDraft(next);
      onProvideValueChange?.(id, next);
    }
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
    const next = e.target.value;
    if (bodyComposingRef.current) {
      setBodyDraft(next);
    } else {
      commitNodeBody(next);
    }
  };

  const handleNodeBodyCompositionStart = (e) => {
    e.stopPropagation();
    bodyComposingRef.current = true;
  };

  const handleNodeBodyCompositionEnd = (e) => {
    e.stopPropagation();
    bodyComposingRef.current = false;
    const next = e.currentTarget.value;
    commitNodeBody(next);
  };

  const handleNodeBodyBlur = () => {
    commitNodeBody(bodyDraft);
  };

  const attachImages = async (files) => {
    const next = await addImageFiles({ files, body: bodyDraft, images });
    if (!next) return;
    setBodyDraft(next.body);
    onNodeBodyChange?.(id, next.body);
    onNodeImagesChange?.(id, next.images);
  };

  const handleRemoveImage = (e, image) => {
    e.stopPropagation();
    const nextImages = images.filter((item) => item.id !== image.id);
    const nextBody = removeImageToken(bodyDraft, image.label);
    setBodyDraft(nextBody);
    onNodeBodyChange?.(id, nextBody);
    onNodeImagesChange?.(id, nextImages);
  };

  const handlePromptPaste = (e) => {
    const files = imageFilesFromClipboardEvent(e);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    attachImages(files).catch(() => {});
  };

  const handlePromptDrop = (e) => {
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
        (nodeStatus === "running" && !isExecuting ? " af-flow-node--running-disk" : "") +
        (isDim ? " af-flow-node--dim" : "") +
        " af-flow-node--" + schemaType.replace(/[^a-z0-9_-]/g, "")
      }
      data-schema={schemaType}
    >
      <div className="af-flow-node__chrome">
        <span className="af-flow-node__type" title={typeLabel}>
          {typeLabel}
        </span>
        {id && (
          <span className="af-flow-node__id" title={id}>
            {id}
          </span>
        )}
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
            {nodeElapsed != null && String(nodeElapsed).trim() !== "" ? nodeElapsed : "--"}
          </span>
        )}
        {nodeStatus === "failed" && (
          <span className="af-flow-node__status-badge af-flow-node__status-badge--failed">
            FAILED
          </span>
        )}
        {!isRunMode && isProvideNode && !isProvideBool && !isProvideText && !isProvideFile && (
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
          <span className="af-flow-node__title">{nodeTitle}</span>
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
              />
              <button
                type="button"
                className="af-flow-node__file-picker nodrag"
                onClick={handleProvideFilePick}
                aria-label="选择文件"
                title="选择文件"
              >
                <span className="material-symbols-outlined">folder_open</span>
              </button>
            </div>
          ) : isSubAgent && !isRunMode ? (
            <div className="af-flow-node__prompt-stack nodrag" onPointerDown={stopInteractiveEvent} onMouseDown={stopInteractiveEvent} onClick={stopInteractiveEvent}>
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
                onScroll={handlePromptScroll}
                onDragOver={(e) => {
                  if (imageFilesFromDropEvent(e).length > 0) e.preventDefault();
                }}
                placeholder="输入 prompt"
                rows={2}
              />
            </div>
          ) : null}
          {isSubAgent && images.length > 0 ? (
            <div className="af-flow-node__image-chips">
              {images.map((img, idx) => (
                <span key={img.id || idx} className="af-flow-node__image-chip" title={img.name}>
                  <img src={img.dataUrl} alt="" />
                  <span>[{img.label || `image ${idx + 1}`}]</span>
                  <button
                    type="button"
                    className="af-flow-node__image-remove nodrag"
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
    </div>
  );
}

export const FLOW_NODE_TYPE = "flowNode";
