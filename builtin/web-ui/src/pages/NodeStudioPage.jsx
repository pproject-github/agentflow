import { useCallback, useEffect, useMemo, useState } from "react";

const EMPTY_DRAFT = {
  id: "",
  title: "Untitled Node",
  definitionId: "",
  agentMessages: [],
  promptDraft: "",
  manifest: {
    id: "",
    version: "1.0.0",
    name: "",
    runtime: { type: "agent_subAgent" },
    inputs: [],
    outputs: [],
    configSchema: { fields: [] },
    ui: { card: { icon: "extension", variant: "default", actions: [] } },
  },
  config: {},
  files: {},
  test: { inputs: {}, log: [], status: "not run" },
};

function draftDefinitionId(draft) {
  const manifest = draft?.manifest || {};
  return draft?.definitionId || `marketplace:${manifest.id || draft?.id || "node"}@${manifest.version || "1.0.0"}`;
}

function buildInternalSections(draft) {
  const manifest = draft?.manifest || {};
  const files = draft?.files || {};
  const inputs = Array.isArray(manifest.inputs) ? manifest.inputs : [];
  const outputs = Array.isArray(manifest.outputs) ? manifest.outputs : [];
  const fields = Array.isArray(manifest.configSchema?.fields) ? manifest.configSchema.fields : [];
  const actions = Array.isArray(manifest.ui?.card?.actions) ? manifest.ui.card.actions : [];
  const testInputs = draft?.test?.inputs && typeof draft.test.inputs === "object" ? draft.test.inputs : {};
  return [
    {
      id: "contract",
      label: "Contract",
      icon: "account_tree",
      rows: [
        ...inputs.map((slot) => [`input.${slot.name || "-"}`, `${slot.type || "text"}${slot.required ? " · required" : ""}${slot.default ? ` · default: ${slot.default}` : ""}`]),
        ...outputs.map((slot) => [`output.${slot.name || "-"}`, slot.type || "text"]),
        ...fields.map((field) => [`config.${field.key || "-"}`, field.type || "text"]),
      ],
    },
    {
      id: "runtime",
      label: "Runtime",
      icon: "terminal",
      rows: [
        ["runtime.type", manifest.runtime?.type || manifest.baseDefinitionId || "tool_nodejs"],
        ["runtime.entry", manifest.runtime?.entry || "scripts/run.mjs"],
        ["prompt.md", files["prompt.md"] || "-"],
        ["implementation.md", files["implementation.md"] || "-"],
      ],
    },
    {
      id: "ui",
      label: "UI",
      icon: "dashboard_customize",
      rows: [
        ["card.variant", manifest.ui?.card?.variant || "default"],
        ["card.icon", manifest.ui?.card?.icon || "extension"],
        ...actions.map((action) => [`action.${action.id || action.label || "-"}`, action.variant || action.label || "secondary"]),
      ],
    },
    {
      id: "tests",
      label: "Tests",
      icon: "science",
      rows: [
        ...Object.entries(testInputs).map(([key, value]) => [`sample.${key}`, String(value)]),
        ["last run", `${draft?.test?.status || "not run"}${draft?.test?.durationMs ? ` · ${draft.test.durationMs}ms` : ""}`],
      ],
    },
  ];
}

