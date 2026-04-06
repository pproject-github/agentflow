import { Handle, Position } from "@xyflow/react";
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
          <span className="af-flow-node__status-badge af-flow-node__status-badge--running-disk" title="磁盘记录为执行中">
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
            aria-label="删除节点"
            title="删除节点"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        )}
      </div>
      <div className="af-flow-node__body">
        <div className="af-flow-node__ports af-flow-node__ports--in">
          {inputs.map((slot, i) => {
            const tip = `输入 ${slot.name || `#${i}`} | 类型: ${slot.type}${
              slot.default != null && slot.default !== "" ? ` | 默认: ${slot.default}` : ""
            }`;
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
          <span className="af-flow-node__title">{data?.label ?? "节点"}</span>
        </div>
        <div className="af-flow-node__ports af-flow-node__ports--out">
          {outputs.map((slot, i) => {
            const tip = `输出 ${slot.name || `#${i}`} | 类型: ${slot.type}${
              slot.default != null && slot.default !== "" ? ` | 默认: ${slot.default}` : ""
            }`;
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
