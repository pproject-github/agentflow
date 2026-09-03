import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { defaultInputsForNode, externalInputSchemaForNode, releaseActionTitle } from "../lib/releaseWorkflowModel.js";

function displayValue(value) {
  if (value == null || value === "") return "未记录";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// Agent 常把结果 JSON 与尾随 Markdown 粘在同一字符串；详情页要能拆开否则结论区会显示原始 JSON。
function parseLeadingJsonValue(text) {
  const source = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!source.startsWith("{") && !source.startsWith("[")) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (char === "\\") { escape = true; continue; }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; continue; }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          return { value: JSON.parse(source.slice(0, index + 1)), rest: source.slice(index + 1).trim() };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function unwrapSummaryText(value) {
  let text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  for (let depth = 0; depth < 2; depth += 1) {
    const parsed = parseLeadingJsonValue(text);
    if (!parsed?.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) break;
    const trailing = String(parsed.rest || "").trim();
    const nested = String(parsed.value.summary || parsed.value.message || parsed.value.error || "").trim();
    const preferTrailing = trailing && (trailing.includes("**") || /\[[^\]]+\]\(https?:\/\//.test(trailing) || trailing.includes("\n"));
    const next = preferTrailing ? trailing : (nested || trailing);
    if (!next || next === text) break;
    text = next;
  }
  return text;
}

function unwrapStructuredLists(text) {
  const parsed = parseLeadingJsonValue(text);
  if (!parsed?.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return null;
  return parsed.value;
}

function pickSummary(item) {
  const output = asRecord(item?.output);
  const details = asRecord(item?.details);
  const candidates = [
    details?.summary,
    output?.summary,
    typeof item?.output === "string" ? item.output : null,
    item?.message,
    item?.waiting?.reason,
  ];
  for (const candidate of candidates) {
    const text = unwrapSummaryText(candidate);
    if (text) return text;
  }
  return "";
}

function pickList(item, key) {
  const output = asRecord(item?.output);
  const details = asRecord(item?.details);
  const fromDetails = Array.isArray(details?.[key]) ? details[key] : null;
  const fromOutput = Array.isArray(output?.[key]) ? output[key] : null;
  if (fromDetails?.length) return fromDetails;
  if (fromOutput?.length) return fromOutput;
  // 历史落库可能把整段 envelope 塞进 summary，steps/artifacts 顶层为空；从 summary 再拆一次。
  for (const candidate of [details?.summary, output?.summary, typeof item?.output === "string" ? item.output : null]) {
    const nested = unwrapStructuredLists(candidate);
    if (Array.isArray(nested?.[key]) && nested[key].length) return nested[key];
  }
  if (fromDetails) return fromDetails;
  if (fromOutput) return fromOutput;
  return [];
}

function inferArtifactsFromText(text, existing = []) {
  const artifacts = [...existing];
  const seen = new Set(artifacts.map((item) => artifactHref(item)).filter(Boolean));
  const source = String(text || "");
  for (const match of source.matchAll(/https?:\/\/[^\s)'"，。；]+/g)) {
    const href = match[0].replace(/[),.，。；]+$/g, "");
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const isMr = /merge_requests?\//i.test(href);
    artifacts.push({ type: isMr ? "merge_request" : "link", url: href, title: isMr ? "合并请求 (MR)" : "相关链接" });
  }
  for (const match of source.matchAll(/\bMR\s*!(\d+)\b/gi)) {
    const iid = match[1];
    const already = artifacts.some((item) => String(artifactHref(item) || "").includes(`/merge_requests/${iid}`));
    if (already) continue;
    artifacts.push({ type: "merge_request", title: `合并请求 (MR !${iid})`, state: /merged/i.test(source) ? "merged" : undefined });
  }
  return artifacts;
}

function artifactHref(artifact) {
  const bag = asRecord(artifact);
  if (!bag) return "";
  for (const key of ["url", "href", "link", "web_url", "mrUrl", "mr_url"]) {
    const value = bag[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) return value.trim();
  }
  return "";
}

function artifactLabel(artifact) {
  const bag = asRecord(artifact);
  if (!bag) return "产物";
  const typeLabels = {
    merge_request: "合并请求 (MR)",
    notification: "通知记录",
    file: "文件",
    package: "安装包",
    archive: "归档",
  };
  const typed = typeLabels[String(bag.type || bag.kind || "").trim()] || "";
  return String(bag.title || bag.label || bag.name || typed || bag.type || bag.kind || "产物").trim() || "产物";
}

function pickUrls(item) {
  const bags = [asRecord(item?.output), asRecord(item?.details), asRecord(item?.waiting), item].filter(Boolean);
  const urls = [];
  const seen = new Set();
  for (const bag of bags) {
    for (const [key, value] of Object.entries(bag)) {
      if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim())) continue;
      const href = value.trim();
      if (seen.has(href)) continue;
      seen.add(href);
      urls.push({ key, href });
    }
    const artifacts = Array.isArray(bag.artifacts) ? bag.artifacts : [];
    for (const artifact of artifacts) {
      const href = artifactHref(artifact);
      if (!href || seen.has(href)) continue;
      seen.add(href);
      urls.push({ key: artifactLabel(artifact), href });
    }
  }
  return urls;
}

