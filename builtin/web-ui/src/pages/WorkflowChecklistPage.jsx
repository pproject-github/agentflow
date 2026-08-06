import { useCallback, useEffect, useMemo, useState } from "react";
import { useRoute } from "../routeContext.jsx";
import { WORKFLOW_CHECKLIST_DEMO_ACTION, withWorkflowChecklistProgress } from "../workflowChecklistDemo.js";
import LoadingState from "../components/LoadingState.jsx";

const STATUS_OPTIONS = [
  ["pending", "待执行"],
  ["passed", "通过"],
  ["failed", "失败"],
  ["blocked", "阻塞"],
  ["skipped", "跳过"],
];

function safeReturnTo(value) {
  const raw = String(value || "").trim();
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/workflows";
}

function statusLabel(value) {
  return STATUS_OPTIONS.find(([status]) => status === String(value || "pending"))?.[1] || "待执行";
}

function sectionContent(value) {
  if (Array.isArray(value)) return value;
  return String(value || "").split(/\r?\n/).filter(Boolean);
}

export default function WorkflowChecklistPage() {
  const { navigate } = useRoute();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const demo = params.get("demo") === "1";
  const workflow = String(params.get("workflow") || "").trim();
  const source = String(params.get("source") || "").trim();
  const actionKey = String(params.get("actionKey") || "").trim();
  const returnTo = safeReturnTo(params.get("returnTo"));
  const [action, setAction] = useState(null);
  const [canWrite, setCanWrite] = useState(false);
  const [selectedKey, setSelectedKey] = useState(String(params.get("itemKey") || "").trim());
  const [status, setStatus] = useState("pending");
  const [note, setNote] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [editingResult, setEditingResult] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const requestParams = useCallback(() => {
    const query = new URLSearchParams({ workflow, source, actionKey });
    for (const key of ["flowId", "flowSource", "workspaceId", "workflowShare", "adminOwnerId", "archived"]) {
      const value = params.get(key);
      if (value) query.set(key, value);
    }
    return query;
  }, [actionKey, params, source, workflow]);

  const load = useCallback(async () => {
    if (demo) {
      const demoAction = withWorkflowChecklistProgress(WORKFLOW_CHECKLIST_DEMO_ACTION);
      setAction(demoAction);
      setCanWrite(true);
      setSelectedKey((current) => demoAction.checklist.items.some((item) => item.key === current) ? current : demoAction.checklist.items[0].key);
      setError("");
      setLoading(false);
      return;
    }
    if (!workflow || !source || !actionKey) {
      setError("Checklist 链接缺少 workflow、source 或 actionKey");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/workflows/checklist?${requestParams().toString()}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "读取 Checklist 失败");
      setAction(payload.action || null);
      setCanWrite(payload.canWrite === true);
      const items = payload.action?.checklist?.items || [];
      setSelectedKey((current) => items.some((item) => item.key === current) ? current : String(items[0]?.key || ""));
    } catch (loadError) {
      setError(String(loadError.message || loadError));
    } finally {
      setLoading(false);
    }
  }, [actionKey, demo, requestParams, source, workflow]);

  useEffect(() => { void load(); }, [load]);

  const checklist = action?.checklist || {};
  const items = Array.isArray(checklist.items) ? checklist.items : [];
  const selectedItem = items.find((item) => item.key === selectedKey) || items[0] || null;
  useEffect(() => {
    const state = selectedItem?.state || {};
    setStatus(String(state.status || "pending"));
    setNote(String(state.note || ""));
    setEvidenceUrl(String(state.evidence?.[0]?.url || ""));
    setEditingResult(String(state.status || "pending") === "pending");
  }, [selectedItem?.key, selectedItem?.state?.version]);

  const save = async (nextStatus = status) => {
    if (!selectedItem || !canWrite || saving) return;
    if (nextStatus === "passed" && selectedItem.evidenceRequired && !evidenceUrl.trim()) {
      setError("该条目需要填写证据链接后才能标记通过");
      return;
    }
    setSaving(true);
    setError("");
    try {
      if (demo) {
        setAction((current) => withWorkflowChecklistProgress({
          ...current,
          checklist: {
            ...current.checklist,
            items: current.checklist.items.map((item) => item.key === selectedItem.key ? {
              ...item,
              state: {
                ...item.state,
                status: nextStatus,
                note,
                evidence: evidenceUrl.trim() ? [{ title: "执行证据", url: evidenceUrl.trim() }] : [],
                version: `demo:${Date.now()}`,
              },
            } : item),
          },
        }));
        setStatus(nextStatus);
        setEditingResult(nextStatus === "pending");
        return;
      }
      const body = {
        workflow,
        source,
        actionKey,
        itemKey: selectedItem.key,
        status: nextStatus,
        note,
        evidence: evidenceUrl.trim() ? [{ title: "执行证据", url: evidenceUrl.trim() }] : [],
        expectedVersion: selectedItem.state?.version || "absent",
        idempotencyKey: `checklist:${source}:${actionKey}:${selectedItem.key}:${selectedItem.state?.version || "absent"}:${nextStatus}`,
      };
      for (const key of ["flowId", "flowSource", "workspaceId", "adminOwnerId", "archived"]) {
        const value = params.get(key);
        if (value) body[key] = value;
      }
      const response = await fetch("/api/workflows/checklist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "保存 Checklist 失败");
      setAction((current) => current ? { ...current, checklist: payload.checklist || current.checklist } : current);
      setStatus(nextStatus);
      setEditingResult(nextStatus === "pending");
    } catch (saveError) {
      setError(String(saveError.message || saveError));
    } finally {
      setSaving(false);
    }
  };

  const progress = checklist.progress || { total: items.length, completed: 0, percent: 0 };
  const selectedIndex = Math.max(0, items.findIndex((item) => item.key === selectedItem?.key));
  const detail = selectedItem?.detail || {};
  const sections = Array.isArray(detail.sections) ? detail.sections : [];
  const savedStatus = String(selectedItem?.state?.status || "pending");
  const hasSavedResult = savedStatus !== "pending";
  const savedEvidence = Array.isArray(selectedItem?.state?.evidence) ? selectedItem.state.evidence : [];
  const showResultEditor = canWrite && (editingResult || !hasSavedResult);

  return (
    <main className="af-checklist-doc">
      <header className="af-checklist-doc__header">
        <button type="button" onClick={() => navigate(returnTo)}>
          <span className="material-symbols-outlined" aria-hidden>arrow_back</span>
          返回 Workflow
        </button>
        <div>
          <small>{demo ? "ACTION CHECKLIST · LOCAL DEMO" : "ACTION CHECKLIST"}</small>
          <h1>{checklist.document?.title || action?.title || "Checklist 详情"}</h1>
          <p>{action?.title || actionKey}</p>
        </div>
        <div className="af-checklist-doc__progress">
          <strong>{progress.completed || 0} / {progress.total || items.length}</strong>
          <span>{progress.ready ? "可确认完成" : "执行中"}</span>
        </div>
      </header>

      {error ? <div className="af-checklist-doc__error">{error}</div> : null}
      {loading ? <LoadingState className="af-checklist-doc__loading" title="正在读取 Checklist" detail="同步执行项、状态与证据…" rows={4} /> : (
        <div className="af-checklist-doc__layout">
          <aside className="af-checklist-doc__toc">
            <div className="af-checklist-doc__meter"><span style={{ width: `${progress.percent || 0}%` }} /></div>
            <p>{progress.percent || 0}% 完成</p>
            <nav aria-label="Checklist 项目">
              {items.map((item, index) => (
                <button
                  type="button"
                  key={item.key}
                  className={item.key === selectedItem?.key ? "is-active" : ""}
                  onClick={() => setSelectedKey(item.key)}
                >
                  <span className={`af-checklist-state af-checklist-state--${item.state?.status || "pending"}`}>
                    <span className="material-symbols-outlined" aria-hidden>{item.state?.status === "passed" ? "check" : item.state?.status === "failed" ? "close" : item.state?.status === "blocked" ? "block" : item.state?.status === "skipped" ? "skip_next" : "radio_button_unchecked"}</span>
                  </span>
                  <span><small>{String(index + 1).padStart(2, "0")}</small><strong>{item.title}</strong></span>
                </button>
              ))}
            </nav>
          </aside>

          <article className="af-checklist-doc__content">
            {selectedItem ? (
              <>
                <div className="af-checklist-doc__title">
                  <div><small>{selectedItem.key}</small><h2>{selectedItem.title}</h2></div>
                  <span className={`is-${selectedItem.state?.status || "pending"}`}>{statusLabel(selectedItem.state?.status)}</span>
                </div>
                {detail.summary ? <p className="af-checklist-doc__summary">{detail.summary}</p> : null}
                <div className="af-checklist-doc__sections">
                  {sections.map((section) => (
                    <section key={section.key || section.title}>
                      <h3>{section.title}</h3>
                      {sectionContent(section.content).length > 1 ? (
                        <ol>{sectionContent(section.content).map((line, index) => <li key={`${section.key}-${index}`}>{line}</li>)}</ol>
                      ) : <p>{sectionContent(section.content)[0] || "暂无内容"}</p>}
                    </section>
                  ))}
                  {!detail.summary && !sections.length ? <p className="af-checklist-doc__empty">该条目暂未上报详细说明。</p> : null}
                </div>

                <section className="af-checklist-doc__result">
                  <div className="af-checklist-doc__result-head">
                    <div><small>执行结果</small><h3>记录状态与证据</h3></div>
                    {demo && showResultEditor ? <span>本地预览 · 不会保存</span> : !canWrite ? <span>只读</span> : hasSavedResult && !showResultEditor ? <span>已记录</span> : null}
                  </div>
                  {showResultEditor ? (
                    <>
                      <div className="af-checklist-doc__status-options">
                        {STATUS_OPTIONS.map(([value, label]) => (
                          <button type="button" key={value} className={status === value ? "is-active" : ""} disabled={saving} onClick={() => setStatus(value)}>{label}</button>
                        ))}
                      </div>
                      <label><span>备注</span><textarea value={note} onChange={(event) => setNote(event.target.value)} disabled={saving} placeholder="补充执行结论、异常现象或豁免原因" /></label>
                      <label><span>证据链接{selectedItem.evidenceRequired ? "（必填）" : ""}</span><input value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} disabled={saving} placeholder="https://…" /></label>
                      <div className="af-checklist-doc__actions">
                        {hasSavedResult ? <button type="button" disabled={saving} onClick={() => setEditingResult(false)}>取消</button> : null}
                        <button type="button" disabled={saving} onClick={() => void save(status)}>{saving ? "保存中…" : "保存"}</button>
                        <button type="button" className="is-primary" disabled={saving || (selectedItem.evidenceRequired && !evidenceUrl.trim())} onClick={() => void save("passed")}>保存并标记通过</button>
                      </div>
                    </>
                  ) : (
                    <div className="af-checklist-doc__result-summary">
                      <div className="af-checklist-doc__result-status">
                        <span className={`af-checklist-state af-checklist-state--${savedStatus}`}><span className="material-symbols-outlined" aria-hidden>{savedStatus === "passed" ? "check" : savedStatus === "failed" ? "close" : savedStatus === "blocked" ? "block" : savedStatus === "skipped" ? "skip_next" : "radio_button_unchecked"}</span></span>
                        <strong>{statusLabel(savedStatus)}</strong>
                      </div>
                      <div className="af-checklist-doc__result-note"><small>备注</small><p>{selectedItem.state?.note || "未填写备注"}</p></div>
                      <div className="af-checklist-doc__result-evidence">
                        <small>证据</small>
                        {savedEvidence.length ? <div>{savedEvidence.map((evidence, index) => (
                          <a key={`${evidence.url || evidence.href}-${index}`} href={evidence.url || evidence.href} target="_blank" rel="noreferrer">
                            <span>{evidence.title || evidence.label || `执行证据 ${index + 1}`}</span>
                            <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
                          </a>
                        ))}</div> : <p>未上传证据</p>}
                      </div>
                      {canWrite ? <div className="af-checklist-doc__actions"><button type="button" onClick={() => setEditingResult(true)}>修改结果</button></div> : null}
                    </div>
                  )}
                </section>

                <footer className="af-checklist-doc__pager">
                  <button type="button" disabled={selectedIndex <= 0} onClick={() => setSelectedKey(items[selectedIndex - 1]?.key || selectedKey)}>上一项</button>
                  <button type="button" disabled={selectedIndex >= items.length - 1} onClick={() => setSelectedKey(items[selectedIndex + 1]?.key || selectedKey)}>下一项</button>
                </footer>
              </>
            ) : <p className="af-checklist-doc__empty">当前 Action 没有 Checklist 条目。</p>}
          </article>
        </div>
      )}
    </main>
  );
}
