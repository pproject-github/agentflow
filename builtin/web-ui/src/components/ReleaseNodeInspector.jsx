import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { defaultInputsForNode, externalInputSchemaForNode } from "../lib/releaseWorkflowModel.js";

function displayValue(value) {
  if (value == null || value === "") return "未记录";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export default function ReleaseNodeInspector({
  item,
  node,
  mode = "pending",
  onClose,
  onSave,
  onPreview,
  onRun,
  onStop,
}) {
  const [maximized, setMaximized] = useState(false);
  const [inputs, setInputs] = useState(() => defaultInputsForNode(node, item?.inputs));
  const readOnly = mode === "completed";
  const title = item?.title || node?.title || "发版阶段";
  const schemas = useMemo(() => externalInputSchemaForNode(node), [node]);
  const compositeSteps = Array.isArray(item?.details?.steps) ? item.details.steps : [];

  useEffect(() => {
    setInputs(defaultInputsForNode(node, item?.inputs));
  }, [item, node]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!item || typeof document === "undefined") return null;
  const submitSave = () => onSave?.({ ...item, inputs });
  const submitPreview = () => onPreview?.({ ...item, inputs });
  const submitRun = () => onRun?.({ ...item, inputs });

  return createPortal(
    <div className={`af-release-inspector${maximized ? " is-maximized" : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <section className="af-release-inspector__panel" role="dialog" aria-modal="true" aria-label={`${title} 节点详情`}>
        <header className="af-release-inspector__header">
          <div>
            <span className="af-release-inspector__eyebrow">AgentFlow · Release Node</span>
            <h2>{title}</h2>
            <p>{node?.description || item.description || "发版阶段详情"}</p>
          </div>
          <div className="af-release-inspector__header-actions">
            <button type="button" onClick={() => setMaximized((value) => !value)} aria-label={maximized ? "退出最大化" : "最大化"} title={maximized ? "退出最大化" : "最大化"}>
              <span className="material-symbols-outlined" aria-hidden="true">{maximized ? "close_fullscreen" : "open_in_full"}</span>
            </button>
            <button type="button" onClick={onClose} aria-label="关闭节点详情"><span className="material-symbols-outlined" aria-hidden="true">close</span></button>
          </div>
        </header>
        <div className="af-release-inspector__body">
          <div className="af-release-inspector__facts">
            <span><b>状态</b>{mode === "completed" ? "已完成" : mode === "failed" ? "失败" : item.status === "running" ? "执行中" : "待执行"}</span>
            <span><b>Skill</b>{node?.skill || item.skill || "release"}</span>
            <span><b>Action</b>{node?.action || item.action || node?.id || item.nodeId}</span>
            <span><b>Run ID</b>{item.runId || "未运行"}</span>
          </div>
          <section className="af-release-inspector__section">
            <div className="af-release-inspector__section-title"><h3>输入参数</h3>{readOnly ? <em>已完成节点只读</em> : <em>可编辑</em>}</div>
            {schemas.length === 0 ? <p className="af-release-inspector__empty">该节点没有可编辑输入。</p> : schemas.map((schema) => (
              <label key={schema.key} className="af-release-inspector__field">
                <span>{schema.label || schema.key}{schema.required ? " *" : ""}</span>
                <input
                  type={schema.type === "number" ? "number" : "text"}
                  value={inputs[schema.key] ?? ""}
                  min={schema.min}
                  max={schema.max}
                  step={schema.step}
                  placeholder={schema.placeholder}
                  readOnly={readOnly || item.status === "running"}
                  disabled={readOnly || item.status === "running"}
                  onChange={(event) => setInputs((previous) => ({ ...previous, [schema.key]: event.target.value }))}
                />
              </label>
            ))}
          </section>
          <section className="af-release-inspector__section"><div className="af-release-inspector__section-title"><h3>运行信息</h3><em>{item.operator || "未记录"}</em></div><div className="af-release-inspector__metadata"><span>开始：{displayValue(item.startedAt)}</span><span>完成：{displayValue(item.completedAt)}</span><span>耗时：{displayValue(item.durationMs)}</span></div></section>
          {node?.kind === "composite" || item?.kind === "composite" ? <section className="af-release-inspector__section af-release-inspector__composite-steps"><div className="af-release-inspector__section-title"><h3>内部执行步骤</h3><em>{compositeSteps.length} 步</em></div>{compositeSteps.length === 0 ? <p className="af-release-inspector__empty">尚未产生内部步骤记录。</p> : <ol>{compositeSteps.map((step, index) => <li key={`${step.stepId || step.actionId || "step"}-${index}`} className={`is-${step.status || "pending"}`}><div><strong>{step.title || step.stepId || step.actionId || `步骤 ${index + 1}`}</strong><small>{step.actionId || ""}</small></div><span>{step.status || "pending"}</span>{step.error ? <pre>{step.error}</pre> : null}</li>)}</ol>}</section> : null}
          {item.error ? <section className="af-release-inspector__section is-error"><h3>失败原因</h3><pre>{item.error}</pre></section> : null}
          <section className="af-release-inspector__section"><div className="af-release-inspector__section-title"><h3>输出</h3><button type="button" onClick={() => navigator.clipboard?.writeText(displayValue(item.output || item.message))}>复制</button></div><pre className="af-release-inspector__code">{displayValue(item.output || item.message)}</pre></section>
          <section className="af-release-inspector__section"><div className="af-release-inspector__section-title"><h3>日志</h3></div><pre className="af-release-inspector__code">{displayValue(item.logs || item.log || "暂无运行日志")}</pre></section>
        </div>
        <footer className="af-release-inspector__footer">
          {readOnly ? <span>已完成节点不可编辑或重复执行</span> : <>
            <button type="button" onClick={submitSave} disabled={item.status === "running"}>保存参数</button>
            {item.status === "running" ? <button type="button" className="is-danger" onClick={() => onStop?.(item)}>取消执行</button> : <><button type="button" onClick={submitPreview}>预览</button><button type="button" className="is-primary" onClick={submitRun}>执行</button></>}
          </>}
        </footer>
      </section>
    </div>,
    document.body,
  );
}