function humanResultStatus(value) {
  const raw = String(value || "").trim();
  const map = {
    managed_mr_merged: "MR 已合入",
    merge_confirmed: "已确认合入",
    remote_topic_deleted: "远端 topic 已删",
    mr_open: "MR 已打开",
    skipped: "已跳过",
    succeeded: "成功",
    completed: "完成",
    failed: "失败",
    already_current: "已是最新",
  };
  return map[raw] || raw;
}

function buildOutcomeMarkdown({ summary }) {
  if (!summary) return "";
  if (summary.includes("\n") || /(?:^|\n)\s*#{1,6}\s/.test(summary)) return summary;
  return `## 结论\n\n${summary}`;
}

function statusTone(mode, item) {
  if (mode === "failed" || item?.status === "failed") return "failed";
  if (item?.status === "waiting") return "waiting";
  if (mode === "completed" || item?.status === "completed") return "completed";
  if (item?.status === "running") return "running";
  return "pending";
}

function statusLabel(mode, item) {
  if (mode === "completed") return "已完成";
  if (mode === "failed" || item?.status === "failed") return "失败";
  if (item?.status === "waiting") return "等待中";
  if (item?.status === "running") return "执行中";
  return "待执行";
}

function formatWhen(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp);
}

function formatDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) return "未记录";
  if (duration < 1000) return `${duration} ms`;
  return `${(duration / 1000).toFixed(duration >= 10000 ? 0 : 1)} s`;
}

function stepStatusLabel(status) {
  const value = String(status || "pending");
  const map = {
    completed: "完成",
    succeeded: "成功",
    failed: "失败",
    waiting: "等待",
    pending: "待执行",
    running: "执行中",
    skipped: "已跳过",
    skipped_already_succeeded: "已完成（幂等跳过）",
    skipped_use_existing_success: "沿用既有成功",
  };
  return map[value] || value;
}

function stepTitle(step, index) {
  const bag = asRecord(step) || {};
  const raw = bag.title || bag.action || bag.actionId || bag.stepId || "";
  return releaseActionTitle(raw) || `步骤 ${index + 1}`;
}

function stepDetailText(step) {
  const bag = asRecord(step) || {};
  const bits = [];
  if (bag.note) bits.push(String(bag.note));
  if (bag.detail) bits.push(String(bag.detail));
  if (bag.result_status) bits.push(humanResultStatus(bag.result_status));
  if (bag.event) bits.push(`事件 ${bag.event}`);
  if (bag.message) bits.push(String(bag.message));
  return bits.filter(Boolean).join(" · ");
}

function Collapsible({ title, count, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`af-release-inspector__section af-release-inspector__fold${open ? " is-open" : ""}`}>
      <button type="button" className="af-release-inspector__fold-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>{title}</span>
        <em>{count != null ? count : (open ? "收起" : "展开")}</em>
      </button>
      {open ? <div className="af-release-inspector__fold-body">{children}</div> : null}
    </section>
  );
}

