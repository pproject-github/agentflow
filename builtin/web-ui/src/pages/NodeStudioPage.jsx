import { useCallback, useEffect, useMemo, useState } from "react";

// 清单的形状由 `readNodePackageManifest` 决定——`input` / `output` / `displayName`，
// 不是 `inputs` / `outputs` / `name`。这里曾经按后者读，于是无论生成什么节点，
// Contract 面板永远显示 0 inputs 0 outputs。
const EMPTY_MANIFEST = { id: "", version: "", displayName: "", description: "", input: [], output: [] };

/** 控制槽由运行时自动前置，不该出现在测试输入和契约表里。 */
const isControlSlot = (slot) => String(slot?.type || "") === "node" || slot?.name === "prev" || slot?.name === "next";

function dataSlots(list) {
  return (Array.isArray(list) ? list : []).filter((slot) => slot?.name && !isControlSlot(slot));
}

export default function NodeStudioPage() {
  const [draft, setDraft] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [internalTab, setInternalTab] = useState("source");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  const [testInputs, setTestInputs] = useState({});

  const manifest = draft?.manifest && draft.manifest.id ? draft.manifest : EMPTY_MANIFEST;
  const parseError = String(draft?.parseError || "");
  const source = String(draft?.files?.["index.mjs"] || "");
  const inputSlots = useMemo(() => dataSlots(manifest.input), [manifest]);
  const outputSlots = useMemo(() => dataSlots(manifest.output), [manifest]);
  const testLog = Array.isArray(draft?.test?.log) ? draft.test.log : [];
  const definitionId = manifest.id ? `marketplace:${manifest.id}@${manifest.version}` : "";
  const canPublish = Boolean(source) && !parseError && Boolean(manifest.id);

  const applyDraft = useCallback((next) => {
    setDraft(next || null);
    setPromptDraft(String(next?.promptDraft || ""));
    const saved = next?.test?.inputs;
    if (saved && typeof saved === "object") setTestInputs(saved);
  }, []);

  const loadDraft = useCallback(async (draftId = "") => {
    setLoading(true);
    setError("");
    try {
      const listRes = await fetch("/api/node-studio/drafts");
      const listJson = await listRes.json().catch(() => ({}));
      if (!listRes.ok) throw new Error(listJson.error || "读取节点草稿失败");
      const rows = Array.isArray(listJson.drafts) ? listJson.drafts : [];
      setDrafts(rows);
      const wanted = draftId || rows[0]?.id || "";
      if (!wanted) {
        applyDraft(null);
        return;
      }
      const res = await fetch(`/api/node-studio/draft?id=${encodeURIComponent(wanted)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "读取节点草稿失败");
      applyDraft(json.draft);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, [applyDraft]);

  useEffect(() => {
    void loadDraft();
  }, [loadDraft]);

  const sendPrompt = useCallback(async () => {
    const requirement = promptDraft.trim();
    if (!requirement) return;
    setBusy("generating");
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/node-studio/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: draft?.id || "untitled_node", promptDraft: requirement, appendUserMessage: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error || "生成失败");
      applyDraft(json.draft);
      await loadDraft(json.draft?.id || "");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy("");
    }
  }, [applyDraft, draft, loadDraft, promptDraft]);

  const runTest = useCallback(async () => {
    if (!draft?.id) return;
    setBusy("testing");
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/node-studio/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: draft.id, inputs: testInputs }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error || "测试失败");
      applyDraft(json.draft);
      setInternalTab("tests");
      setNotice(json.status === "passed" ? `测试通过 · ${json.durationMs}ms` : "测试失败，看下方日志");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy("");
    }
  }, [applyDraft, draft, testInputs]);

  const publish = useCallback(async () => {
    if (!draft?.id) return;
    setBusy("publishing");
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/node-studio/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: draft.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error || "发布失败");
      setNotice(`已发布 ${json.definitionId || `${json.id}@${json.version}`}`);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy("");
    }
  }, [draft]);

  const sections = useMemo(() => [
    {
      id: "source",
      label: "index.mjs",
      icon: "code",
      code: source || "// 还没有 index.mjs。在左侧描述你要的节点，Agent 会把实现写在这里。",
      rows: [
        ["package", definitionId || "-"],
        ["run()", source.includes("export function run") || source.includes("export async function run") ? "已导出" : "缺失"],
      ],
    },
    {
      id: "contract",
      label: "Contract",
      icon: "account_tree",
      code: JSON.stringify({ input: manifest.input || [], output: manifest.output || [] }, null, 2),
      rows: [
        ...inputSlots.map((slot) => [`input.${slot.name}`, `${slot.type || "text"}${slot.required ? " · required" : ""}`]),
        ...outputSlots.map((slot) => [`output.${slot.name}`, slot.type || "text"]),
      ],
    },
    {
      id: "tests",
      label: "Tests",
      icon: "science",
      code: testLog.length ? testLog.join("\n") : "还没跑过。",
      rows: [
        ["last run", `${draft?.test?.status || "not run"}${draft?.test?.durationMs ? ` · ${draft.test.durationMs}ms` : ""}`],
      ],
    },
  ], [definitionId, draft, inputSlots, manifest, outputSlots, source, testLog]);
  const section = sections.find((item) => item.id === internalTab) || sections[0];

  return (
    <div className="af-node-studio-page">
      <header className="af-node-studio-top">
        <div>
          <div className="af-settings-crumb">
            <span className="af-settings-crumb-muted">AgentFlow</span>
            <span className="af-settings-crumb-sep">/</span>
            <span className="af-settings-crumb-active">Node Studio</span>
          </div>
          <h1>节点编辑器</h1>
        </div>
        <div className="af-node-studio-actions">
          {drafts.length > 1 ? (
            <select value={draft?.id || ""} onChange={(event) => void loadDraft(event.target.value)}>
              {drafts.map((row) => <option key={row.id} value={row.id}>{row.title || row.id}</option>)}
            </select>
          ) : null}
          <button type="button" onClick={() => void loadDraft(draft?.id || "")} disabled={loading || Boolean(busy)}>
            <span className="material-symbols-outlined" aria-hidden>refresh</span>
            {loading ? "Loading" : "Reload"}
          </button>
          <button type="button" onClick={() => void runTest()} disabled={!canPublish || Boolean(busy)}>
            <span className="material-symbols-outlined" aria-hidden>{busy === "testing" ? "sync" : "science"}</span>
            Test
          </button>
          <button
            type="button"
            className="af-node-studio-actions__primary"
            onClick={() => void publish()}
            disabled={!canPublish || Boolean(busy)}
            title={canPublish ? "发布到本 workspace 的节点市场" : "index.mjs 解析通过之后才能发布"}
          >
            <span className="material-symbols-outlined" aria-hidden>{busy === "publishing" ? "sync" : "publish"}</span>
            Publish
          </button>
        </div>
      </header>

      <main className="af-node-studio-shell">
        <aside className="af-node-studio-agent" aria-label="AI Agent">
          <div className="af-node-studio-panel-head">
            <span className="material-symbols-outlined" aria-hidden>auto_awesome</span>
            <strong>AI Agent</strong>
          </div>
          {error ? <div className="af-node-studio-error">{error}</div> : null}
          {notice ? <div className="af-node-studio-notice">{notice}</div> : null}
          <div className="af-node-studio-thread">
            {!draft ? (
              <div className="af-node-studio-empty">
                还没有节点草稿。描述你要创建的节点，Agent 会写出 index.mjs。
              </div>
            ) : null}
            {(Array.isArray(draft?.agentMessages) ? draft.agentMessages : []).map((message, index) => (
              <div
                key={`${message.role || "message"}-${index}`}
                className={[
                  "af-node-studio-message",
                  message.role === "user" ? "af-node-studio-message--user" : "",
                  message.error ? "af-node-studio-message--error" : "",
                ].filter(Boolean).join(" ")}
              >
                {message.text || ""}
              </div>
            ))}
            {busy === "generating" ? <div className="af-node-studio-message">正在生成 index.mjs...</div> : null}
          </div>
          <label className="af-node-studio-prompt">
            <span>需求</span>
            <textarea
              value={promptDraft}
              placeholder="例如：读一个 CSV，按某一列去重后输出行数和去重后的文件"
              onChange={(event) => setPromptDraft(event.target.value)}
            />
          </label>
          <button type="button" className="af-node-studio-send" onClick={() => void sendPrompt()} disabled={Boolean(busy) || !promptDraft.trim()}>
            <span className="material-symbols-outlined" aria-hidden>{busy === "generating" ? "sync" : "send"}</span>
            {busy === "generating" ? "Generating" : "Send"}
          </button>
        </aside>

        <section className="af-node-studio-preview" aria-label="Preview and Test">
          <div className="af-node-studio-panel-head">
            <span className="material-symbols-outlined" aria-hidden>view_in_ar</span>
            <strong>Preview / Test</strong>
          </div>
          <div className="af-node-studio-preview-grid">
            <div className="af-node-studio-preview-stage">
              {!source ? (
                <div className="af-node-preview-empty">
                  <span className="material-symbols-outlined" aria-hidden>add_box</span>
                  <strong>暂无预览</strong>
                  <p>先在左侧描述你要创建的节点，Agent 生成 index.mjs 后这里会展示节点卡片。</p>
                </div>
              ) : parseError ? (
                <div className="af-node-preview-empty">
                  <span className="material-symbols-outlined" aria-hidden>error</span>
                  <strong>声明解析失败</strong>
                  <p>{parseError}</p>
                  <p>export default 必须是纯字面量——它由 acorn 静态解析，永远不会被执行。</p>
                </div>
              ) : (
                <div className="af-node-preview-card af-node-preview-card--default">
                  <div className="af-node-preview-card__head">
                    <span className="material-symbols-outlined" aria-hidden>extension</span>
                    <strong>{manifest.displayName || manifest.id}</strong>
                    <code>{definitionId}</code>
                  </div>
                  <div className="af-node-preview-default-body">
                    <p>{manifest.description || "这个节点还没有 description。"}</p>
                    <div>
                      <span>{inputSlots.length} inputs</span>
                      <span>{outputSlots.length} outputs</span>
                      <span>tool_nodejs</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="af-node-studio-test">
              <div className="af-node-studio-subhead">
                <strong>Test Inputs</strong>
                <button type="button" onClick={() => void runTest()} disabled={!canPublish || Boolean(busy)}>
                  <span className="material-symbols-outlined" aria-hidden>{busy === "testing" ? "sync" : "play_arrow"}</span>
                  Run
                </button>
              </div>
              <div className="af-node-studio-inputs">
                {inputSlots.length === 0 ? <span className="af-node-studio-empty">节点还没有输入槽。</span> : null}
                {inputSlots.map((slot) => (
                  <label key={slot.name}>
                    <span>{slot.name}{slot.required ? " *" : ""}</span>
                    <input
                      value={testInputs[slot.name] || ""}
                      placeholder={slot.description || slot.type || "text"}
                      onChange={(event) => setTestInputs((current) => ({ ...current, [slot.name]: event.target.value }))}
                    />
                  </label>
                ))}
              </div>
              <div className="af-node-studio-log">
                {(busy === "testing" ? ["running..."] : testLog.length ? testLog : ["No test run yet."]).map((line, index) => (
                  <span key={`${line}-${index}`}>{line}</span>
                ))}
              </div>
            </div>
          </div>
        </section>

        <aside className="af-node-studio-internals" aria-label="Internals">
          <div className="af-node-studio-panel-head">
            <span className="material-symbols-outlined" aria-hidden>fact_check</span>
            <strong>Internals</strong>
          </div>
          <div className="af-node-studio-tabs" role="tablist" aria-label="Internals sections">
            {sections.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === internalTab ? "af-node-studio-tab af-node-studio-tab--active" : "af-node-studio-tab"}
                onClick={() => setInternalTab(item.id)}
              >
                <span className="material-symbols-outlined" aria-hidden>{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
          <div className="af-node-studio-internal-list">
            {section.rows.map(([name, value]) => (
              <div key={name} className="af-node-studio-internal-row">
                <span>{name}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <pre className="af-node-studio-code">{section.code}</pre>
        </aside>
      </main>
    </div>
  );
}
