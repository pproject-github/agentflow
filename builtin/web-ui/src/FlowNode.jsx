import { Handle, Position } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { getHandleColor } from "./nodeSchema.js";

function getNodeTypeLabel(data) {
  const id = data?.definitionId?.trim();
  // 如果 definitionId 存在且不是默认值"普通"，则显示它
  if (id && id !== "普通") return id;
  // 否则显示 schemaType，避免显示"普通"作为类型标签
  const schemaType = (data?.schemaType ?? "agent").toLowerCase();
  if (schemaType && schemaType !== "普通") return schemaType;
  return "agent";
}

export function FlowNode({ data, selected, id, deleteNode }) {
  const { t } = useTranslation();
  const inputs = data?.inputs ?? [];
  const outputs = data?.outputs ?? [];
  const schemaType = (data?.schemaType ?? "agent").toLowerCase();
  const typeLabel = getNodeTypeLabel(data);
  const isRunMode = data?.isRunMode ?? false;
  const isExecuting = data?.isExecuting ?? false;
  const nodeStatus = data?.nodeStatus ?? null;
  const nodeElapsed = data?.nodeElapsed ?? null;

  const handleDelete = (e) => {
    e.stopPropagation();
    if (deleteNode) {
      deleteNode(id);
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
        " af-flow-node--" + schemaType.replace(/[^a-z0-9_-]/g, "")
      }
      data-schema={schemaType}
    >
      <div className="af-flow-node__chrome">
        <span className="af-flow-node__type" title={typeLabel}>
          {typeLabel}
        </span>
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