function ArtifactList({ artifacts }) {
  if (!artifacts.length) return <p className="af-release-inspector__empty">无产物。</p>;
  return (
    <ul className="af-release-inspector__artifact-list">
      {artifacts.map((artifact, index) => {
        const bag = asRecord(artifact) || {};
        const href = artifactHref(artifact);
        const label = artifactLabel(artifact);
        const meta = [bag.state, bag.sha ? `sha ${String(bag.sha).slice(0, 12)}` : "", bag.path, bag.file].filter(Boolean).map(String);
        return (
          <li key={`${label}-${href || index}`}>
            <div>
              <strong>{label}</strong>
              {meta.length ? <small>{meta.join(" · ")}</small> : null}
            </div>
            {href ? <a href={href} target="_blank" rel="noreferrer">打开</a> : <span className="af-release-inspector__muted">无链接</span>}
          </li>
        );
      })}
    </ul>
  );
}

function RecordList({ records }) {
  if (!records.length) return <p className="af-release-inspector__empty">无执行记录。</p>;
  return (
    <ol className="af-release-inspector__record-list">
      {records.map((record, index) => {
        const bag = asRecord(record) || {};
        const title = String(bag.operation || releaseActionTitle(bag.action) || bag.event || bag.record_id || `记录 ${index + 1}`).trim();
        const result = humanResultStatus(bag.result_status || bag.status);
        const bits = [];
        if (bag.event && String(bag.event) !== title) bits.push(String(bag.event));
        if (bag.sent === true) bits.push("已发送");
        if (bag.sent === false) bits.push("未发送");
        return (
          <li key={`${bag.record_id || title}-${index}`}>
            <div>
              <strong>{title}</strong>
              {bits.length ? <small>{bits.join(" · ")}</small> : null}
            </div>
            <span>{result || "succeeded"}</span>
          </li>
        );
      })}
    </ol>
  );
}

