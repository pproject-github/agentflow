import { Handle, Position } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { getHandleColor } from "./nodeSchema.js";

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

export function FlowNode({ data, selected, id, deleteNode, onProvideExpand, modelLists, onModelChange }) {
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

  const cursorList = Array.isArray(modelLists?.cursor) ? modelLists.cursor : [];
  const opencodeList = Array.isArray(modelLists?.opencode) ? modelLists.opencode : [];
  const rawModel = (data?.model ?? "").trim();
  const needsModel = schemaType === "agent" && !definitionId.startsWith("tool_nodejs");

  const cursorIds = new Set(cursorList.map(modelEntryId));
  const opencodeIds = new Set(opencodeList.map(modelEntryId));

  const normalizedModelForSelect = (() => {
    if (!rawModel) return "";
    if (rawModel.startsWith("cursor:") || rawModel.startsWith("opencode:")) return rawModel;
    if (opencodeIds.has(rawModel)) return `opencode:${rawModel}`;
    if (cursorIds.has(rawModel)) return `cursor:${rawModel}`;
    return rawModel;
  })();

  const modelNotInLists = rawModel && !normalizedModelForSelect.startsWith("cursor:") && !normalizedModelForSelect.startsWith("opencode:") && !cursorIds.has(rawModel) && !opencodeIds.has(rawModel);

  const displayModel = rawModel.startsWith("cursor:") ? rawModel.slice(7) : rawModel.startsWith("opencode:") ? rawModel.slice(9) : rawModel;

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
          <div className="af-flow-node__model-wrap">
            <select
              className="af-flow-node__model"
              value={normalizedModelForSelect}
              onChange={handleModelChange}
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
        {!isRunMode && isProvideNode && (
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
            const tip = t("flow:node.inputTooltip", { name: slot.name || `#${i}`, type: slot.type }) +
              (slot.default != null && slot.default !== "" ? t("flow:node.defaultSuffix", { value: slot.default }) : "");
            return (
              <div key={`in-${i}`} className="af-flow-node__port-row" title={tip}>
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
          <span className="af-flow-node__title">{data?.label ?? t("flow:node.fallbackLabel")}</span>
        </div>
        <div className="af-flow-node__ports af-flow-node__ports--out">
          {outputs.map((slot, i) => {
            const tip = t("flow:node.outputTooltip", { name: slot.name || `#${i}`, type: slot.type }) +
              (slot.default != null && slot.default !== "" ? t("flow:node.defaultSuffix", { value: slot.default }) : "");
            return (
              <div key={`out-${i}`} className="af-flow-node__port-row" title={tip}>
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
