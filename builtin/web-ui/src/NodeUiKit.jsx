function slotByName(slots, name) {
  return (Array.isArray(slots) ? slots : []).find((slot) => String(slot?.name || "") === String(name || ""));
}

function slotText(slots, name, fallback = "") {
  const slot = slotByName(slots, name);
  const value = slot?.value ?? slot?.default;
  return value == null || String(value).trim() === "" ? fallback : String(value).trim();
}

function compactCode(value) {
  const text = String(value || "").trim();
  if (!text) return "未配置";
  const flowRef = text.match(/\$\{flowDir\}\/([^\s'\"]+)/);
  if (flowRef) return flowRef[1];
  const firstLine = text.split(/\r?\n/, 1)[0];
  return firstLine.length > 88 ? `${firstLine.slice(0, 85)}…` : firstLine;
}

function parseHistory(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function SectionHeading({ label }) {
  return <div className="af-node-ui-kit__section-heading">{label}</div>;
}

export function NodeUiKitContractSection({ label, slots, renderPort, className = "" }) {
  const contract = Array.isArray(slots) ? slots : [];
  return (
    <section className={`af-node-ui-kit__section af-node-ui-kit__contract${className ? ` ${className}` : ""}`}>
      <SectionHeading label={label} />
      <div className="af-node-ui-kit__contract-list">
        {contract.length ? contract.map((slot, index) => (
          <div key={`${slot?.name || "slot"}-${index}`} className="af-node-ui-kit__contract-row">
            {renderPort?.(slot, index)}
            <code>{slot?.name || `slot_${index + 1}`}</code>
            <em>{slot?.type || "text"}</em>
          </div>
        )) : <span className="af-node-ui-kit__contract-empty">none</span>}
      </div>
    </section>
  );
}

function BindingSection({ section, data }) {
  const binding = data?.nodeUiBindings?.[section.input];
  const literal = slotText(data?.inputs, section.input, "未连接");
  return (
    <section className="af-node-ui-kit__section af-node-ui-kit__binding">
      <SectionHeading label={section.label} />
      <div className="af-node-ui-kit__binding-value" title={binding?.display || literal}>
        <span className="material-symbols-outlined" aria-hidden>{binding ? "cable" : "data_object"}</span>
        <code>{binding?.display || literal}</code>
        <em>{binding ? "CONNECTED" : "LITERAL"}</em>
      </div>
    </section>
  );
}

function CodeSection({ section, data }) {
  const value = data?.[section.field];
  return (
    <section className="af-node-ui-kit__section af-node-ui-kit__code">
      <SectionHeading label={section.label} />
      <div className="af-node-ui-kit__code-value" title={String(value || "未配置")}>
        <span className="material-symbols-outlined" aria-hidden>terminal</span>
        <code>{compactCode(value)}</code>
      </div>
    </section>
  );
}

function LoopTarget({ role, info, data }) {
  const inputs = Array.isArray(info?.inputs) ? info.inputs : [];
  const outputs = Array.isArray(info?.outputs) ? info.outputs : [];
  return (
    <button
      type="button"
      className={`af-node-ui-kit__loop-target af-node-ui-kit__loop-target--${role} nodrag`}
      disabled={!info?.id}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        data?.onEditWhileSubflow?.(info?.id, role);
      }}
      title={info?.id ? `编辑 ${role === "condition" ? "Condition" : "Body"} 子流程` : "尚未创建子流程"}
    >
      <span className="af-node-ui-kit__loop-role">{role === "condition" ? "CONDITION" : "BODY"}</span>
      <span className="material-symbols-outlined" aria-hidden>{role === "condition" ? "rule" : "account_tree"}</span>
      <div>
        <strong>{info?.label || info?.id || "未绑定"}</strong>
        <em>{Number(info?.nodeCount) || 0} 个内部节点</em>
      </div>
      <code>IN {inputs.length ? inputs.join(" · ") : "—"}</code>
      <code>OUT {outputs.length ? outputs.join(" · ") : "—"}</code>
      <span className="material-symbols-outlined af-node-ui-kit__loop-open" aria-hidden>arrow_forward</span>
    </button>
  );
}

function LoopSection({ section, data }) {
  const info = data?.whileSubflowInfo;
  if (!info?.condition && !info?.body) return <CodeSection section={section} data={data} />;
  return (
    <section className="af-node-ui-kit__section af-node-ui-kit__loop">
      <SectionHeading label={section.label} />
      <div className="af-node-ui-kit__loop-targets">
        <LoopTarget role="condition" info={info.condition} data={data} />
        <LoopTarget role="body" info={info.body} data={data} />
      </div>
      <div className="af-node-ui-kit__loop-state-path">
        <span>stateₙ</span><b>→ check → run →</b><span>stateₙ₊₁</span>
      </div>
    </section>
  );
}

function DecisionSection({ section, data }) {
  const current = slotText(data?.outputs, section.output, "").toLowerCase();
  const source = data?.whileSubflowInfo?.condition ? "Condition.decision" : section.source;
  return (
    <section className="af-node-ui-kit__section af-node-ui-kit__decision">
      <div className="af-node-ui-kit__section-title-row">
        <SectionHeading label={section.label} />
        {source ? <code>{source}</code> : null}
      </div>
      <div className="af-node-ui-kit__decision-options">
        {(section.options || []).map((option) => (
          <span
            key={option.value}
            className={`af-node-ui-kit__decision-option af-node-ui-kit__tone--${option.tone}${current === option.value ? " is-active" : ""}`}
            title={option.description || option.label}
          >
            {option.label}
          </span>
        ))}
      </div>
    </section>
  );
}

function MetricsSection({ section, data }) {
  return (
    <section className="af-node-ui-kit__section af-node-ui-kit__metrics">
      <SectionHeading label={section.label} />
      <div className="af-node-ui-kit__metric-grid">
        {(section.items || []).map((item) => {
          const value = item.output
            ? slotText(data?.outputs, item.output, "0")
            : slotText(data?.inputs, item.input, "—");
          const max = item.maxInput ? slotText(data?.inputs, item.maxInput, "—") : "";
          const editableInput = item.maxInput || (!item.output ? item.input : "");
          const editableValue = editableInput ? slotText(data?.inputs, editableInput, "") : "";
          return (
            <div key={`${item.label}-${item.input || item.output}`} className="af-node-ui-kit__metric">
              <span>{item.label}</span>
              {editableInput ? (
                <div className="af-node-ui-kit__metric-edit nodrag" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                  {item.output ? <strong>{value} /</strong> : null}
                  <input
                    type={editableInput === "maxIterations" ? "number" : "text"}
                    min={editableInput === "maxIterations" ? "1" : undefined}
                    max={editableInput === "maxIterations" ? "1000" : undefined}
                    value={editableValue}
                    disabled={Boolean(data?.readOnly)}
                    aria-label={item.label}
                    onChange={(event) => data?.onNodeInputValueChange?.(editableInput, event.target.value)}
                  />
                  {item.suffix ? <em>{item.suffix}</em> : null}
                </div>
              ) : <strong>{value}{max ? ` / ${max}` : ""}{item.suffix || ""}</strong>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SummarySection({ section, data }) {
  const summary = slotText(data?.outputs, section.output, "尚未运行");
  return (
    <section className="af-node-ui-kit__section af-node-ui-kit__summary">
      <SectionHeading label={section.label} />
      <p title={summary}>{summary}</p>
    </section>
  );
}

function HistorySection({ section, data }) {
  const history = parseHistory(slotText(data?.outputs, section.output, "[]")).slice(-section.limit);
  return (
    <section className="af-node-ui-kit__section af-node-ui-kit__history">
      <SectionHeading label={section.label} />
      {history.length ? (
        <ol>
          {history.map((entry, index) => (
            <li key={`${entry?.iteration || index}-${entry?.decision || "event"}`}>
              <b>#{entry?.iteration ?? index + 1}</b>
              <span className={`af-node-ui-kit__history-decision af-node-ui-kit__tone--${entry?.decision === "wait" ? "amber" : entry?.decision === "done" ? "green" : entry?.decision === "fail" ? "red" : "purple"}`}>
                {entry?.decision || "event"}
              </span>
              <em>{entry?.summary || "无摘要"}</em>
            </li>
          ))}
        </ol>
      ) : <p>尚无迭代记录</p>}
    </section>
  );
}

function SubflowSection({ section, data }) {
  const info = data?.subflowInfo || {};
  const inputs = Array.isArray(info.inputs) ? info.inputs : [];
  const outputs = Array.isArray(info.outputs) ? info.outputs : [];
  return (
    <section className="af-node-ui-kit__section af-node-ui-kit__subflow">
      <SectionHeading label={section.label} />
      <button
        type="button"
        className="af-node-ui-kit__subflow-target nodrag"
        disabled={!info.id}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          data?.onEditWhileSubflow?.(info.id, "call");
        }}
        title={info.id ? "编辑子流程" : "尚未绑定子流程"}
      >
        <span className="material-symbols-outlined" aria-hidden>account_tree</span>
        <div><strong>{info.label || info.id || "未绑定"}</strong><em>{Number(info.nodeCount) || 0} 个内部节点</em></div>
        <span className="material-symbols-outlined af-node-ui-kit__subflow-open" aria-hidden>open_in_new</span>
      </button>
      <div className="af-node-ui-kit__subflow-contract">
        <span>IN {inputs.length ? inputs.join(" · ") : "—"}</span>
        <span>OUT {outputs.length ? outputs.join(" · ") : "—"}</span>
      </div>
    </section>
  );
}

export function NodeUiKitCard({ data }) {
  const card = data?.nodeUi?.card;
  if (!card || !Array.isArray(card.sections)) return null;
  return (
    <div className={`af-node-ui-kit af-node-ui-kit--${card.template || "details"} af-node-ui-kit--tone-${card.tone || "neutral"}`}>
      {card.sections.map((section, index) => {
        const key = `${section.type}-${section.label}-${index}`;
        if (section.type === "binding") return <BindingSection key={key} section={section} data={data} />;
        if (section.type === "code") return <CodeSection key={key} section={section} data={data} />;
        if (section.type === "loop") return <LoopSection key={key} section={section} data={data} />;
        if (section.type === "decision") return <DecisionSection key={key} section={section} data={data} />;
        if (section.type === "metrics") return <MetricsSection key={key} section={section} data={data} />;
        if (section.type === "summary") return <SummarySection key={key} section={section} data={data} />;
        if (section.type === "history") return <HistorySection key={key} section={section} data={data} />;
        if (section.type === "subflow") return <SubflowSection key={key} section={section} data={data} />;
        return null;
      })}
    </div>
  );
}