export default function ReleaseNodeInspector({
  item,
  node,
  mode = "pending",
  canWrite = true,
  onClose,
  onSave,
  onPreview,
  onRun,
  onStop,
  context,
}) {
  const [maximized, setMaximized] = useState(false);
  const [inputs, setInputs] = useState(() => defaultInputsForNode(node, item?.inputs, context));
  const readOnly = mode === "completed" || !canWrite;
  const title = item?.title || node?.title || "发版阶段";
  const schemas = useMemo(() => externalInputSchemaForNode(node), [node]);
  const compositeSteps = Array.isArray(item?.details?.steps) ? item.details.steps : [];
  const summary = useMemo(() => pickSummary(item), [item]);
  const records = useMemo(() => pickList(item, "records"), [item]);
  const artifacts = useMemo(
    () => inferArtifactsFromText(summary, pickList(item, "artifacts")),
    [item, summary],
  );
  const urls = useMemo(() => {
    const listed = pickUrls(item);
    const covered = new Set(artifacts.map((artifact) => artifactHref(artifact)).filter(Boolean));
    const seen = new Set();
    const merged = [];
    for (const entry of listed) {
      if (!entry.href || seen.has(entry.href) || covered.has(entry.href)) continue;
      seen.add(entry.href);
      merged.push(entry);
    }
    for (const artifact of artifacts) {
      const href = artifactHref(artifact);
      // 产物卡片已展示可打开链接时，不再在「相关链接」重复同一 URL。
      if (!href || seen.has(href) || covered.has(href)) continue;
      seen.add(href);
      merged.push({ key: artifactLabel(artifact), href });
    }
    return merged;
  }, [item, artifacts]);
  const waiting = asRecord(item?.waiting) || asRecord(asRecord(item?.output)?.waiting) || asRecord(asRecord(item?.details)?.waiting);
  const tone = statusTone(mode, item);
  const completedView = mode === "completed" || item?.status === "completed";
  const outcomeMarkdown = useMemo(() => buildOutcomeMarkdown({ summary }), [summary]);
  const rawPayload = {
    status: item?.status || mode,
    summary: pickSummary(item) || undefined,
    waiting: waiting || undefined,
    steps: compositeSteps.length ? compositeSteps : undefined,
    records: records.length ? records : undefined,
    artifacts: artifacts.length ? artifacts : undefined,
    output: item?.output,
    details: item?.details,
    message: item?.message,
    error: item?.error,
  };

  useEffect(() => {
    setInputs(defaultInputsForNode(node, item?.inputs, context));
  }, [context, item, node]);

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

  const inputFields = schemas.length === 0 ? <p className="af-release-inspector__empty">该节点没有可编辑输入。</p> : schemas.map((schema) => {
    const rawValue = inputs[schema.key] ?? schema.defaultValue ?? "";
    const checked = rawValue === true || ["1", "true", "yes", "on"].includes(String(rawValue).trim().toLowerCase());
    if (schema.type === "checkbox" || schema.type === "bool") {
      return (
        <label key={schema.key} className="af-release-inspector__field af-release-inspector__checkbox">
          <span className="af-release-inspector__checkbox-row">
            <input
              type="checkbox"
              checked={checked}
              readOnly={readOnly || item.status === "running"}
              disabled={readOnly || item.status === "running"}
              onChange={(event) => setInputs((previous) => ({ ...previous, [schema.key]: event.target.checked }))}
            />
            <span>{schema.label || schema.key}{schema.required ? " *" : ""}</span>
          </span>
          {schema.placeholder ? <small>{schema.placeholder}</small> : null}
        </label>
      );
    }
    return (
      <label key={schema.key} className={`af-release-inspector__field${schema.type === "textarea" ? " is-stack" : ""}`}>
        <span>{schema.label || schema.key}{schema.required ? " *" : ""}</span>
        {schema.type === "textarea" ? (
          <textarea
            rows={6}
            value={rawValue}
            placeholder={schema.placeholder}
            readOnly={readOnly || item.status === "running"}
            disabled={readOnly || item.status === "running"}
            onChange={(event) => setInputs((previous) => ({ ...previous, [schema.key]: event.target.value }))}
          />
        ) : (
          <input
            type={schema.type === "number" ? "number" : "text"}
            value={rawValue}
            min={schema.min}
            max={schema.max}
            step={schema.step}
            placeholder={schema.placeholder}
            readOnly={readOnly || item.status === "running"}
            disabled={readOnly || item.status === "running"}
            onChange={(event) => setInputs((previous) => ({ ...previous, [schema.key]: event.target.value }))}
          />
        )}
      </label>
    );
  });

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
          <section className={`af-release-inspector__hero is-${tone}`}>
            <div className="af-release-inspector__hero-topline">
              <b>{statusLabel(mode, item)}</b>
              <span>{item.runId ? `Run ${item.runId}` : "尚未运行"}</span>
            </div>
            {outcomeMarkdown ? (
              <div className="af-release-inspector__markdown">
                <ReactMarkdown>{outcomeMarkdown}</ReactMarkdown>
              </div>
            ) : (
              <p className="af-release-inspector__hero-empty">执行后这里会展示可读结论、完成事项与产物。</p>
            )}
          </section>

          <div className="af-release-inspector__facts">
            <span><b>状态</b>{statusLabel(mode, item)}</span>
            <span><b>Skill</b>{node?.skill || item.skill || "release"}</span>
            <span><b>Action</b>{node?.action || item.action || node?.compositeId || node?.id || item.nodeId}</span>
            <span><b>操作人</b>{item.operator || "未记录"}</span>
          </div>

          {completedView && compositeSteps.length > 0 ? (
            <section className="af-release-inspector__section is-steps">
              <div className="af-release-inspector__section-title"><h3>做了什么</h3><em>{compositeSteps.length} 步</em></div>
              <ol className="af-release-inspector__composite-steps">
                {compositeSteps.map((step, index) => {
                  const detail = stepDetailText(step);
                  return (
                    <li key={`${step.stepId || step.action || step.actionId || "step"}-${index}`} className={`is-${String(step.status || "pending").includes("fail") ? "failed" : "ok"}`}>
                      <div>
                        <strong>{stepTitle(step, index)}</strong>
                        {detail ? <small>{detail}</small> : null}
                      </div>
                      <span>{stepStatusLabel(step.status)}</span>
                      {step.error ? <pre>{step.error}</pre> : null}
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}

          {artifacts.length > 0 ? (
            <section className="af-release-inspector__section is-artifacts">
              <div className="af-release-inspector__section-title"><h3>产物</h3><em>{artifacts.length} 项</em></div>
              <ArtifactList artifacts={artifacts} />
            </section>
          ) : null}

          {completedView && records.length > 0 ? (
            <section className="af-release-inspector__section is-records">
              <div className="af-release-inspector__section-title"><h3>完成事项</h3><em>{records.length} 条</em></div>
              <RecordList records={records} />
            </section>
          ) : null}

          {!completedView && schemas.length > 0 ? (
            <section className="af-release-inspector__section">
              <div className="af-release-inspector__section-title"><h3>输入参数</h3>{readOnly ? <em>只读</em> : <em>可编辑</em>}</div>
              {inputFields}
            </section>
          ) : null}

          {waiting ? (
            <section className="af-release-inspector__section is-waiting">
              <div className="af-release-inspector__section-title"><h3>等待确认</h3><em>{waiting.reason || "需要人工处理"}</em></div>
              <pre>{displayValue(waiting)}</pre>
            </section>
          ) : null}

          {item.error && (mode === "failed" || item.status === "failed") ? (
            <section className="af-release-inspector__section is-error"><h3>失败原因</h3><pre>{item.error}</pre></section>
          ) : null}

          <section className="af-release-inspector__section">
            <div className="af-release-inspector__section-title"><h3>运行信息</h3><em>{formatDuration(item.durationMs)}</em></div>
            <div className="af-release-inspector__metadata">
              <span>开始：{formatWhen(item.startedAt)}</span>
              <span>完成：{formatWhen(item.completedAt)}</span>
              <span>耗时：{formatDuration(item.durationMs)}</span>
            </div>
          </section>

          {urls.length > 0 ? (
            <section className="af-release-inspector__section">
              <div className="af-release-inspector__section-title"><h3>相关链接</h3></div>
              <ul className="af-release-inspector__links">
                {urls.map((entry) => (
                  <li key={entry.href}><a href={entry.href} target="_blank" rel="noreferrer">{entry.key}: {entry.href}</a></li>
                ))}
              </ul>
            </section>
          ) : null}

          {(node?.kind === "composite" || item?.kind === "composite" || compositeSteps.length > 0) && !completedView ? (
            <Collapsible title="内部执行步骤" count={`${compositeSteps.length} 步`} defaultOpen={compositeSteps.some((step) => step.status === "failed")}>
              {compositeSteps.length === 0 ? <p className="af-release-inspector__empty">尚未产生内部步骤记录。</p> : (
                <ol className="af-release-inspector__composite-steps">
                  {compositeSteps.map((step, index) => {
                    const detail = stepDetailText(step);
                    return (
                    <li key={`${step.stepId || step.action || step.actionId || "step"}-${index}`} className={`is-${String(step.status || "pending").includes("fail") ? "failed" : "ok"}`}>
                      <div>
                        <strong>{stepTitle(step, index)}</strong>
                        {detail ? <small>{detail}</small> : <small>{step.actionId || step.action || ""}</small>}
                      </div>
                      <span>{stepStatusLabel(step.status)}</span>
                      {step.error ? <pre>{step.error}</pre> : null}
                    </li>
                    );
                  })}
                </ol>
              )}
            </Collapsible>
          ) : null}

          {completedView && schemas.length > 0 ? (
            <Collapsible title="输入参数" count={`${schemas.length}`}>
              {inputFields}
            </Collapsible>
          ) : null}

          {!completedView && records.length > 0 ? (
            <Collapsible title="执行记录" count={`${records.length} 条`} defaultOpen>
              <RecordList records={records} />
            </Collapsible>
          ) : null}

          <Collapsible title="调试数据（原始 JSON）" count="折叠">
            <div className="af-release-inspector__section-title">
              <h3>原始 JSON</h3>
              <button type="button" onClick={() => navigator.clipboard?.writeText(displayValue(rawPayload))}>复制</button>
            </div>
            <pre className="af-release-inspector__code">{displayValue(rawPayload)}</pre>
          </Collapsible>

          <Collapsible title="日志" count={Array.isArray(item.logs) ? `${item.logs.length}` : undefined}>
            <pre className="af-release-inspector__code">{displayValue(item.logs || item.log || "暂无运行日志")}</pre>
          </Collapsible>
        </div>
        <footer className="af-release-inspector__footer">
          {readOnly ? <span>{mode === "completed" ? "已完成节点不可编辑或重复执行" : "当前账号无发版操作权限，仅可浏览"}</span> : <>
            <button type="button" onClick={submitSave} disabled={item.status === "running"}>保存参数</button>
            {item.status === "running" ? <button type="button" className="is-danger" onClick={() => onStop?.(item)}>取消执行</button> : <><button type="button" onClick={submitPreview}>预览</button><button type="button" className="is-primary" onClick={submitRun}>执行</button></>}
          </>}
        </footer>
      </section>
    </div>,
    document.body,
  );
}