export default function NodeStudioPage() {
  const [draft, setDraft] = useState(null);
  const [internalTab, setInternalTab] = useState("runtime");
  const [testRunning, setTestRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const activeDraft = draft || EMPTY_DRAFT;
  const sections = useMemo(() => buildInternalSections(activeDraft), [activeDraft]);
  const section = useMemo(
    () => sections.find((item) => item.id === internalTab) || sections[1],
    [internalTab, sections],
  );
  const manifest = activeDraft?.manifest || {};
  const config = activeDraft?.config || {};
  const testInputs = activeDraft?.test?.inputs || {};
  const testLog = Array.isArray(activeDraft?.test?.log) ? activeDraft.test.log : [];
  const cardIcon = manifest.ui?.card?.icon || "event_repeat";
  const cardVariant = manifest.ui?.card?.variant || "default";
  const enabled = config.enabled === true;

  const loadDraft = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const listRes = await fetch("/api/node-studio/drafts");
      const listJson = await listRes.json().catch(() => ({}));
      if (!listRes.ok) throw new Error(listJson.error || "读取节点草稿失败");
      const first = Array.isArray(listJson.drafts) ? listJson.drafts[0] : null;
      if (!first?.id) {
        setDraft(null);
        setPromptDraft("");
        return;
      }
      const res = await fetch(`/api/node-studio/draft?id=${encodeURIComponent(first.id)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "读取节点草稿失败");
      setDraft(json.draft || null);
      setPromptDraft(String(json.draft?.promptDraft || ""));
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDraft();
  }, [loadDraft]);

  const saveDraft = useCallback(async (patch = {}) => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/node-studio/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: draft?.id || "untitled_node", ...patch }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error || "保存节点草稿失败");
      setDraft(json.draft || draft);
      setPromptDraft(String((json.draft || draft)?.promptDraft || ""));
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const runTest = () => {
    setTestRunning(true);
    window.setTimeout(() => setTestRunning(false), 900);
  };

  const toggleEnabled = (nextEnabled) => {
    const nextConfig = { ...config, enabled: nextEnabled };
    setDraft((current) => ({ ...(current || EMPTY_DRAFT), config: nextConfig }));
    void saveDraft({ config: { enabled: nextEnabled } });
  };

  const sendPrompt = () => {
    void saveDraft({ promptDraft, appendUserMessage: true });
  };

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
          <button type="button" onClick={() => void loadDraft()} disabled={loading}>
            <span className="material-symbols-outlined" aria-hidden>visibility</span>
            {loading ? "Loading" : "Preview"}
          </button>
          <button type="button" onClick={runTest}>
            <span className="material-symbols-outlined" aria-hidden>{testRunning ? "sync" : "science"}</span>
            Test
          </button>
          <button type="button" className="af-node-studio-actions__primary">
            <span className="material-symbols-outlined" aria-hidden>publish</span>
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
          <div className="af-node-studio-thread">
            {!draft ? (
              <div className="af-node-studio-empty">
                还没有节点草稿。描述你要创建的节点，发送后会创建一个新的 draft。
              </div>
            ) : null}
            {(Array.isArray(activeDraft?.agentMessages) ? activeDraft.agentMessages : []).map((message, index) => (
              <div
                key={`${message.role || "message"}-${index}`}
                className={message.role === "user" ? "af-node-studio-message af-node-studio-message--user" : "af-node-studio-message"}
              >
                {message.text || ""}
              </div>
            ))}
            <div className="af-node-studio-agent-tools">
              <button type="button"><span className="material-symbols-outlined" aria-hidden>edit</span>修改 UI</button>
              <button type="button"><span className="material-symbols-outlined" aria-hidden>code</span>改脚本</button>
              <button type="button"><span className="material-symbols-outlined" aria-hidden>bug_report</span>修复报错</button>
            </div>
          </div>
          <label className="af-node-studio-prompt">
            <span>需求</span>
            <textarea value={promptDraft} onChange={(event) => setPromptDraft(event.target.value)} />
          </label>
          <button type="button" className="af-node-studio-send" onClick={sendPrompt} disabled={saving}>
            <span className="material-symbols-outlined" aria-hidden>{saving ? "sync" : "send"}</span>
            {saving ? "Saving" : "Send"}
          </button>
        </aside>

        <section className="af-node-studio-preview" aria-label="Preview and Test">
          <div className="af-node-studio-panel-head">
            <span className="material-symbols-outlined" aria-hidden>view_in_ar</span>
            <strong>Preview / Test</strong>
          </div>
          <div className="af-node-studio-preview-grid">
            <div className="af-node-studio-preview-stage">
              {!draft ? (
                <div className="af-node-preview-empty">
                  <span className="material-symbols-outlined" aria-hidden>add_box</span>
                  <strong>暂无预览</strong>
                  <p>先在左侧描述你要创建的节点，AI 生成 draft 后这里会展示节点卡片。</p>
                </div>
              ) : cardVariant === "schedule" ? (
                <div className="af-node-preview-card">
                  <div className="af-node-preview-card__head">
                    <span className="material-symbols-outlined" aria-hidden>{cardIcon}</span>
                    <strong>{activeDraft.title || manifest.name || "Untitled Node"}</strong>
                    <code>{draftDefinitionId(activeDraft)}</code>
                  </div>
                  <label className="af-node-preview-toggle">
                    <input type="checkbox" checked={enabled} onChange={(event) => toggleEnabled(event.target.checked)} />
                    <span>{enabled ? "定时开启" : "定时关闭"}</span>
                  </label>
                  <div className="af-node-preview-fields">
                    <label>
                      <span>频率</span>
                      <select value={config.scheduleType || "daily"} onChange={(event) => saveDraft({ config: { scheduleType: event.target.value } })}>
                        <option value="daily">每天</option>
                        <option value="weekly">每周</option>
                      </select>
                    </label>
                    <label>
                      <span>时间</span>
                      <div>
                        <select value={config.hour || "09"} onChange={(event) => saveDraft({ config: { hour: event.target.value } })}><option>09</option><option>10</option></select>
                        <select value={config.minute || "00"} onChange={(event) => saveDraft({ config: { minute: event.target.value } })}><option>00</option><option>30</option></select>
                      </div>
                    </label>
                  </div>
                  <div className="af-node-preview-meta">
                    <span>{config.scheduleType === "weekly" ? "每周" : "每天"} {config.hour || "09"}:{config.minute || "00"}</span>
                    <span>Next -</span>
                    <span>{enabled ? "enabled" : "disabled"}</span>
                  </div>
                  <div className="af-node-preview-actions">
                    <button type="button" className="af-node-preview-run">
                      <span className="material-symbols-outlined" aria-hidden>play_arrow</span>
                      立即运行
                    </button>
                    <button type="button">
                      <span className="material-symbols-outlined" aria-hidden>article</span>
                      日志
                    </button>
                  </div>
                </div>
              ) : (
                <div className="af-node-preview-card af-node-preview-card--default">
                  <div className="af-node-preview-card__head">
                    <span className="material-symbols-outlined" aria-hidden>{cardIcon}</span>
                    <strong>{activeDraft.title || manifest.name || "Untitled Node"}</strong>
                    <code>{draftDefinitionId(activeDraft)}</code>
                  </div>
                  <div className="af-node-preview-default-body">
                    <p>{manifest.description || "这个节点还没有描述。AI 生成 runtime、prompt 或 script 后，内部信息会显示在右侧。"}</p>
                    <div>
                      <span>{Array.isArray(manifest.inputs) ? manifest.inputs.length : 0} inputs</span>
                      <span>{Array.isArray(manifest.outputs) ? manifest.outputs.length : 0} outputs</span>
                      <span>{manifest.runtime?.type || manifest.baseDefinitionId || "agent_subAgent"}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="af-node-studio-test">
              <div className="af-node-studio-subhead">
                <strong>Test Inputs</strong>
                <button type="button" onClick={runTest}>
                  <span className="material-symbols-outlined" aria-hidden>{testRunning ? "sync" : "play_arrow"}</span>
                  Run
                </button>
              </div>
              <div className="af-node-studio-inputs">
                <label><span>project</span><input value={testInputs.project || ""} readOnly placeholder="-" /></label>
                <label><span>date</span><input value={testInputs.date || ""} readOnly placeholder="-" /></label>
              </div>
              <div className="af-node-studio-log">
                {(testRunning ? ["running..."] : testLog.length ? testLog : ["No test run yet."]).map((line, index) => (
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
          <pre className="af-node-studio-code">{section.id === "ui"
            ? JSON.stringify(manifest.ui || {}, null, 2)
            : section.id === "contract"
              ? JSON.stringify({ inputs: manifest.inputs || [], outputs: manifest.outputs || [], configSchema: manifest.configSchema || {} }, null, 2)
              : section.id === "tests"
                ? JSON.stringify(activeDraft?.test || {}, null, 2)
                : JSON.stringify({ runtime: manifest.runtime || {}, files: activeDraft?.files || {} }, null, 2)}</pre>
        </aside>
      </main>
    </div>
  );
}
