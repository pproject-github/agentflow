import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRoute } from "../routeContext.jsx";
import LoadingState from "../components/LoadingState.jsx";
import {
  ComposerAssistantActivity,
  ComposerAssistantTurn,
} from "../components/ComposerAssistant.jsx";

/**
 * 雷达：定时流程产出的专项监控板。
 *
 * 这个页面**不认识业务**——合规追踪、证书到期、线上问题走的是同一份渲染代码，区别只在板里带的
 * `spec.encode`：哪个字段绑到哪个视觉通道。加一个领域不用动这里。
 *
 * 主图通道是稀缺的（行标签／条长度／颜色／标记／右侧值／分组），行上其余字段一律沉到抽屉。
 */

/** 规划那条流程里，每个节点在跑什么。用节点 id 兜底，图被改过也不至于空着 */
function planNodeLabel(graph, nodeId) {
  const id = String(nodeId || "");
  return String(graph?.instances?.[id]?.label || id);
}

/**
 * 规划节点的产出就是一大段 JSON。原样当聊天气泡贴出来，人看到的是一屏花括号。
 * 它属于执行过程，不属于对话。
 */
function looksLikePlanJson(text) {
  const body = String(text || "").trim();
  return body.startsWith("{") || body.startsWith("```");
}

/**
 * 跑「规划一块雷达板」。
 *
 * 它不是一次 prompt，是 `radar-plan` 那条真流程的一次运行：先让服务端把这次要问的话
 * 写进图（`/api/radar/plan/prepare`），再走通用的 `/api/workspace/run`。
 *
 * 于是执行过程就是普通的 workspace run 事件流——节点开始/结束、思考、工具调用、脚本输出，
 * 和画布上看到的是同一套，用的也是同一批组件。解析失败也不再是死路：图里那条
 * 「没过就让它重发一遍」的边会自己走。
 */
function useRadarPlanRun() {
  const [messages, setMessages] = useState([]);
  const [steps, setSteps] = useState([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [plan, setPlan] = useState(null);
  const abortRef = useRef(null);

  const reset = useCallback(() => {
    setMessages([]);
    setSteps([]);
    setError("");
    setPlan(null);
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  const start = useCallback(async ({ ask, board = "" }) => {
    if (!String(ask || "").trim()) { setError("说一下你想盯什么"); return null; }
    reset();
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const push = (message) => setMessages((current) => [...current.slice(-120), message]);

    try {
      const prep = await fetch("/api/radar/plan/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ask: String(ask).trim(), board }),
        signal: controller.signal,
      });
      const prepared = await prep.json().catch(() => ({}));
      if (!prep.ok) throw new Error(prepared.error || "装不上规划流程");

      // 自己定 runId，取结果时才认得出哪份计划是这次跑的
      const runId = `workspace-radar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const labelOf = (nodeId) => planNodeLabel(prepared.graph, nodeId);

      const res = await fetch("/api/workspace/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({
          flowId: prepared.flowId,
          flowSource: prepared.flowSource,
          runNodeId: prepared.runNodeId,
          graph: prepared.graph,
          runSessionId: runId,
          stream: true,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `规划跑不起来（HTTP ${res.status}）`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // 最后一段可能是半行，留到下一块再拼
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }

          if (event.type === "error") { streamError = event.error || "规划失败"; continue; }
          if (event.type === "node-start") {
            setSteps((current) => [...current, { nodeId: event.nodeId, label: labelOf(event.nodeId), status: "running" }]);
            continue;
          }
          if (event.type === "node-done") {
            setSteps((current) => current.map((step) => (
              step.nodeId === event.nodeId
                ? { ...step, status: event.skipped ? "skipped" : "done" }
                : step
            )));
            continue;
          }
          if (event.type === "status") {
            const text = String(event.line || event.message || "").trim();
            if (text) push({ kind: "activity", label: labelOf(event.nodeId) || "Activity", text });
            continue;
          }
          if (event.type === "script-start" || event.type === "script-finish") {
            const text = String(event.stdout || event.script || "").trim();
            if (text) push({ kind: "activity", label: "Script", text: text.slice(0, 2000) });
            continue;
          }
          if (event.type === "natural") {
            const text = String(event.text || "").trim();
            if (!text) continue;
            if (event.kind === "thinking") { push({ kind: "thinking", label: "Thinking", text }); continue; }
            // 注入给 agent 的那段提示词（文件边界、绝对路径、AGENTFLOW_* 变量）是内部实现，
            // 和画布里的 Composer 一样折进「执行过程」，不能当成 AI 的发言摊在页面上
            if (event.kind === "prompt") { push({ kind: "activity", label: "Prompt", text }); continue; }
            if (event.kind === "error" || event.kind === "warning") {
              push({ kind: "activity", label: event.kind === "error" ? "Error" : "Warning", text });
              continue;
            }
            // 规划的产出是 JSON，它属于执行过程不属于对话
            if (looksLikePlanJson(text)) { push({ kind: "activity", label: "Plan JSON", text }); continue; }
            push({ role: "assistant", text });
          }
        }
      }
      if (streamError) throw new Error(streamError);

      const got = await fetch(`/api/radar/plan/result?runId=${encodeURIComponent(runId)}`);
      const body = await got.json().catch(() => ({}));
      if (!got.ok || !body.ok) throw new Error(body.error || "跑完了，但没拿到可用的计划");
      setPlan(body.plan);
      return body.plan;
    } catch (e) {
      if (e?.name !== "AbortError") setError(String(e.message || e));
      return null;
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }, [reset]);

  return { messages, steps, running, error, plan, start, stop, reset, setError, setPlan };
}

/** 执行过程：对话气泡走上面，工具调用和思考折进「执行过程」，和画布里的 Composer 同构 */
function PlanRunView({ messages, steps, running }) {
  const turns = messages.filter((item) => item.role === "assistant");
  const activity = messages.filter((item) => item.role !== "assistant");
  const active = steps.filter((step) => step.status === "running").map((step) => step.label);
  return (
    <div className="af-radar-plan-run">
      {steps.length ? (
        <ol className="af-radar-plan-steps">
          {steps.map((step, index) => (
            <li key={`${step.nodeId}-${index}`} className={`af-radar-plan-step--${step.status}`}>
              <i />{step.label}
            </li>
          ))}
        </ol>
      ) : null}
      <ComposerAssistantActivity
        items={activity.map((item, index) => ({
          id: `${item.kind}-${index}-${String(item.text || "").slice(0, 24)}`,
          kind: item.kind,
          label: item.label,
          text: item.text,
        }))}
        running={running}
        label="执行过程"
        defaultOpen={false}
      />
      {turns.map((item, index) => (
        <ComposerAssistantTurn key={`turn-${index}`} role="assistant" content={item.text} copy={false} />
      ))}
      {running ? (
        <ComposerAssistantTurn
          pending
          copy={false}
          pendingLabel={active.length ? `正在跑「${active.join("、")}」` : "正在启动规划流程"}
        />
      ) : null}
    </div>
  );
}

/**
 * 年份按钮列出哪些年。
 *
 * 只列今年的话，已经过期的和明年才到期的条目永远翻不到；列一个固定范围又会出现
 * 一堆点进去空空如也的年份。所以按板上真实出现过的日期来，并且总把今年算进去——
 * 一块新板上一个日期都没有时，至少还有一个能落脚的年。
 */
function boardYears(board) {
  const years = new Set([new Date().getFullYear()]);
  for (const row of board?.rows || []) {
    for (const value of [row.due, row.policyDue, row.startAt, row.endAt, row.firstSeenAt, row.lastSeenAt]) {
      const time = toTime(value);
      if (Number.isFinite(time)) years.add(new Date(time).getFullYear());
    }
  }
  return [...years].sort((a, b) => a - b);
}
const VIEW_META = {
  status: { label: "状态页", icon: "monitor_heart" },
  runway: { label: "跑道", icon: "view_timeline" },
  board: { label: "看板", icon: "view_kanban" },
  table: { label: "表格", icon: "table_rows" },
  agents: { label: "协作", icon: "hub" },
};
/**
 * 暂时不露面的东西。
 *
 * 看板和表格还停在「能渲染」的水平——跑道上这一轮加的分面、来源、时点，
 * 那两个视图一个都不认；摆在工具栏上只会让人点进去看到一个更旧的版本。
 * 我的/全部 在没人认领的板上两边一模一样，分组会把父子拍平——都先收起来。
 * 藏的是入口不是能力：地址栏带 `view=table` / `scope=all` / `group=tags` 仍然生效，
 * 想验证或者想要回来，改这三个常量就行。
 */
const HIDDEN_VIEWS = new Set(["board", "table"]);
const SHOW_SCOPE_SWITCH = false;
// 分组回来了：状态页**原生就是分组的**（大组 → 政策 → 端 → 任务），
// 藏掉它等于把这个形态的骨架砍掉一节。默认值仍然由板的 spec.encode.group 给
const SHOW_GROUP_BY = true;
// idle 是「没人给过结论」，不是一种进度。叫「待确认」会被当成「等人点头」，而那是门禁里另一件事
/**
 * 状态怎么念，**是板说了算**。
 *
 * 这四个只是兜底：一块合规板上 ok 念「已满足」，一块线上问题板该念「已恢复」，
 * 一块争议板该念「已定论」。把说法钉死在代码里，等于这套渲染只能跑合规板——
 * 而「同一份代码跑不同的板」正是它存在的理由。板在 spec.states 里写自己的说法。
 */
const STATE_FALLBACK = { risk: "未开始", warn: "进行中", idle: "无状态", ok: "已满足" };
const FIELD_FALLBACK = { current: "现状", evidence: "依据", required: "要求" };

/**
 * 板的词典。用 context 而不是一路当 props 传：
 * 状态说法在六个组件里都要用，逐层传下去的话每加一个新说法都要改六处签名。
 */
const VocabContext = createContext(null);

function useVocab() {
  const spec = useContext(VocabContext);
  const states = { ...STATE_FALLBACK, ...(spec?.states || {}) };
  const fields = { ...FIELD_FALLBACK, ...(spec?.fields || {}) };
  const themes = new Map((spec?.themes || []).map((item) => [item.key, item.label]));
  return {
    /** 事件里可能出现 `unknown`——它不是四个取值之一，归到「无状态」那一档 */
    state: (value) => {
      const raw = String(value || "").trim();
      if (!raw) return "—";
      return states[raw] || (raw === "unknown" ? states.idle : raw);
    },
    field: (key) => fields[key] || key,
    /** 大组只有 key 时就显示 key——但那说明建板时没给名字，是个该补的洞，不是正常态 */
    theme: (key) => themes.get(String(key)) || String(key),
    themeOrder: (spec?.themes || []).map((item) => item.key),
    tags: spec?.tags || [],
  };
}
const KIND_LABEL = { moved: "改期", worse: "变坏", better: "变好", new: "新增" };

/** 通道可以写成 "field" 或 { field, ... }，两种都要认 */
function channelField(channel) {
  if (!channel) return "";
  if (typeof channel === "object") return String(channel.field || "");
  return String(channel);
}

function readCell(row, channel) {
  const field = channelField(channel);
  return field ? row?.[field] : undefined;
}

function toTime(value) {
  if (value === undefined || value === null || value === "") return NaN;
  const time = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(time) ? time : NaN;
}

function formatDay(value) {
  const time = toTime(value);
  if (!Number.isFinite(time)) return "-";
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 带时分的时间戳。「最近写入」只给日期的话，一天跑四次的流程看起来一整天没动过 */
function formatStamp(value) {
  const time = toTime(value);
  if (!Number.isFinite(time)) return "-";
  const date = new Date(time);
  const pad = (n) => String(n).padStart(2, "0");
  return `${formatDay(value)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatValue(row, channel) {
  const raw = readCell(row, channel);
  if (raw === undefined || raw === null || raw === "") return "";
  const template = typeof channel === "object" ? String(channel.format || "") : "";
  if (template.includes("{}")) return template.replace("{}", String(raw));
  return String(raw);
}

/** 有效截止日是怎么来的，要能说清楚——否则人只会觉得倒计时算错了 */
function effectiveNote(row) {
  if (row.effectiveTrain) return `${row.effectiveTrain} 封包`;
  if (row.effectiveReason === "beyond_known_trains") return "排期还没排到那儿";
  if (row.effectiveReason === "no_train_in_reach") return "赶不上任何一班车";
  if (row.effectiveReason === "no_trains") return "没有配版本车";
  return "";
}

/**
 * 跳到产出这块板的编排画布，去配它的定时任务。
 *
 * 必须带上 `returnTo`：画布默认的返回是 `/projects`，不带的话人点完返回就被甩到项目列表，
 * 「从板进去改、改完回板」这条来回就断了。
 */
function flowCanvasUrl(flow, returnTo) {
  if (!flow?.flowId) return "";
  const query = new URLSearchParams({ flowId: flow.flowId, flowSource: flow.flowSource || "user" });
  if (flow.workspaceId) query.set("workspaceId", flow.workspaceId);
  if (flow.ownerUserId) query.set("adminOwnerId", flow.ownerUserId);
  if (flow.scheduleNodeId) query.set("focusNodeId", flow.scheduleNodeId);
  if (returnTo) query.set("returnTo", returnTo);
  return `/workspace?${query.toString()}`;
}

/**
 * 「编排」在多片时的分流。
 *
 * 一块板由几条流程各写各的片，点编排要先问「哪一条」。这个组件在 HEAD 上被引用了
 * 却从来没定义过——因为在此之前每块板都只有一片，代码总是走 soleCanvasUrl 那条直达分支，
 * 这一支永远到不了。板一旦长出第二片，点一下就是整页白屏。
 */
function FlowPicker({ flows = [], navigate, returnTo, onClose, onAdd }) {
  return (
    <div className="af-radar-flowpick" role="dialog" aria-label="选择要打开的流程">
      <div className="af-radar-flowpick-head">
        <span>这块板由 {flows.length} 条流程写</span>
        <button type="button" className="af-radar-x" onClick={onClose} aria-label="关闭">×</button>
      </div>
      {flows.map((shard) => {
        const url = flowCanvasUrl({ flowId: shard.flowId, ...(shard.flow || {}) }, returnTo);
        // 声明负责什么 vs 实际写了几条：对不上正是「该认领的没认领」，这里是最该看见它的地方
        const declared = (shard.declaredOwns || []).join(" / ");
        return (
          <button
            type="button"
            key={shard.flowId}
            className="af-radar-flowpick-item"
            disabled={!url}
            title={url ? "打开这条流程的画布" : "这一片没记录是哪条流程写的"}
            onClick={() => { onClose?.(); if (url) navigate(url); }}
          >
            <span className="af-radar-flowpick-name">
              {shard.flowId}
              {shard.stale ? <i className="af-radar-flowpick-stale">哑了</i> : null}
            </span>
            <span className="af-radar-flowpick-meta">
              {shard.rows} 条{declared ? ` · 负责 ${declared}` : ""}
              {shard.updatedAt ? ` · ${String(shard.updatedAt).slice(0, 16).replace("T", " ")}` : " · 从没跑过"}
            </span>
          </button>
        );
      })}
      {/*
       * 「再加一条流程」必须在这里。这个面板回答的是「这块板由谁在写」——
       * 看完这份名单，下一个念头就是「少了谁」。把加的入口放到别处，人得先关掉它、
       * 再去工具栏找 AI 调整、再自己想出「加一条流程」这句话。
       * 走的还是提案→审批→生成那条路，只是把开头那句话先填好。
       */}
      {onAdd ? (
        <button type="button" className="af-radar-flowpick-add" onClick={onAdd}>
          <span className="material-symbols-outlined">add</span>
          再加一条流程盯别的端
        </button>
      ) : null}
    </div>
  );
}

/** 新建一块板时的例子：从零说清楚要盯什么 */
const PLAN_EXAMPLES = [
  "盯 Android 和 iOS 商店的政策与平台要求，代码现状也要能看出来",
  "盯我们所有证书、密钥、Token 的到期时间",
  "盯开了超过 90 天还没下线的 AB 实验",
];

/**
 * 已有板上的例子：**增量动作**。
 *
 * 在一块已经有条目和流程的板上问「想盯什么」，等于假装它是空的——人只能把
 * 建板时那句话再抄一遍，AI 拿到的也还是那句话。板内该问的是「在现在这个基础上改什么」。
 */
const TUNE_EXAMPLES = [
  "再加一条流程，专门盯 BigoLive 的适配情况",
  "Play Console 那几条我自己查，别再每天扫了",
  "16KB 那条改成每天跑，其余保持每周",
  "把 aep 相关的拆细一点，现在一条里塞了太多事",
];

/**
 * 板级编排：先出计划，再逐条去建。
 *
 * 不是「一句话建一条流程」——用户要盯的是一个领域，而一个领域往往需要好几条不同节奏的定时：
 * 政策一年变几次，代码天天变，塞进一条里必然一边浪费一边滞后。这件事该由 AI 想清楚，
 * 由人点头，而不是让人自己拆。
 */
/**
 * 板级编排：先出计划，再逐条去建。
 *
 * 走**右侧抽屉**而不是小浮层：一次规划要跑几十秒到几分钟，浮层一关就没了，过程也无处可看。
 * 和画布里的 Composer 同构——过程流式滚出来，计划出来之后还能继续追问。
 */
function PlanDrawer({ board, boardId, returnTo, onClose, navigate, seed = "" }) {
  /**
   * 板上已经有东西，这里就是**调整**，不是编排。
   *
   * 在一块已经跑起来的板上问「想让它盯什么」，是把它当成空板重新问一遍——
   * 人只能把建板时那句话再抄一次，AI 也拿不到「在现有基础上改什么」这个信息。
   */
  const tuning = Boolean(boardId) && Boolean(board?.rows?.length);
  const [ask, setAsk] = useState(seed);
  const [creating, setCreating] = useState("");
  const run = useRadarPlanRun();
  const { plan, messages, steps, error } = run;
  const busy = run.running;
  const setError = run.setError;

  const requestPlan = async () => {
    if (!ask.trim()) { setError("说一下你想盯什么"); return; }
    await run.start({ ask: ask.trim(), board: boardId || "" });
  };

  // 逐条建：一次只建一条，建完直接进画布让 AI 搭内容
  const buildFlow = async (flow) => {
    setCreating(flow.flowId);
    setError("");
    try {
      if (!flow.exists) {
        const res = await fetch("/api/flows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flowId: flow.flowId, targetSpace: "user", description: flow.why || flow.title }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok && res.status !== 409) throw new Error(body.error || "建流程失败");
      }
      const query = new URLSearchParams({
        flowId: flow.flowId,
        flowSource: "user",
        aiPrompt: buildFlowPrompt(flow, boardId),
      });
      if (returnTo) query.set("returnTo", returnTo);
      navigate(`/workspace?${query.toString()}`);
    } catch (e) {
      setError(String(e.message || e));
      setCreating("");
    }
  };

  return (
    <>
      <div className="af-radar-scrim" onClick={busy ? undefined : onClose} />
      <aside className="af-radar-drawer af-radar-plan-drawer" role="dialog" aria-modal="true" aria-label={tuning ? "AI 调整" : "AI 编排"}>
        <button type="button" className="af-radar-drawer-close" onClick={onClose} aria-label="关闭">×</button>
        <h3>{tuning ? "AI 调整" : "AI 编排"}</h3>
        <p className="af-radar-drawer-lead">
          {tuning
            ? `读当前这块板（${board.rows.length} 条、${(board.flows || []).length} 条流程），照你说的改：加减条目、调流程节奏、拆细或合并。提案出来之前不动任何东西。`
            : "读当前这块板，排出该配几条定时、各管哪些条目、各自什么节奏。这一步不动任何东西。"}
        </p>

        <label className="af-radar-new-field">
          <span>{tuning ? "想改什么" : boardId ? `想让「${board?.title || boardId}」盯什么` : "想盯什么"}</span>
          <textarea
            rows={3}
            value={ask}
            disabled={busy}
            placeholder={tuning ? "再加一条流程盯 BigoLive；16KB 那条改成每天跑…" : "盯 Android 和 iOS 商店的政策与平台要求…"}
            onChange={(event) => setAsk(event.target.value)}
          />
        </label>
        {!plan && !busy ? (
          <div className="af-radar-new-examples">
            {(tuning ? TUNE_EXAMPLES : PLAN_EXAMPLES).map((example) => (
              <button type="button" key={example} onClick={() => setAsk(example)}>
                {example.length > 16 ? `${example.slice(0, 16)}…` : example}
              </button>
            ))}
          </div>
        ) : null}
        <button type="button" className="af-radar-new-go" disabled={busy} onClick={() => void requestPlan()}>
          <span className="material-symbols-outlined">auto_awesome</span>
          {busy ? (tuning ? "正在想…" : "正在排…") : plan ? "换个说法重来" : tuning ? "让 AI 改一下" : "让 AI 排一下"}
        </button>

        {/* 过程摊开给人看。转圈转三分钟，谁都会以为它挂了 */}
        {busy || messages.length || steps.length ? (
          <PlanRunView messages={messages} steps={steps} running={busy} />
        ) : null}

        {error ? <p className="af-radar-new-error">{error}</p> : null}

        {plan ? (
          <>
            <h4>计划</h4>
            {plan.summary ? <p className="af-radar-plan-summary">{plan.summary}</p> : null}
            {plan.flows.map((flow) => (
              <div key={flow.flowId} className="af-radar-plan-flow">
                <div className="af-radar-plan-top">
                  <span className={`af-radar-plan-act af-radar-plan-act--${flow.action}`}>
                    {flow.action === "create" ? "新建" : flow.action === "update" ? "改" : "保留"}
                  </span>
                  <span className="af-radar-flow-name">{flow.flowId}</span>
                </div>
                <p className="af-radar-plan-why">{flow.why || flow.title}</p>
                <p className="af-radar-plan-meta">
                  {flow.cron ? <code>{flow.cron}</code> : null}
                  {flow.cadenceWhy ? <span> {flow.cadenceWhy}</span> : null}
                </p>
                {flow.owns.length ? (
                  <p className="af-radar-plan-meta">负责 {flow.owns.includes("*") ? "全部条目" : flow.owns.join("、")}</p>
                ) : null}
                {flow.action === "keep" ? null : (
                  <button
                    type="button"
                    className="af-radar-plan-go"
                    disabled={Boolean(creating)}
                    onClick={() => void buildFlow(flow)}
                  >
                    {creating === flow.flowId ? "正在建…" : flow.exists ? "去改它" : "建并进画布"}
                  </button>
                )}
              </div>
            ))}

            {/* 计划是待审草案。它会不会造出重复认领、漏掉条目，必须当面说清楚 */}
            {plan.warnings?.length ? (
              <div className="af-radar-plan-warn">
                <b>需要你确认</b>
                <ul>{plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              </div>
            ) : null}
            {plan.notes?.length ? (
              <ul className="af-radar-plan-notes">{plan.notes.map((note) => <li key={note}>{note}</li>)}</ul>
            ) : null}
          </>
        ) : null}
      </aside>
    </>
  );
}

/** 交给画布 Composer 的提示词：把这条流程在计划里的职责原样带过去 */
function buildFlowPrompt(flow, boardId) {
  return [
    `搭一条定时流程：${flow.title || flow.flowId}`,
    flow.why ? `\n它存在的理由：${flow.why}` : "",
    flow.cron ? `\n定时：${flow.cron}${flow.cadenceWhy ? `（${flow.cadenceWhy}）` : ""}` : "",
    flow.owns?.length ? `\n负责写这些追踪项：${flow.owns.join("、")}` : "",
    flow.updates?.length ? `\n只更新这些字段：${flow.updates.join("、")}` : "",
    flow.prompt ? `\n\n${flow.prompt}` : "",
    "",
    "\n按这几条来：",
    "- 先抓来源 → 归一化 → 算 sha256 → 和上次比。没变就不要调模型；",
    "- 判定仓库现状要用确定性脚本，匹配不到返回 unknown，绝不默认当成通过；",
    "- 抓取失败要和「没有变化」分开记；",
    `- 末尾把结果写进雷达板 ${boardId || "<board>"} 自己那一片（只写本流程负责的条目，别碰别人的）。`,
  ].filter(Boolean).join("");
}

function monthTicks(start, end) {
  const ticks = [];
  const cursor = new Date(start);
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);
  /**
   * 窗口正好从月初开始时（自然年就是），那一刻本身就是一个刻度，要留着。
   * 原来无条件跳到下个月，是因为旧窗口从「今天」起算，月中的半截月份标在左边缘会很怪；
   * 换成自然年之后同一行代码变成了「1 月凭空消失」。
   */
  if (cursor.getTime() < start) cursor.setMonth(cursor.getMonth() + 1);
  while (cursor.getTime() < end && ticks.length < 24) {
    ticks.push(cursor.getTime());
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return ticks;
}

/** 跑道上固定能分的两组：负责人、来源流程。它们一定存在，也一定有意义 */
const FIXED_GROUPS = [
  // theme 是板在 spec.themes 里申明的大组，是这块板自己的结构维度，
  // 不是哪条流程随手写出来的字段。落到 derived 里的话下拉会直接显示 key「theme」
  { field: "theme", label: "大组" },
  { field: "owner", label: "负责人" },
  { field: "flowId", label: "来源流程" },
  // 标签是多值的：一条带三个 tag 会同时出现在三个组里，和 Notion 的 multi-select 一致
  { field: "tags", label: "标签", multi: true },
];
/** 分组没有意义的字段：要么每行都不一样（证据、链接），要么是算出来的中间量 */
const NEVER_GROUP = new Set([
  "id", "title", "due", "effectiveDue", "cutoffDate", "daysLeft", "lastSeenAt",
  "evidence", "source", "current", "required", "effectiveReason", "effectiveTrain",
]);

/**
 * 哪些字段拿来分组是讲得通的。
 *
 * 判据是**取值的散度**：每行都不一样的字段（证据、链接）分出来是一行一组，等于没分；
 * 全表一个值的字段分出来只有一组，也等于没分。所以只留 2～8 个取值的。
 */
function groupableFields(rows = [], labelOf) {
  const counts = new Map();
  for (const row of rows) {
    for (const [field, value] of Object.entries(row || {})) {
      if (NEVER_GROUP.has(field) || FIXED_GROUPS.some((item) => item.field === field)) continue;
      if (value === null || value === undefined || value === "") continue;
      if (typeof value === "boolean") continue;
      // 数组字段（自定义的多值维度）按元素计散度，否则 ["a","b"] 会被当成一个取值，
      // 两行只要数组顺序不同就各成一组——散度算出来永远超标，字段永远进不了下拉
      const values = Array.isArray(value) ? value : typeof value === "object" ? [] : [value];
      if (!values.length) continue;
      const seen = counts.get(field) || new Set();
      for (const item of values) {
        const text = String(item ?? "").trim();
        if (text) seen.add(text);
      }
      counts.set(field, seen);
    }
  }
  const derived = [...counts.entries()]
    .filter(([, seen]) => seen.size >= 2 && seen.size <= 8)
    .map(([field]) => ({ field, label: labelOf?.(field) || field }))
    .sort((a, b) => a.field.localeCompare(b.field));
  // 固定组里只有 owner / flowId 一定存在；标签是可选的，板上一个都没有时不该出现在下拉里
  const fixed = FIXED_GROUPS.filter((item) => {
    if (item.multi) return rows.some((row) => Array.isArray(row?.[item.field]) && row[item.field].length);
    // owner / flowId 一定有；theme 要板上真的申明过大组才挂
    if (item.field === "theme") return rows.some((row) => String(row?.theme || "").trim());
    return true;
  });
  return [...fixed, ...derived];
}

/**
 * 按字段把行切成段。空值单独归一组放最后——它们通常正是要补的那批。
 *
 * 多值字段（tags）一行进多个桶：一条带 `aep` 和 `android16` 的条目在两个分组里都看得见。
 * 这是刻意的重复，不是 bug——Notion 的 multi-select 分组就是这个语义，
 * 而「一条只能属于一个分类」恰恰是标签这个东西不成立的前提。
 */
/**
 * @param {(key: string) => string} [labelOf] 把分组的 key 翻成给人看的名字。
 *   没有它的话，按大组分出来的抬头会写着 `android16`——那是存的 key，不是人想看的字。
 * @param {string[]} [order] 大组在页面上的先后。板里写的顺序就是业务上的顺序，
 *   字典序会把「隐私合规」排到「账号与权限」前面，读起来毫无道理
 */
function groupRows(rows = [], field = "", { primaryOnly = false, labelOf, order } = {}) {
  if (!field) return [{ key: "", label: "", rows }];
  const buckets = new Map();
  const push = (key, row) => {
    const list = buckets.get(key) || [];
    list.push(row);
    buckets.set(key, list);
  };
  for (const row of rows) {
    const raw = row?.[field];
    if (Array.isArray(raw)) {
      const values = raw.map((item) => String(item ?? "").trim()).filter(Boolean);
      if (!values.length) push("", row);
      // 「只进主组」：第一个标签就是主标签。写的人本来就是按重要性排的，
      // 不需要再造一个 primaryTag 字段让 agent 多维护一份、还可能和 tags 对不上
      else if (primaryOnly) push(values[0], row);
      else for (const value of values) push(value, row);
      continue;
    }
    const key = raw === null || raw === undefined || raw === "" ? "" : String(raw);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const rank = new Map((order || []).map((key, index) => [String(key), index]));
  const sections = [...buckets.entries()].map(([key, list]) => ({
    key,
    label: key ? (labelOf ? labelOf(key) : key) : (field === "owner" ? "无人认领" : "未填"),
    rows: list,
  }));
  sections.sort((a, b) => (
    // 没填的永远垫底；板里排过序的按那个顺序；剩下的才按字典序
    (a.key ? 0 : 1) - (b.key ? 0 : 1)
    || (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9)
    || a.key.localeCompare(b.key)
  ));
  return sections;
}

/**
 * 跑道的时间窗 = 一个自然年。
 *
 * 原来是「从今天起 N 个月」，滑动窗口有两个毛病：刻度每天都在动，昨天截的图和今天的
 * 对不上；而且永远看不到过去——已经过期的、去年入库的条目在窗口外，等于不存在。
 * 钉死在自然年之后，横轴是稳定的，年份按钮就是翻页。
 */
function yearWindow(year) {
  return { start: new Date(year, 0, 1).getTime(), end: new Date(year + 1, 0, 1).getTime() };
}

/** 一行上所有会落到时间轴上的时刻。截止日仍然听板的 `encode.end`，板能改它指哪个字段 */
function rowMoments(row, encode = {}) {
  return [
    { key: "due", time: toTime(encode.end ? readCell(row, encode.end) : row?.due), label: "截止" },
    { key: "policy", time: toTime(row?.policyDue), label: "政策截止" },
    { key: "born", time: toTime(row?.firstSeenAt), label: "入库" },
    { key: "seen", time: toTime(row?.lastSeenAt), label: "最近写入" },
  ].filter((moment) => Number.isFinite(moment.time));
}

function Runway({ board, encode, year, group, primaryOnly = false, onPick, tagFilter = "", onTag = () => {} }) {
  const vocab = useVocab();
  const now = Date.now();
  const { start, end } = yearWindow(year);
  const at = (time) => ((time - start) / (end - start)) * 100;
  const inWindow = (time) => Number.isFinite(time) && time >= start && time <= end;
  const ticks = monthTicks(start, end);
  const trains = (board.trains || [])
    .map((train) => ({ ...train, time: toTime(train.cutoff) }))
    .filter((train) => inWindow(train.time));

  /**
   * 版本车按行画，不能全表共用一份。
   *
   * 版本车按分片分之后，某一行上出现别的流程的封包日就是在骗人——
   * 那班车跟这一条毫无关系，而竖线在跑道上读起来正是「这条得赶上它」。
   * 不带 scope 的车是通用车，对谁都画。
   *
   * 月刻度和「今天」那条线相反：它们对每一行都一样，所以画在整张表的一层浮层上，
   * 一根到底。原来每行各画一段，行与行之间有内边距，连起来是虚的。
   */
  const guidesFor = (row) => {
    const owner = String(row?.flowId || "").trim();
    const mine = trains.filter((train) => {
      const scope = String(train.scope || "").trim();
      return !scope || (owner && scope === owner);
    });
    if (row?.rolledUp) return null;
    return mine.map((train) => (
      <i key={`v${train.version}-${train.cutoff}`} className="af-radar-train" style={{ left: `${at(train.time)}%` }} />
    ));
  };

  /**
   * 子行按 `parent` 现算，不读 `row.children`。
   *
   * `children` 是服务端推出来的字段，跟着板走；这里要回答的是「**当前这份 rows 里**
   * 谁挂在谁下面」。两者一旦不一致——被筛掉、被覆盖层改过——就会出现
   * 「父行收着，子行却单独出现在顶层」这种鬼样子。
   */
  const kidsOf = new Map();
  for (const row of board.rows) {
    const parent = String(row?.parent || "").trim();
    if (!parent) continue;
    const list = kidsOf.get(parent) || [];
    list.push(row);
    kidsOf.set(parent, list);
  }
  /**
   * **一旦分组就平铺。**
   *
   * 分组是平铺操作，父子嵌套只在不分组时成立。早先只对 app / flowId 平铺，
   * 结果按标签分组时子任务被滤掉了——而标签只长在子任务上，父行一个都没有，
   * 六条政策整整齐齐落进「未填」，看起来像分组根本没生效。
   *
   * 反过来也一样：按负责人分组时，一条认领了的子任务不该因为它是子任务
   * 就从那个人的组里消失。
   */
  const flat = Boolean(group);
  const visibleRows = flat ? board.rows : board.rows.filter((row) => !isFacet(row));
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = (id) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const parentCount = visibleRows.filter((row) => !isFacet(row)).length;
  const facetCount = board.rows.filter(isFacet).length;
  /**
   * 卡在门禁里的结论。
   *
   * agent 查完写了「已满足」，门禁把它拦下等人点头，于是板上显示的还是旧值——
   * 行上什么都不说的话，人看到的是「待确认」，会以为流水线没查出来。
   * 实际上它查出来了，只是**在等你**。这两件事必须分得开。
   */
  const heldState = new Map();
  for (const entry of Object.values(board.pending || {})) {
    for (const item of entry.held || []) {
      if (item.kind === "state") heldState.set(String(item.id), String(item.to || ""));
    }
  }

  const nowAt = inWindow(now) ? at(now) : null;

  return (
    <div className="af-radar-runway">
      {/* 内层撑到内容宽度，浮层才量得准：浮层如果挂在滚动容器上，它只有视口那么宽 */}
      <div className="af-radar-sheet">
      {/*
        月刻度和「今天」画在一层浮层上，从表头底一直到最后一行。
        原来每行各画一段，行与行之间有 22px 内边距，连起来是一串虚线；
        而「当前时间」这条线的全部意义就是**贯穿**——哪几行在它左边、哪几行在右边。
      */}
      <div className="af-radar-overlay" aria-hidden="true">
        {ticks.map((tick) => <i key={`o${tick}`} className="af-radar-tick" style={{ left: `${at(tick)}%` }} />)}
        {nowAt === null ? null : <i className="af-radar-now" style={{ left: `${nowAt}%` }} />}
      </div>
      <div className="af-radar-axis">
        {/* 左边这 250px 是条目名那一列，之前是空的——时间轴有刻度、条目列却没抬头，
            看着像表格少画了一块。计数跟着当前视角走（「我的」和「全部」数出来不一样） */}
        <span className="af-radar-axis-head">
          {/* 展开着的那些得有个统一的关法。一条条找回去收，正是「怎么还漏了一条」的来源 */}
          {expanded.size && !flat ? (
            <button
              type="button"
              className="af-radar-collapseall"
              title="把所有展开的分面收起来"
              onClick={() => setExpanded(new Set())}
            >收起全部</button>
          ) : null}
          追踪项目<i>{parentCount}</i>
          {/* 分面单独数。混在一起数成 12 的话，人看到的数字跟板上说的「6 条政策」对不上 */}
          {facetCount && !flat ? <em className="af-radar-axis-sub">+{facetCount} 分面</em> : null}
        </span>
        <span className="af-radar-axis-tail">剩余</span>
        <div className="af-radar-track">
          {ticks.map((tick) => (
            <i key={`tl${tick}`} className="af-radar-tick" style={{ left: `${at(tick)}%` }}>
              <b>{new Date(tick).getMonth() + 1}月</b>
            </i>
          ))}
          {trains.map((train) => (
            <i key={`vl${train.cutoff}`} className="af-radar-train" style={{ left: `${at(train.time)}%` }}>
              <b>{train.version}</b>
            </i>
          ))}
          {nowAt === null ? null : <i className="af-radar-now" style={{ left: `${nowAt}%` }}><b>今天</b></i>}
        </div>
      </div>

      {groupRows(visibleRows, group, { primaryOnly, labelOf: vocab.theme, order: vocab.themeOrder }).map((section) => (
        <Fragment key={section.key || "_all"}>
          {/* 分组抬头。不分组时 label 是空的，这一条就不画 */}
          {section.label ? (
            <div className="af-radar-group">
              <span>{section.label}</span>
              <i>{section.rows.length}</i>
            </div>
          ) : null}
          {section.rows.flatMap((row) => (
            expanded.has(String(row.id)) && !flat
              ? [row, ...(kidsOf.get(String(row.id)) || [])]
              : [row]
          )).map((row) => {
        const state = String(readCell(row, encode.color) || row.state || "idle");
        /**
         * 任务自己的起止。落在窗外的那头钳到边界并打标记——
         * 不钳的话条会长到轨道外面去，钳了不标的话「跨年的任务」看起来像正好今年做完。
         */
        const spanFrom = toTime(row.startAt);
        const spanTo = toTime(row.endAt);
        const span = Number.isFinite(spanFrom) && Number.isFinite(spanTo) && spanTo >= start && spanFrom <= end
          ? {
            from: Math.max(at(spanFrom), 0),
            to: Math.min(at(spanTo), 100),
            cutLeft: spanFrom < start,
            cutRight: spanTo > end,
          }
          : null;
        const moments = rowMoments(row, encode).filter((moment) => inWindow(moment.time));
        const badges = (encode.badges || []).map((field) => row?.[field]).filter(Boolean);
        const kids = (kidsOf.get(String(row.id)) || []).length;
        const open = expanded.has(String(row.id)) && !flat;
        return (
          <button
            type="button"
            key={row.id || row.title}
            className={[
              "af-radar-row",
              row.overdue ? "af-radar-row--overdue" : "",
              row.done ? "af-radar-row--done" : "",
              row.settled ? "af-radar-row--settled" : "",
              isFacet(row) && !flat ? "af-radar-row--facet" : "",
            ].filter(Boolean).join(" ")}
            onClick={() => onPick(row)}
          >
            <span className="af-radar-label">
              {/* 折叠三角自己接事件：整行点击是打开详情，抢掉它的话人就再也看不到条目详情了 */}
              {kids && !flat ? (
                <i
                  role="button"
                  tabIndex={0}
                  title={open ? `收起 ${kids} 个分面` : `展开 ${kids} 个分面`}
                  aria-label={open ? `收起 ${kids} 个分面` : `展开 ${kids} 个分面`}
                  className={`af-radar-caret${open ? " af-radar-caret--on" : ""}`}
                  onClick={(event) => { event.stopPropagation(); toggle(String(row.id)); }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    toggle(String(row.id));
                  }}
                  aria-expanded={open}
                >
                  <span className="material-symbols-outlined">chevron_right</span>
                </i>
              ) : null}
              {/* 状态点。跑道靠条的颜色表达状态，但过期和无期限的行不画条——
                  没有这个点，那些行的状态在跑道上完全不可见 */}
              <i className={`af-radar-dot af-radar-dot--${state}`} title={vocab.state(state)} />
              <span className="af-radar-name">{String(readCell(row, encode.lane) ?? row.title ?? "")}</span>
              {/* 有几个分面写在标题旁边，不用展开才知道。三角只说「能展开」，说不出「有几个」 */}
              {kids && !flat
                ? <i className="af-radar-kidcount">{open ? `收起 ${kids}` : `${kids} 分面`}</i>
                : null}
              {/*
                跑道上的子行只留**标题 + 谁写的**。
                结论和证据挪进详情弹框的「结论」那一段——它们一条两行、还带文件路径，
                摊在跑道上会把一行撑成一张卡片，十几条排下来一屏看不到三行。
                「等你确认」是例外：那是个待办，不看见就永远不会去点。
              */}
              <span className="af-radar-badges">
                {/* 「等你确认」是个待办，得和来源、异常角标排在一起，
                    夹在标题里会被读成标题的一部分 */}
                {isFacet(row) && heldState.get(String(row.id))
                  ? <i className="af-radar-badge--held">待你确认</i>
                  : null}
                {/* 谁替这条作答。分组之后分面和政策平铺在一起，缩进没了，
                    不写来源的话「主模块 targetSdk 是否已达 35」看着就是一条政策，
                    而它其实是 likee-compliance 对那条政策的回答 */}
                {isFacet(row) && row.flowId
                  ? <i className="af-radar-badge--src" title={`由「${row.flowId}」这条流程作答`}>{row.flowId}</i>
                  : null}
                {badges.map((badge) => <i key={String(badge)}>{String(badge)}</i>)}
                {/* 标签就地可点：这是最常用的筛选动作，绕到工具栏再选一次是白费。
                    子行不挂——它一行只说「这条是谁在答」，标签在父行和详情里都有 */}
                {(isFacet(row) && !flat ? [] : row.tags || []).map((tag) => (
                  <i
                    key={`tag-${tag}`}
                    role="button"
                    tabIndex={0}
                    className={`af-radar-badge--tag${tagFilter === tag ? " af-radar-badge--tag-on" : ""}`}
                    title={tagFilter === tag ? "取消按这个标签筛选" : `只看 ${tag}`}
                    onClick={(event) => { event.stopPropagation(); onTag(tagFilter === tag ? "" : tag); }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      onTag(tagFilter === tag ? "" : tag);
                    }}
                  >{tag}</i>
                ))}
                {/* 缺席：有流程声明替这条作答，却一条子项都没写。别的视图完全看不见它 */}
                {(row.missingFacets || []).length
                  ? <i className="af-radar-badge--absent">{row.missingFacets.join(" / ")} 缺席</i>
                  : null}
                {row.owner || kids || (isFacet(row) && !flat) ? null : <i className="af-radar-badge--none">无人认领</i>}
                {row.settled ? <i className="af-radar-badge--settled">已封存</i> : null}
                {/* 这一条多久没被写过了。分片还在跑不代表这一条还在被更新 */}
                {row.staleItem ? <i className="af-radar-badge--stale">没再更新</i> : null}
                {/* 人的标记和脚本观测不一致，得能一眼看出来 */}
                {row.overrideConflict ? <i className="af-radar-badge--override">人工标记</i> : null}
              </span>
            </span>
            <span className="af-radar-track">
              {guidesFor(row)}
              {/* 有起止就画一条区间：这一行真正「在做」的那段时间。
                  两头都可能落在窗外，所以钳到窗口边界，并标出是被裁过的 */}
              {span ? (
                <span
                  className={[
                    "af-radar-span",
                    `af-radar-span--${state}`,
                    span.cutLeft ? "af-radar-span--cut-left" : "",
                    span.cutRight ? "af-radar-span--cut-right" : "",
                  ].filter(Boolean).join(" ")}
                  style={{ left: `${span.from}%`, width: `${span.to - span.from}%` }}
                  title={`${formatDay(row.startAt)} → ${formatDay(row.endAt)}`}
                />
              ) : null}
              {/* 三种时刻各一种样式：入库是空心点、最近写入是实心小点、截止是竖标。
                  同一种样式画三件事的话，人只会看到「三个点」，读不出哪个是期限 */}
              {moments.map((moment) => (
                <i
                  key={moment.key}
                  className={`af-radar-mark af-radar-mark--${moment.key}${moment.key === "due" ? ` af-radar-mark--${state}` : ""}`}
                  style={{ left: `${at(moment.time)}%` }}
                  title={`${moment.label} ${formatDay(moment.time)}`}
                />
              ))}
            </span>
            <span className={`af-radar-value af-radar-value--${row.overdue ? "overdue" : state}`}>
              {row.overdue
                ? `已过期 ${Math.abs(row.daysLeft)} 天`
                : row.done && state === "ok" ? "已满足"
                  // 空着的话这一行右边是一片空白，看着像渲染漏了
                  : row.daysLeft === null ? "无期限"
                    : formatValue(row, encode.value)}
            </span>
          </button>
        );
          })}
        </Fragment>
      ))}
      </div>
    </div>
  );
}

/** 简报里一条变化怎么念。`state` 是状态变了，`current` 是结论变了，其余是进出板 */
const EVENT_VERB = {
  state: "状态", current: "结论", moved: "改期", dropped: "不再产出", added: "新增", approved: "已批准",
};

/**
 * 状态页：这块板的主形态。
 *
 * 跑道把时间当主轴，但这块板 15 行里只有 3 条有截止日——甘特要的数据它没有。
 * 人每天来这儿问的是三件事，所以三件事各用一种控件，谁都不许兼职：
 *
 *   事件（变了什么）  顶上的简报 ＋ 每行右边的状态条
 *   进度（还差多少）  覆盖度是分数角标，任务是小横条 —— 两种进度不能长一样
 *   状态（满足没有）  圆点 ＋ 一个词，四个取值到头
 */
/**
 * 右列的期限。
 *
 * 过了期限但已经满足的，`daysLeft` 是负数而 `overdue` 是 false——直接打印就成了
 * 「-16 天」，读起来像还剩负十六天。那一刻期限只是历史，说「期限已过」就够了。
 */
/**
 * 右列说的是**时间**，所以颜色只解释时间。
 *
 * 原来 class 一律取 `state`，文字却分两套：有子行给期限、没子行给状态词。
 * 于是「无期限」被刷成红的——字面说「没有期限」，颜色说「要命了」，
 * 一个格子里塞了两句互相打架的话。同一屏还有另一个「无期限」是绿的。
 *
 * 现在：过期才红、两周内黄、其余中性。「这条什么状态」交给标题前面那颗点，
 * 一行一个颜色、一个含义。
 */
function valTone(row, hasKids) {
  if (!hasKids) return "";
  if (row.overdue) return "past";
  const left = row.daysLeft;
  if (left === null || left === undefined || left < 0) return "";
  return left <= 14 ? "soon" : "";
}

function dueWord(row) {
  if (row.overdue) return `已过期 ${Math.abs(row.daysLeft)} 天`;
  if (row.daysLeft === null || row.daysLeft === undefined) return "无期限";
  return row.daysLeft < 0 ? "期限已过" : `${row.daysLeft} 天`;
}

function StatusView({ board, events, group, onPick, onTag, tagFilter = "" }) {
  const vocab = useVocab();
  const history = board.history || {};

  const kidsOf = new Map();
  for (const row of board.rows) {
    const parent = String(row?.parent || "").trim();
    if (!parent) continue;
    const list = kidsOf.get(parent) || [];
    list.push(row);
    kidsOf.set(parent, list);
  }
  // 有几条流程在答子层。只有一条时「谁答的」不是个问题，那个角标纯属噪音
  const answerers = new Set(board.rows.filter((row) => row.parent).map((row) => row.flowId).filter(Boolean));

  /**
   * 默认摊开。
   *
   * 这个形态的主体就是层级——政策下面各端什么结论、各端下面还剩几件事。
   * 全收起来只剩六行标题，和一张目录没区别，而目录正是跑道已经给过的东西。
   */
  const [collapsed, setCollapsed] = useState(() => new Set());
  const toggle = (id) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /**
   * 简报只说**最近一次有变化的那天**，不是「最近 N 条」。
   * 大多数天这块板什么都没动，而「今天没动」本身就是要传达的信息——
   * 滚动一串跨越三周的变化，人根本读不出今天到底安不安全。
   */
  const real = (events || []).filter((event) => event.kind !== "board_created");
  const latestDay = real.length ? String(real[0].at || "").slice(0, 10) : "";
  const todays = real.filter((event) => String(event.at || "").slice(0, 10) === latestDay);
  /**
   * 「变了几条」数的是**条目**，不是事件。
   *
   * 一条条目一天里状态变一次、结论改一次、再过一次门禁，就是三条事件——
   * 照事件数报出来是「今天变了 45 条」，而板上一共才 15 条，人当场就不信这个数了。
   * 新增也单独说：建板当天 27 条 added 不是「变化」，是这块板长出来。
   */
  const CHANGED = new Set(["state", "current", "moved", "approved"]);
  const onBoard = new Set(board.rows.map((row) => String(row.id)));
  /**
   * 简报只说**板上现在还有的**条目。
   *
   * 改过 id 的那一轮会在变更流里留下一批「旧 id 变了 / 旧 id 不再产出」——
   * 它们是搬家留下的痕迹，不是今天发生的事。照单全收的话，
   * 板上一共 15 条，简报会说「变了 12 条、其余 15 条没动」，两个数加起来自己打架。
   */
  const changedIds = new Set(todays
    .filter((event) => CHANGED.has(event.kind) && onBoard.has(String(event.id)))
    .map((event) => String(event.id)));
  const addedIds = new Set(todays
    .filter((event) => event.kind === "added" && onBoard.has(String(event.id)))
    .map((event) => String(event.id)));
  // 离开是例外：它按定义就不在板上了，但「一条被拿掉了」是真消息
  const goneIds = new Set(todays
    .filter((event) => event.kind === "dropped" && !onBoard.has(String(event.id)))
    .map((event) => String(event.id)));
  const stillHere = changedIds.size + addedIds.size;
  // 一条条目只念一次，念它今天最要紧的那条事件：状态变了 > 不再产出 > 结论变了
  const WEIGHT = { state: 0, approved: 1, current: 2, moved: 3, dropped: 4, added: 5 };
  const pick = new Map();
  for (const event of todays) {
    const id = String(event.id);
    const mine = (CHANGED.has(event.kind) && changedIds.has(id))
      || (event.kind === "dropped" && goneIds.has(id))
      || (event.kind === "added" && addedIds.has(id) && !changedIds.size);
    if (!mine) continue;
    const best = pick.get(id);
    if (!best || (WEIGHT[event.kind] ?? 9) < (WEIGHT[best.kind] ?? 9)) pick.set(id, event);
  }
  const headline = changedIds.size + goneIds.size + (changedIds.size ? 0 : addedIds.size);
  const shown = [...pick.values()].slice(0, 4);
  const rest = headline - shown.length;

  /**
   * 分组在状态页是**给顶层分块**，不是把树拍平。
   *
   * 跑道那边 `flat = Boolean(group)` 是对的：那儿按标签分组，而标签只长在子行上，
   * 不拍平就什么都分不出来。状态页反过来——大组长在**政策**上，子行一个都没有。
   * 照抄那套的结果是：六条政策进了三个大组，十一条结论和任务掉进「未填」，
   * 层级当场消失，Likee 的结论不在它答的那条政策底下。
   */
  const roots = board.rows.filter((row) => !isFacet(row));

  const strip = (row) => {
    const cells = history[String(row.id)] || [];
    // 少于三格说不出任何趋势，画出来只会被当成渲染残渣。板刚建起来时就是这样
    if (cells.length < 3) return <span className="af-radar-strip af-radar-strip--empty" />;
    const changed = cells.filter((cell, index) => index > 0 && cell && cell !== cells[index - 1]).length;
    return (
      <span
        className="af-radar-strip"
        title={`最近 ${cells.length} 天${changed ? `，变过 ${changed} 次` : "没变过"}`}
      >
        {cells.map((cell, index) => (
          <i key={index} className={`af-radar-scell af-radar-scell--${cell || "void"}`} />
        ))}
      </span>
    );
  };

  /** 覆盖度：几个端该答、几个答了、几个说满足。政策行不给结论，给这个 */
  const coverChip = (row) => {
    const cov = row.coverage;
    if (!cov || !cov.expected) return null;
    const missing = cov.expected - cov.answered;
    const tone = missing ? "gap" : cov.ok === cov.expected ? "ok" : "part";
    return (
      <i className={`af-radar-cover af-radar-cover--${tone}`}>
        {cov.ok}/{cov.expected} 端满足{missing ? ` · ${missing} 端没查` : ""}
      </i>
    );
  };

  const renderRow = (row, depth) => {
    const kids = kidsOf.get(String(row.id)) || [];
    const open = !collapsed.has(String(row.id));
    const state = String(row.state || "idle");
    const done = kids.filter((kid) => String(kid.state) === "ok").length;
    const tone = valTone(row, kids.length > 0);
    const out = [
      <button
        type="button"
        key={row.id}
        className={[
          "af-radar-srow",
          `af-radar-srow--d${Math.min(depth, 2)}`,
          row.overdue ? "af-radar-srow--overdue" : "",
          row.settled ? "af-radar-srow--settled" : "",
          // 「满足的退后、没完的向前」现在整块表达（.af-radar-block--ok 和块左边的重音条），
          // 行一级不再各自压透明度——压在行上，同一条政策的几行会亮一行暗一行
        ].filter(Boolean).join(" ")}
        onClick={() => onPick(row)}
      >
        <span className="af-radar-slabel">
          {kids.length ? (
            <i
              role="button"
              tabIndex={0}
              className={`af-radar-caret${open ? " af-radar-caret--on" : ""}`}
              title={open ? "收起" : `展开 ${kids.length} 条`}
              aria-label={open ? "收起" : `展开 ${kids.length} 条`}
              aria-expanded={open}
              onClick={(event) => { event.stopPropagation(); toggle(String(row.id)); }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                toggle(String(row.id));
              }}
            ><span className="material-symbols-outlined">chevron_right</span></i>
          ) : <i className="af-radar-caret af-radar-caret--ghost" />}
          <i className={`af-radar-dot af-radar-dot--${state}`} title={vocab.state(state)} />
          <span className="af-radar-sname">{String(row.title || row.id || "")}</span>
          {coverChip(row)}
          {/* 任务进度和覆盖度长得不一样：一个是分数角标，一个是小横条。
              都叫「进度」但问的不是一回事，用同一种控件会串 */}
          {depth > 0 && kids.length ? (
            <>
              <i className="af-radar-sbar"><i style={{ width: `${Math.round(done / kids.length * 100)}%` }} /></i>
              <i className="af-radar-mini">{done}/{kids.length} 做完</i>
            </>
          ) : null}
          {depth > 0 && row.flowId ? <i className="af-radar-badge--src">{row.flowId}</i> : null}
          {(row.missingFacets || []).length
            ? <i className="af-radar-badge--absent">{row.missingFacets.join(" / ")} 没答</i>
            : null}
          {row.staleItem ? <i className="af-radar-badge--stale">没再更新</i> : null}
          {row.overrideConflict ? <i className="af-radar-badge--override">人工标记</i> : null}
          {row.settled ? <i className="af-radar-badge--settled">已封存</i> : null}
          {(row.tags || []).map((tag) => (
            <i
              key={`t-${tag}`}
              role="button"
              tabIndex={0}
              className={`af-radar-badge--tag${tagFilter === tag ? " af-radar-badge--tag-on" : ""}`}
              onClick={(event) => { event.stopPropagation(); onTag(tagFilter === tag ? "" : tag); }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                onTag(tagFilter === tag ? "" : tag);
              }}
            >{tag}</i>
          ))}
        </span>
        {strip(row)}
        <span className={`af-radar-sval${tone ? ` af-radar-sval--${tone}` : ""}`}>
          {/* 有子行的是「要求」，不是一件做完的事——右列给期限，满足没满足看覆盖度角标 */}
          {kids.length ? dueWord(row) : vocab.state(state)}
        </span>
        {row.current && depth > 0 ? <span className="af-radar-swhy">{row.current}</span> : null}
      </button>,
    ];
    if (open) for (const kid of kids) out.push(...renderRow(kid, depth + 1));
    return out;
  };

  return (
    <div className="af-radar-status">
      {/* 大多数天这块板什么都没动。简报把「没动」说出来，比让人自己扫一遍便宜得多 */}
      {/*
        没有真变化时，简报缩成一行。
        把建板那天的十七条「新增」逐条念一遍，是拿最值钱的位置讲一件人已经知道的事；
        而「今天没动」本身就是要传达的信息——它值一行，不值一屏。
      */}
      <div className={`af-radar-digest${changedIds.size ? "" : " af-radar-digest--quiet"}`}>
        <div className="af-radar-digest-hd">
          <b>
            {changedIds.size
              ? `${latestDay} 变了 ${changedIds.size} 条`
              : `盯着 ${board.rows.length} 条，今天没有变化`}
          </b>
          {changedIds.size ? <em>其余 {Math.max(0, board.rows.length - stillHere)} 条没动</em> : null}
          {changedIds.size && addedIds.size ? <em>另新增 {addedIds.size} 条</em> : null}
          {!changedIds.size && addedIds.size ? <em>{latestDay} 新增 {addedIds.size} 条</em> : null}
          {goneIds.size ? <em>{goneIds.size} 条离开了板</em> : null}
        </div>
        {(changedIds.size ? shown : []).map((event, index) => (
          <div key={`${event.at}-${event.id}-${index}`} className="af-radar-devent">
            <span className={`af-radar-dfrom af-radar-dfrom--${event.to || ""}`}>
              {event.kind === "state"
                ? `${vocab.state(event.from)} → ${vocab.state(event.to)}`
                : EVENT_VERB[event.kind] || event.kind}
            </span>
            <span className="af-radar-dtitle">{String(event.title || event.id || "")}</span>
            {event.kind === "current" && event.to ? <span className="af-radar-dwhy">{event.to}</span> : null}
            {event.why ? <span className="af-radar-dwhy">{event.why}</span> : null}
          </div>
        ))}
        {changedIds.size && rest > 0
          ? <p className="af-radar-dquiet">另有 {rest} 条收在变更流里。</p>
          : null}
      </div>

      {groupRows(roots, group, { labelOf: vocab.theme, order: vocab.themeOrder }).map((section) => (
        <Fragment key={section.key || "_all"}>
          {section.label ? (
            <div className="af-radar-sgroup"><span>{section.label}</span><i>{section.rows.length}</i></div>
          ) : null}
          {/*
            一条政策连同它下面所有的端和任务，是**一块**，不是一串行。
            之前它们全平铺在一张大卡片上，只靠一道 1px 的 inset 高光分界——
            于是十七行连成一片，看不出「这几行是一件事」。
            分区交给面和间距（这套设计里不画分隔线），一块一张卡。
          */}
          {section.rows.map((row) => (
            <div
              key={row.id}
              className={`af-radar-block af-radar-block--${String(row.state || "idle")}`}
            >
              {renderRow(row, 0)}
            </div>
          ))}
        </Fragment>
      ))}
      {roots.length ? null : <p className="af-radar-none">这个视角下没有条目。</p>}
    </div>
  );
}

/**
 * 已归档的条目，单独一页。
 *
 * 不用跑道画：归档掉的东西没有「还剩几天」可言，时间轴上摆一排已经翻篇的条只是噪音。
 * 这一页要回答的是另外三个问题——哪些被拿走了、是谁拿的、怎么放回来。
 */
function ArchivedView({ board, busy, onRestore, onPick }) {
  const vocab = useVocab();
  if (busy && !board) return <LoadingState variant="compact" label="读归档" />;
  const rows = board?.rows || [];
  if (!rows.length) {
    return <p className="af-radar-none">还没有归档过条目。归档是把一条从板上拿走，但不删——随时能放回来。</p>;
  }
  return (
    <div className="af-radar-archive">
      {rows.map((row) => (
        <div key={row.id} className="af-radar-archive-row">
          <button type="button" className="af-radar-archive-main" onClick={() => onPick(row)}>
            <span className="af-radar-archive-title">{String(row.title || row.id || "")}</span>
            <span className="af-radar-badges">
              {row.flowId ? <i className="af-radar-badge--src">{row.flowId}</i> : null}
              <i>{vocab.state(row.state)}</i>
              {/* 被父行带走的和自己被归档的不是一回事：前者要去改父行才放得回来 */}
              {row.archivedBy ? <i className="af-radar-badge--absent">随「{row.archivedBy}」一起</i> : null}
              {row.override?.at ? <i>{formatDay(row.override.at)}</i> : null}
              {row.override?.by ? <i>{row.override.by}</i> : null}
            </span>
          </button>
          {row.archivedBy ? null : (
            <button
              type="button"
              className="af-radar-ghost af-radar-ghost--tiny"
              onClick={() => onRestore(row)}
            >放回板上</button>
          )}
        </div>
      ))}
    </div>
  );
}

/** 分面行：挂在别的条目下面的那些。不分组时在父行下折叠，一旦分组就和父行平铺在一起 */
function isFacet(row) {
  return Boolean(String(row?.parent || "").trim());
}

function TableView({ board, encode, onPick }) {
  const columns = [
    channelField(encode.lane) || "title",
    channelField(encode.color) || "state",
    channelField(encode.end) || "effectiveDue",
    channelField(encode.value) || "daysLeft",
    ...(encode.badges || []),
  ].filter((column, index, all) => column && all.indexOf(column) === index);
  return (
    <div className="af-radar-table-wrap">
      <table className="af-radar-table">
        <thead>
          <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
        </thead>
        <tbody>
          {board.rows.map((row) => (
            <tr key={row.id || row.title} onClick={() => onPick(row)}>
              {columns.map((column) => {
                const value = row?.[column];
                const text = column.toLowerCase().includes("due") ? formatDay(value) : String(value ?? "-");
                return <td key={column} className={column === "state" ? `af-radar-cell--${row.state}` : ""}>{text}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 多久没写了，说人话。「3 天前」比一个时间戳更容易看出它是不是哑了 */
function sinceText(iso) {
  const at = typeof iso === "number" ? iso : toTime(iso);
  if (!Number.isFinite(at) || !at) return "从没跑过";
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

const RUN_TONE = {
  success: "ok",
  succeeded: "ok",
  failed: "bad",
  error: "bad",
  waiting: "wait",
  running: "wait",
  canceled: "idle",
  stopped: "idle",
};

/** 过去 N 天的日刻度。跑道看未来，这一屏看过去，所以轴是反着走的 */
function dayTicks(start, end) {
  const ticks = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= end && ticks.length < 40) {
    if (cursor.getTime() >= start) ticks.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }
  return ticks;
}

/**
 * 协作视图：一条流程一行，横轴是它最近的执行。
 *
 * 和跑道同一套读法——左边是主体，中间是时间，右边是结论。区别只在轴的方向：
 * 跑道看的是「还剩多少时间」，这一屏看的是「过去这段时间它干了什么」。
 *
 * 为什么要单独一屏：条目安静既可能是真没变化，也可能是流程哑了三天没人发现。
 * 板上那几个视图分不开这两件事，只有把执行摊在时间轴上才分得开。
 */
/**
 * 待审批。
 *
 * 摆在板顶上而不是塞进抽屉：这几条改动**正在被压着不写**，板上相应字段显示的是旧值。
 * 藏起来的话，人看到的是一块"正常"的板，而真相在一个没人点开的角落里等着。
 */
/** 待审批里出现的都是原始值，得先翻成人话再摆到人面前 */
const PENDING_FIELD = { state: "状态", due: "截止日", current: "现状", settled: "封存", dropped: "追踪" };
// 门禁面板里 unknown 要单独说：「还没查出来」和「无状态」在审批语境下不是一回事
const PENDING_STATE = { ...STATE_FALLBACK, unknown: "还没查出来" };

function pendingValueText(kind, value) {
  const text = String(value ?? "").trim();
  if (kind === "state") return PENDING_STATE[text] || text || "空";
  if (kind === "settled") return value === true ? "已封存" : "未封存";
  if (kind === "due") return text ? text.slice(0, 10) : "没有截止日";
  return text || "空";
}

function PendingPanel({ board, pending, onResolve, busy }) {
  const entries = Object.entries(pending || {});
  if (!entries.length) return null;
  const total = entries.reduce((sum, [, entry]) => sum + (entry.held?.length || 0), 0);
  const rowById = new Map((board?.rows || []).map((row) => [String(row.id), row]));
  return (
    <section className="af-radar-pending">
      <header>
        <span className="material-symbols-outlined">gavel</span>
        <div>
          <h4>{total} 处改动等确认</h4>
          <p>这几处会让条目不再告警，所以先拦下来。板上现在显示的还是旧值；同一条目上其它改动已经落地。</p>
        </div>
      </header>
      {entries.map(([flowId, entry]) => (
        <div key={flowId} className="af-radar-pending-flow">
          <span className="af-radar-pending-from">来自 {flowId}</span>
          {(entry.held || []).map((item) => {
            const row = rowById.get(String(item.id));
            const title = row?.title || item.title || item.id;
            // 依据是**判断的全部材料**：agent 说「已满足」，凭的就是这两行。
            // 早先这里只有 id 和 unknown→ok，人看不出该批还是该驳，只能闭眼点批准
            const evidence = String(row?.evidence || "").trim();
            const current = String(row?.current || "").trim();
            return (
            <div key={`${item.id}:${item.kind}`} className="af-radar-pending-row">
              <span className="af-radar-pending-what">
                <b>{row?.app ? `${row.app} · ${title}` : title}</b>
                <span className="af-radar-pending-change">
                  {PENDING_FIELD[item.kind] || item.kind}
                  {item.kind === "dropped"
                    ? "：这条将不再被更新"
                    : <> <em>{pendingValueText(item.kind, item.from)}</em> → <em>{pendingValueText(item.kind, item.to)}</em></>}
                </span>
                {current ? <span className="af-radar-pending-evidence">{current}</span> : null}
                {evidence ? <code className="af-radar-pending-src">{evidence}</code> : null}
                <span className="af-radar-pending-id">{item.id}</span>
              </span>
              {/* 「为什么拦它」要和改动摆在一起。只说「有待确认」，人只会点通过 */}
              <span className="af-radar-pending-why">
                {item.reason}
                <i>批准＝接受这个结论并写进板；驳回＝保留旧值，并记一条事件说你不认。</i>
              </span>
              <span className="af-radar-pending-act">
                <button
                  type="button"
                  className="af-radar-ghost"
                  disabled={busy}
                  onClick={() => onResolve("reject", flowId, item.id)}
                >
                  驳回
                </button>
                <button
                  type="button"
                  className="af-radar-primary"
                  disabled={busy}
                  onClick={() => onResolve("approve", flowId, item.id)}
                >
                  批准
                </button>
              </span>
            </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}

function AgentsView({ board, lanes, days, onPick, navigate, returnTo }) {
  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;
  const at = (time) => ((time - start) / (now - start)) * 100;
  const ticks = dayTicks(start, now);
  const conflicts = new Map((board.conflicts || []).map((item) => [item.id, item.flows]));
  const rowById = new Map(board.rows.map((row) => [String(row.id || row.title || ""), row]));
  const claimed = new Set(lanes.flatMap((lane) => lane.owns || []));
  const orphans = board.rows.filter((row) => !claimed.has(String(row.id || row.title || "")));

  const guides = (
    <>
      {ticks.map((tick) => <i key={`g${tick}`} className="af-radar-tick" style={{ left: `${at(tick)}%` }} />)}
      <i className="af-radar-now" style={{ left: "100%" }} />
    </>
  );

  return (
    <div className="af-radar-runway af-radar-agents">
      <div className="af-radar-axis">
        <span className="af-radar-axis-head">编排流程<i>{lanes.length}</i></span>
        <span className="af-radar-axis-tail">上次</span>
        <div className="af-radar-track">
          {ticks.map((tick) => (
            <i key={`tl${tick}`} className="af-radar-tick" style={{ left: `${at(tick)}%` }}>
              <b>{new Date(tick).getMonth() + 1}/{new Date(tick).getDate()}</b>
            </i>
          ))}
          <i className="af-radar-now" style={{ left: "100%" }}><b>此刻</b></i>
        </div>
      </div>

      {lanes.map((lane) => {
        const canvas = flowCanvasUrl({ flowId: lane.flowId, ...(lane.flow || {}) }, returnTo);
        const last = lane.runs.length ? lane.runs[lane.runs.length - 1] : null;
        const failed = lane.runs.filter((run) => RUN_TONE[run.status] === "bad").length;
        return (
          <div key={lane.flowId} className={`af-radar-row af-radar-agent-row${lane.stale ? " af-radar-row--overdue" : ""}`}>
            <span className="af-radar-label">
              <span className="af-radar-name">{lane.flowId}</span>
              <span className="af-radar-badges">
                <i>{lane.rows} 条</i>
                {lane.stale ? <i className="af-radar-badge--stale">哑了</i> : null}
                {failed ? <i className="af-radar-badge--fail">{failed} 次失败</i> : null}
                {lane.fetchFailures ? <i className="af-radar-badge--stale">{lane.fetchFailures} 条抓取失败</i> : null}
              </span>
            </span>

            <span className="af-radar-track">
              {guides}
              {/* 每次运行一个点。位置是它开跑的时刻，颜色是结果——
                  连成一串就能看出节奏，断掉的那段就是它没在干活 */}
              {lane.runs.map((run) => (
                <i
                  key={run.runId}
                  className={`af-radar-run af-radar-run--${RUN_TONE[run.status] || "idle"}${run.scheduled ? "" : " af-radar-run--manual"}`}
                  style={{ left: `${at(run.at)}%` }}
                  title={`${new Date(run.at).toLocaleString()} · ${run.status}${run.scheduled ? " · 定时" : " · 手动"}${run.error ? ` · ${run.error}` : ""}`}
                />
              ))}
              {lane.runs.length ? null : <span className="af-radar-run-empty">这段时间没有运行记录</span>}
            </span>

            <span className={`af-radar-value af-radar-value--${lane.stale ? "overdue" : "ok"}`}>
              {sinceText(last?.at)}
            </span>

            {canvas ? (
              <button
                type="button"
                className="af-radar-agent-canvas"
                title="打开这条流程的画布"
                onClick={() => navigate(canvas)}
              >
                <span className="material-symbols-outlined">account_tree</span>
              </button>
            ) : null}
          </div>
        );
      })}

      {lanes.map((lane) => (
        (lane.owns || []).some((id) => conflicts.has(id)) ? (
          <p key={`c${lane.flowId}`} className="af-radar-agent-note af-radar-bad">
            {lane.flowId} 和别的流程抢这些条目：
            {(lane.owns || []).filter((id) => conflicts.has(id)).join("、")}
          </p>
        ) : null
      ))}

      {orphans.length ? (
        <p className="af-radar-agent-note">
          {/* 没有流程写它们，它们会永远停在写进去的那一刻，而板上看不出来 */}
          <b>{orphans.length} 条没有流程在写</b>：
          {orphans.map((row) => (
            <button type="button" key={row.id || row.title} className="af-radar-link" onClick={() => onPick(row)}>
              {row.title || row.id}
            </button>
          ))}
          —— 它们不会再更新
        </p>
      ) : null}

      {lanes.length ? null : <p className="af-radar-none">还没有流程写过这块板。到「编排」里配一条定时任务。</p>}
    </div>
  );
}

function BoardView({ board, encode, onPick }) {
  const vocab = useVocab();
  return (
    <div className="af-radar-kanban">
      {["risk", "warn", "idle", "ok"].map((state) => {
        const rows = board.rows.filter((row) => String(readCell(row, encode.color) || row.state) === state);
        return (
          <div key={state} className="af-radar-column">
            <h4 className={`af-radar-col-head af-radar-col-head--${state}`}>
              {vocab.state(state)}<span>{rows.length}</span>
            </h4>
            {rows.map((row) => (
              <button type="button" key={row.id || row.title} className="af-radar-card" onClick={() => onPick(row)}>
                <span className="af-radar-name">{String(readCell(row, encode.lane) ?? row.title ?? "")}</span>
                <span className="af-radar-card-meta">
                  {row.owner || "无人认领"} · {formatValue(row, encode.value) || formatDay(row.effectiveDue)}
                </span>
              </button>
            ))}
            {rows.length ? null : <p className="af-radar-col-empty">空</p>}
          </div>
        );
      })}
    </div>
  );
}

const URL_SPLIT = /(https?:\/\/[^\s"'<>）)，,；;]+)/g;
const IS_URL = /^https?:\/\//;

/**
 * 字段值怎么显示。
 *
 * 原来一律 `String(value)`，于是 `source` 是一串不能点的网址、`tasks` 是一行
 * `["…","…"]` 的 JSON——两样都是「能看见但用不了」。
 */
function RowValue({ value }) {
  if (Array.isArray(value)) {
    if (!value.length) return <span className="af-radar-note">空</span>;
    return (
      <ul className="af-radar-vlist">
        {value.map((item, index) => <li key={index}><RowValue value={item} /></li>)}
      </ul>
    );
  }
  if (value && typeof value === "object") return <code>{JSON.stringify(value)}</code>;
  const text = String(value);
  if (!IS_URL.test(text) && !text.includes("http")) return <>{text}</>;
  // 网址混在句子里也要能点，所以是切分不是整段判断。
  // split 带捕获组会把分隔符本身留在数组里，奇数位就是那些网址
  return (
    <>
      {text.split(URL_SPLIT).map((part, index) => (
        IS_URL.test(part)
          ? <a key={index} href={part} target="_blank" rel="noreferrer noopener" className="af-radar-link">{part}</a>
          : <Fragment key={index}>{part}</Fragment>
      ))}
    </>
  );
}

/**
 * 一格可改的日期。
 *
 * 值可能有两个来源：流程写的，和人改的。人改过之后要能看见原值、也要能撤销——
 * 只显示最终值的话，「这个日期是谁定的」永远说不清，而这正是后面吵架的地方。
 */
function DateEdit({ value, field, row, saving, onSave }) {
  const busy = saving === field;
  const mine = String(row?.override?.[field] || "").trim();
  const was = String(row?.override?.was?.[field] || "").trim();
  return (
    <span className="af-radar-dateedit">
      <input
        type="date"
        value={value ? formatDay(value) : ""}
        disabled={Boolean(saving)}
        onChange={(event) => onSave({ [field]: event.target.value }, field, { keepOpen: true })}
      />
      {busy ? <span className="af-radar-note">…</span> : null}
      {mine ? (
        <>
          {was ? <span className="af-radar-note">流程写的是 {formatDay(was)}</span> : null}
          <button
            type="button"
            className="af-radar-ghost af-radar-ghost--tiny"
            disabled={Boolean(saving)}
            onClick={() => onSave({ [field]: "" }, field, { keepOpen: true })}
          >撤销</button>
        </>
      ) : null}
    </span>
  );
}

const SET_STATE_OPTIONS = [
  { state: "ok", label: "已完成" },
  { state: "warn", label: "进行中" },
  { state: "risk", label: "未开始" },
  // 「我看过了，但这条谈不上进度」——没有它，人只能在三个都不对的选项里挑一个最不错的
  { state: "idle", label: "无状态" },
];

/** 把人说的那句话钉到这一条上。不带 id 的话 AI 只能猜是哪条，改错的概率相当高 */
function itemAsk(row, ask) {
  return `针对条目「${String(row?.title || row?.id || "")}」（id: ${String(row?.id || "")}）：${String(ask).trim()}`;
}

/**
 * 指派负责人。
 *
 * 平台上真实存在的账号 + 这块板上已经出现过的名字，搜一下选一个。
 * 早先是个自由输入框：既没告诉人可以填谁，又能把「张三」「zhangsan」「zs」
 * 写成三个不同的负责人，认领这件事当场失去意义。
 */
function OwnerPicker({ row, extra = [], saving, onSave }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState(null);
  const owner = String(row?.owner || "").trim();

  useEffect(() => {
    if (!open || people) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/radar/people");
        const body = await res.json().catch(() => ({}));
        if (!cancelled) setPeople(Array.isArray(body.people) ? body.people : []);
      } catch {
        // 拿不到名册也还能派：板上出现过的名字仍然可选
        if (!cancelled) setPeople([]);
      }
    })();
    return () => { cancelled = true; };
  }, [open, people]);

  const all = [...new Set([...(people || []), ...extra])].sort();
  const needle = query.trim().toLowerCase();
  const hits = all.filter((name) => !needle || name.toLowerCase().includes(needle)).slice(0, 8);

  const assign = (name) => {
    setOpen(false);
    setQuery("");
    if (String(name) === owner) return;
    void onSave({ owner: String(name) }, "owner", { keepOpen: true });
  };

  return (
    <div className="af-radar-ownerpick">
      <span className="af-radar-ownerpick-now">
        {owner || <span className="af-radar-bad">无人认领</span>}
      </span>
      <button
        type="button"
        className="af-radar-ghost af-radar-ghost--tiny"
        disabled={Boolean(saving)}
        onClick={() => setOpen((on) => !on)}
      >
        {saving === "owner" ? "…" : owner ? "改派" : "指派"}
      </button>
      {owner ? null : (
        <button
          type="button"
          className="af-radar-ghost af-radar-ghost--tiny"
          disabled={Boolean(saving)}
          title="指给我自己"
          onClick={() => { setOpen(false); void onSave({ claim: true }, "owner", { keepOpen: true }); }}
        >我来</button>
      )}
      {open ? (
        <div className="af-radar-ownerpop">
          <input
            type="text"
            autoFocus
            value={query}
            placeholder="搜人…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.stopPropagation(); setOpen(false); return; }
              if (event.key !== "Enter" || !hits.length) return;
              event.preventDefault();
              assign(hits[0]);
            }}
          />
          <div className="af-radar-ownerlist">
            {people === null ? <p className="af-radar-note">读名册…</p> : null}
            {people !== null && !hits.length ? <p className="af-radar-note">没有匹配的人</p> : null}
            {hits.map((name) => (
              <button
                type="button"
                key={name}
                className={name === owner ? "af-radar-ownerhit af-radar-ownerhit--on" : "af-radar-ownerhit"}
                onClick={() => assign(name)}
              >{name}</button>
            ))}
          </div>
          <div className="af-radar-ownerfoot">
            <button type="button" onClick={() => { setOpen(false); void onSave({ claim: true }, "owner", { keepOpen: true }); }}>我来</button>
            {owner ? <button type="button" onClick={() => { setOpen(false); void onSave({ owner: "" }, "owner", { keepOpen: true }); }}>取消认领</button> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const ITEM_ASK_EXAMPLES = ["把这条拆细一点", "这条不用再盯了", "换一条流程来答这条", "这条每天都查一次"];

/**
 * 条目详情。两种外壳，同一套内容。
 *
 * `modal`     —— 板上点开的那个弹框，关掉回到板
 * `standalone` —— 一条一页，自己有地址，能直接发给别人
 *
 * 分成两个组件的话，同一份「时间／标签／改状态／让 AI 改这一条」要维护两遍，
 * 而它们迟早会分叉——一边加了字段另一边没加，看的人以为是数据问题。
 */
function RowDrawer({ row, board, onClose, onChanged, onAskAi, standalone = false, onOpenPage }) {
  const vocab = useVocab();
  const [saving, setSaving] = useState("");
  const [saveError, setSaveError] = useState("");
  const [draftTag, setDraftTag] = useState("");
  /**
   * 一条分面的详情是要**审的**：结论、依据文件行号、原始字段十几条。
   * 460px 的侧抽屉里这些东西一行折三折，读不下来。所以改成居中弹框，
   * 还能撑满整屏——证据那一栏是 `路径:行号`，宽一点才看得出是哪个文件。
   */
  const [editTitle, setEditTitle] = useState(null);
  const [aiAsk, setAiAsk] = useState("");
  const boxRef = useRef(null);

  useEffect(() => {
    boxRef.current?.focus();
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * 所有人工编辑都走这一个入口，落到**覆盖层**，碰不到流程分片。
   *
   * 改状态之后关抽屉（那是一次决定，做完就走）；贴标签、认领不关——
   * 人通常要连着贴好几个，每贴一个就把抽屉关掉是在跟他作对。
   */
  const patchItem = async (patch, tag, { keepOpen = false } = {}) => {
    setSaving(tag);
    setSaveError("");
    try {
      const res = await fetch("/api/radar/item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ board: board.board, itemId: row.id || row.title, ...patch }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || "保存失败");
      await onChanged();
      if (keepOpen) setSaving("");
      else onClose();
    } catch (e) {
      setSaveError(String(e.message || e));
      setSaving("");
    }
  };
  const setState = (patch, tag) => patchItem(patch, tag);

  // 候选负责人取自板上已经出现过的人。这里没有通讯录，猜一个用户列表出来只会误导
  const knownOwners = [...new Set((board.rows || []).map((item) => String(item.owner || "").trim()).filter(Boolean))].sort();
  // 候选标签取自整块板已经用过的，避免同一个概念被写成三种拼法
  const knownTags = [...new Set((board.rows || []).flatMap((item) => item.tags || []))]
    .filter((tag) => !(row.tags || []).includes(tag))
    .sort();
  const rowTags = row.tags || [];
  const addTag = (tag) => {
    const value = String(tag || "").trim();
    if (!value || rowTags.includes(value)) return;
    setDraftTag("");
    void patchItem({ addTags: [value] }, `tag:${value}`, { keepOpen: true });
  };

  // 这一条归档会连带走几条。数字来自板上当前挂在它下面的分面
  const facetCount = (board.rows || []).filter((item) => String(item.parent || "") === String(row.id || "")).length;
  const sections = board.spec?.detail?.sections || [];
  const shown = new Set([
    "title", "state", "due", "effectiveDue", "effectiveTrain", "daysLeft", "owner", "flowId", "tags",
    // 都提到「时间」那一栏去了，再在原始字段里重复一遍只是噪音
    "startAt", "endAt", "firstSeenAt", "lastSeenAt", "observedState", "override",
  ]);
  // 板自己排过的字段不抢：只有没人管的 current / evidence 才提到「结论」里
  const specFields = new Set(sections.flatMap((section) => section.fields || []));
  // 字段叫什么由板说了算：线上问题板的 current 该念「现场」，不是「现状」
  const verdictFields = ["current", "evidence", "required"]
    .filter((field) => !specFields.has(field) && row?.[field] !== undefined && row?.[field] !== "")
    .map((field) => [field, vocab.field(field)]);
  verdictFields.forEach(([field]) => shown.add(field));
  const Shell = ({ children }) => (standalone ? (
    <div className="af-radar-itempage">{children}</div>
  ) : (
    <>
      <div className="af-radar-scrim" onClick={onClose} />
      <aside
        ref={boxRef}
        tabIndex={-1}
        className="af-radar-modal"
        role="dialog"
        aria-modal="true"
        aria-label={String(row.title || "")}
      >
        {children}
      </aside>
    </>
  ));

  return (
    <Shell>
        {/* 标题吸顶：翻到最底下那堆原始字段时，还得知道在看哪一条 */}
        <header className="af-radar-modal-head">
          <div className="af-radar-modal-title">
            {editTitle === null ? (
              <>
                <h3>{String(row.title || row.id || "")}</h3>
                <button
                  type="button"
                  className="af-radar-editbtn"
                  title="改标题"
                  aria-label="改标题"
                  onClick={() => setEditTitle(String(row.title || ""))}
                ><span className="material-symbols-outlined">edit</span></button>
              </>
            ) : (
              <input
                className="af-radar-titleedit"
                autoFocus
                value={editTitle}
                disabled={saving === "title"}
                onChange={(event) => setEditTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") { event.stopPropagation(); setEditTitle(null); return; }
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  const next = editTitle.trim();
                  setEditTitle(null);
                  if (next !== String(row.title || "")) void patchItem({ title: next }, "title", { keepOpen: true });
                }}
                onBlur={() => setEditTitle(null)}
              />
            )}
            <span className={`af-radar-pill af-radar-pill--${row.state}`}>{vocab.state(row.state)}</span>
          </div>
          <div className="af-radar-modal-acts">
            {/* 放大＝去它自己的页面。原来只是把弹框撑大，撑大的弹框没有地址，
                发给别人的仍然是「板的地址」，对方点进去看到的是整块板 */}
            {standalone ? null : (
              <button
                type="button"
                onClick={onOpenPage}
                title="在独立页面打开（可分享）"
                aria-label="在独立页面打开"
              >
                <span className="material-symbols-outlined">open_in_full</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              title={standalone ? "回到板" : "关闭（Esc）"}
              aria-label={standalone ? "回到板" : "关闭"}
            >
              <span className="material-symbols-outlined">{standalone ? "arrow_back" : "close"}</span>
            </button>
          </div>
        </header>

        <div className="af-radar-modal-body">
        <section className="af-radar-modal-col">
        <h4>时间</h4>
        <dl className="af-radar-dl">
          <dt>截止</dt>
          <dd><DateEdit value={row.due} field="due" row={row} saving={saving} onSave={patchItem} /></dd>
          {/*
            有效截止 = 截止往前挪到能赶上的那班车。没挂上车时它和截止一模一样，
            并排放两行相同的日期，读起来像系统重复输出了一遍
          */}
          {row.effectiveDue && row.effectiveDue !== row.due ? (
            <>
              <dt>实际要赶</dt>
              <dd>
                {formatDay(row.effectiveDue)}
                {effectiveNote(row) ? <span className="af-radar-note"> · {effectiveNote(row)}</span> : null}
              </dd>
            </>
          ) : null}
          <dt>开始</dt>
          <dd><DateEdit value={row.startAt} field="startAt" row={row} saving={saving} onSave={patchItem} /></dd>
          <dt>完成</dt>
          <dd><DateEdit value={row.endAt} field="endAt" row={row} saving={saving} onSave={patchItem} /></dd>
          <dt>剩余</dt>
          <dd>{row.daysLeft === null ? "没有截止日期" : row.daysLeft > 0 ? `${row.daysLeft} 天` : "已过期"}</dd>
          {/* 入库和最近写入是两件事：一条盯了多久，和它上次被刷新是什么时候 */}
          {row.firstSeenAt ? <><dt>入库</dt><dd>{formatDay(row.firstSeenAt)}</dd></> : null}
          {row.lastSeenAt ? <><dt>最近写入</dt><dd>{formatStamp(row.lastSeenAt)}</dd></> : null}
          <dt>负责人</dt>
          {/*
            认领是纯人工字段：流程不该替人分派责任，所以这里不会和任何扫描结果冲突。
            光有「我来」是不够的——绝大多数时候要做的是**把事派给别人**，
            只能自己认领的话，一屋子人里只有点开这一条的那个能被写上去。
          */}
          <dd>
            <OwnerPicker row={row} extra={knownOwners} saving={saving} onSave={patchItem} />
          </dd>
          {/* 一块板由多条流程喂，出问题时第一件事是知道这条是谁写的 */}
          {row.flowId ? <><dt>由谁写入</dt><dd className="af-radar-mono">{row.flowId}</dd></> : null}
        </dl>

        <h4>标签</h4>
        <div className="af-radar-tagbox">
          {rowTags.length ? rowTags.map((tag) => (
            <span key={tag} className="af-radar-tag">
              {tag}
              <button
                type="button"
                aria-label={`移除标签 ${tag}`}
                disabled={Boolean(saving)}
                onClick={() => patchItem({ removeTags: [tag] }, `tag:${tag}`, { keepOpen: true })}
              >×</button>
            </span>
          )) : <span className="af-radar-note">还没有标签</span>}
        </div>
        <div className="af-radar-tagadd">
          <input
            type="text"
            value={draftTag}
            list="af-radar-known-tags"
            placeholder="加一个标签，回车确认"
            onChange={(event) => setDraftTag(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              addTag(draftTag);
            }}
          />
          <datalist id="af-radar-known-tags">
            {knownTags.map((tag) => <option key={tag} value={tag} />)}
          </datalist>
        </div>
        {knownTags.length ? (
          <div className="af-radar-tagbox af-radar-tagbox--known">
            {knownTags.slice(0, 8).map((tag) => (
              <button
                key={tag}
                type="button"
                className="af-radar-tag af-radar-tag--add"
                disabled={Boolean(saving)}
                onClick={() => addTag(tag)}
              >+ {tag}</button>
            ))}
          </div>
        ) : null}
        {/* 流程加的标签人也能删：删除记进 tagsRemoved，否则下一轮又被写回来 */}
        {(row.override?.tagsRemoved || []).length ? (
          <p className="af-radar-note">已隐藏流程加的：{row.override.tagsRemoved.join("、")}</p>
        ) : null}

        {/* 人的判断优先，但脚本的观测留着——一次点击不该永久盖住一次真实退化 */}
        {row.overrideConflict ? (
          <div className="af-radar-conflict">
            <b>你的标记和扫描结果不符</b>
            <p>
              {row.override?.by || "有人"}在 {String(row.override?.at || "").slice(0, 10)} 标成
              「{vocab.state(row.override?.state)}」，
              但最近一次扫描仍然是「{vocab.state(row.observedState)}」。
            </p>
          </div>
        ) : null}

        <h4>改状态</h4>
        <div className="af-radar-setstate">
          {SET_STATE_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.state}
              disabled={Boolean(saving)}
              className={row.state === option.state ? "af-radar-setstate--on" : ""}
              onClick={() => void setState({ state: option.state }, option.state)}
            >
              {saving === option.state ? "…" : option.label}
            </button>
          ))}
          <button
            type="button"
            disabled={Boolean(saving)}
            className={row.settled ? "af-radar-setstate--on" : ""}
            title="不再期待它更新，也不再为它告警。政策改了还会重新亮起来"
            onClick={() => void setState({ settled: !row.settled }, "settled")}
          >
            {saving === "settled" ? "…" : row.settled ? "取消封存" : "不用再盯"}
          </button>
          {row.override ? (
            <button
              type="button"
              disabled={Boolean(saving)}
              className="af-radar-setstate--reset"
              title="回到脚本判定"
              onClick={() => void setState({ state: "", settled: undefined }, "reset")}
            >
              {saving === "reset" ? "…" : "撤销我的标记"}
            </button>
          ) : null}
          {/*
            归档和「不用再盯」不是一回事：后者留在板上但不出声，前者是把这一条拿走。
            父行归档会带走它的分面，所以按钮上得先说清楚要带走几条——
            点下去才发现少了九行，那是最糟的一种「可逆」。
          */}
          <button
            type="button"
            disabled={Boolean(saving)}
            className="af-radar-setstate--archive"
            title={row.archived ? "放回板上" : "从板上拿走，归档页里还找得到"}
            onClick={() => void patchItem({ archived: !row.archived }, "archived")}
          >
            {saving === "archived"
              ? "…"
              : row.archived
                ? "取消归档"
                : facetCount ? `归档（含 ${facetCount} 个分面）` : "归档"}
          </button>
        </div>
        {saveError ? <p className="af-radar-new-error">{saveError}</p> : null}
        <p className="af-radar-setstate-hint">
          只有<b>未完成</b>的条目才会告警。标成已完成或封存之后，这一条就不再出声。
          {row.archivedBy
            ? <> 这一条是被上面的「{row.archivedBy}」一起归档的，要放回来得去改那一条。</>
            : null}
        </p>

        {/*
          这里改的是**流程该盯什么**，不是替流程写结论。
          现状和依据是 agent 查出来的，人手改掉它等于伪造一次扫描结果——
          要改结论，得让流程重新去查，所以这一句交给 AI 调整、走提案和审批。
        */}
        {onAskAi ? (
          <>
            <h4>让 AI 改这一条</h4>
            <textarea
              className="af-radar-itemask"
              rows={2}
              value={aiAsk}
              placeholder="把这条拆成两条子任务；改成每天查一次…"
              onChange={(event) => setAiAsk(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !event.metaKey) return;
                event.preventDefault();
                if (aiAsk.trim()) onAskAi(itemAsk(row, aiAsk));
              }}
            />
            <div className="af-radar-new-examples">
              {ITEM_ASK_EXAMPLES.map((example) => (
                <button type="button" key={example} onClick={() => setAiAsk(example)}>{example}</button>
              ))}
            </div>
            <button
              type="button"
              className="af-radar-new-go"
              disabled={!aiAsk.trim()}
              onClick={() => onAskAi(itemAsk(row, aiAsk))}
            >
              <span className="material-symbols-outlined">auto_awesome</span>
              交给 AI 调整
            </button>
            <p className="af-radar-setstate-hint">
              带着这一条的 id 去问，AI 读整块板给提案；落地前还要过一次审批。
              现状和依据是流程查出来的，人手改等于伪造一次扫描——要改它，让流程重新去查。
            </p>
          </>
        ) : null}
        </section>

        <section className="af-radar-modal-col">
        {/* 结论和依据是这一条最该被读的两段，本来沉在最底下那堆原始字段里，
            和 overdue/settled/docLines 一个待遇。板自己配了 detail.sections 的就听板的 */}
        {verdictFields.length ? (
          <>
            <h4>结论</h4>
            <dl className="af-radar-dl af-radar-dl--verdict">
              {verdictFields.map(([field, label]) => (
                <div key={field} style={{ display: "contents" }}>
                  <dt>{label}</dt>
                  <dd><RowValue value={row[field]} /></dd>
                </div>
              ))}
            </dl>
          </>
        ) : null}

        {sections.map((section) => {
          const fields = (section.fields || []).filter((field) => row?.[field] !== undefined && row?.[field] !== "");
          if (!fields.length) return null;
          fields.forEach((field) => shown.add(field));
          return (
            <div key={section.title}>
              <h4>{section.title}</h4>
              <dl className="af-radar-dl">
                {fields.map((field) => (
                  <div key={field} style={{ display: "contents" }}>
                    <dt>{field}</dt>
                    <dd><RowValue value={row[field]} /></dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}

        <h4>其余字段</h4>
        <dl className="af-radar-dl af-radar-dl--raw">
          {Object.entries(row)
            .filter(([key]) => !shown.has(key) && !["id", "done", "effectiveReason", "cutoffDate"].includes(key))
            .map(([key, value]) => (
              <div key={key} style={{ display: "contents" }}>
                <dt>{key}</dt>
                <dd><RowValue value={value} /></dd>
              </div>
            ))}
        </dl>
        </section>
        </div>
    </Shell>
  );
}

/**
 * 变更流走侧边抽屉，不占主屏。
 *
 * 大多数天它是空的——常驻展示只会让人习惯性略过，反而在真有变化那天看不见。
 */
function EventsDrawer({ events, onClose }) {
  return (
    <>
      <div className="af-radar-scrim" onClick={onClose} />
      <aside className="af-radar-drawer" role="dialog" aria-modal="true" aria-label="变更">
        <button type="button" className="af-radar-drawer-close" onClick={onClose} aria-label="关闭">×</button>
        <h3>变更</h3>
        <p className="af-radar-drawer-lead">定时任务每天比对官方原文与仓库现状，只记变了的。</p>
        {!events.length ? (
          <p className="af-radar-none">还没有变更记录。</p>
        ) : (
          <ul className="af-radar-events">
            {events.map((event, index) => (
              <li key={`${event.at}-${index}`}>
                <div className="af-radar-event-top">
                  <span className={`af-radar-kind af-radar-kind--${event.kind || "new"}`}>
                    {KIND_LABEL[event.kind] || event.kind || "变更"}
                  </span>
                  <time>{new Date(event.at).toLocaleString()}</time>
                </div>
                <p>{event.text || ""}</p>
                {event.item ? <span className="af-radar-event-item">{event.item}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </aside>
    </>
  );
}

/**
 * 建板：一个输入框说清楚要盯什么，剩下交给规划。
 *
 * 四步：说盯什么 → AI 规划 → 确认条目 → review 流程 → 建。
 *
 * **人只回答「要盯什么」。** 板叫什么、id 是什么、board.md 长什么样，都是内部实现，
 * 反过来问人只是把实现细节摊在他脸上——他也答不好，因为他还没看到规划出什么。
 * 名字由规划给，在第 3 步亮出来让他否决。
 *
 * **中间那两次确认就是审批本身。** 人在这儿一条条看过了条目和流程，建完就不该再进
 * 审批队列——同样的东西让他批第二遍，只会教会他闭眼点。之后指挥官再改什么才走门禁。
 *
 * 不做弹框、也不并排：建板时下面那块板整个让开。留着它，人一边填一边看的是别人的跑道。
 */
function SetupPanel({ taken = [], onCancel, onCreated, bare = false }) {
  const [step, setStep] = useState("ask");
  const [topic, setTopic] = useState("");
  const [dropped, setDropped] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const run = useRadarPlanRun();
  const { plan, messages, steps, error } = run;
  const setError = run.setError;
  /**
   * 规划没给名字、或者撞了已有的板时的退路。id 会进深链和流程参数，
   * 所以只生成一次，不跟着渲染变。
   */
  const [fallbackId] = useState(() => `board-${Math.random().toString(36).slice(2, 8)}`);

  /**
   * 板叫什么、id 是什么，都由规划给——让人先取名再说需求，是把内部字段当成了提问。
   * 人只需要说清楚要盯什么。
   */
  const boardTitle = String(plan?.board?.title || "").trim() || topic.trim().slice(0, 12) || "新雷达";
  const boardId = (() => {
    const want = String(plan?.board?.id || "").trim();
    if (!want) return fallbackId;
    if (!taken.includes(want)) return want;
    for (let n = 2; n < 10; n += 1) if (!taken.includes(`${want}-${n}`)) return `${want}-${n}`;
    return fallbackId;
  })();

  const items = (plan?.items || []).filter((item) => !dropped.has(item.id));
  const flows = (plan?.flows || []).filter((flow) => !dropped.has(`flow:${flow.flowId}`));

  const toggle = (key) => setDropped((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  /**
   * 规划。跑的是 `radar-plan` 那条流程，不是一次 prompt——所以有 run 记录、有节点重试，
   * 解析不出来时图里那条「让它重发一遍」的边会自己走。
   */
  const runPlan = async (event) => {
    event?.preventDefault();
    if (run.running) return;
    if (!topic.trim()) { setError("说一下这块板要盯什么"); return; }
    setStep("planning");
    const got = await run.start({ ask: topic.trim() });
    setStep(got ? "items" : "ask");
  };

  const create = async () => {
    if (busy || run.running) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/radar/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          board: boardId,
          title: boardTitle,
          topic: topic.trim(),
          plan: { ...plan, items, flows },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || "建板失败");
      onCreated(boardId);
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  };

  return (
    <section className={`af-radar-setup${bare ? " af-radar-setup--bare" : ""}`}>
      {bare ? null : (
        <div className="af-radar-arrange-head">
          <h2>新建雷达</h2>
          <button type="button" className="af-radar-x" onClick={onCancel} aria-label="关闭">×</button>
        </div>
      )}

      <ol className="af-radar-steps">
        {[["ask", "说盯什么"], ["planning", "规划"], ["items", "确认条目"], ["flows", "review 流程"]].map(([key, label], index) => (
          <li key={key} className={step === key ? "af-radar-step--on" : ""}>
            <i>{index + 1}</i>{label}
          </li>
        ))}
      </ol>

      {step === "ask" ? (
        <form className="af-radar-setup-ask" onSubmit={runPlan}>
          {/* 只问一件事。板名、id、board.md 都是内部实现，不该反过来问人 */}
          <label className="af-radar-field">
            <span>这块板要盯什么</span>
            <textarea
              autoFocus
              rows={4}
              value={topic}
              placeholder="盯 Google Play 与 Android 平台的强制要求，凡是有截止日、不做会被拒审或下架的都要追。"
              onChange={(e) => setTopic(e.target.value)}
            />
            <em>说清楚边界：什么算、什么不算。之后每一轮 agent 都照着这句话判断。</em>
          </label>
          {error ? <p className="af-radar-modal-error">{error}</p> : null}
          <div className="af-radar-setup-foot">
            {onCancel ? <button type="button" className="af-radar-ghost" onClick={onCancel}>取消</button> : null}
            <button type="submit" className="af-radar-primary">让 AI 规划</button>
          </div>
        </form>
      ) : null}

      {/* 跑起来之后就不是表单了，是一次运行。问题摆上去，下面是它在干什么 */}
      {step === "planning" ? (
        <div className="af-radar-setup-body">
          <ComposerAssistantTurn role="user" content={topic} copy={false} />
          <PlanRunView messages={messages} steps={steps} running={run.running} />
          {error ? <p className="af-radar-modal-error">{error}</p> : null}
          <div className="af-radar-setup-foot">
            <button type="button" className="af-radar-ghost" onClick={() => { run.stop(); setStep("ask"); }}>
              {run.running ? "停下改说法" : "返回改说法"}
            </button>
          </div>
        </div>
      ) : null}

      {step === "items" ? (
        <div className="af-radar-setup-body">
          {/* 名字是规划的产出，不是问句：给人一次看见和否决的机会就够了 */}
          <p className="af-radar-setup-name">这块板会叫 <b>{boardTitle}</b></p>
          {plan?.summary ? <p className="af-radar-plan-summary">{plan.summary}</p> : null}
          <p className="af-radar-setup-hint">
            这些是它打算盯的事项。<b>不要的取消勾选</b>；漏了的建完再加。
            状态一律是「还没扫过」—— 这一刻它还没查过任何东西，写别的都是编的。
          </p>
          {(plan?.items || []).map((item) => (
            <label key={item.id} className={`af-radar-setup-item${dropped.has(item.id) ? " af-radar-setup-item--off" : ""}`}>
              <input type="checkbox" checked={!dropped.has(item.id)} onChange={() => toggle(item.id)} />
              <span>
                <b>{item.title}</b>
                <code>{item.id}</code>
                {item.due ? <i>截止 {item.due}</i> : <i className="af-radar-muted">无期限</i>}
                {item.required ? <em>要求：{item.required}</em> : null}
                {item.tasks?.length ? <em>{item.tasks.length} 个待办</em> : null}
                {item.unknowns?.length ? <em className="af-radar-bad">{item.unknowns.length} 处待确认</em> : null}
              </span>
            </label>
          ))}
          {(plan?.warnings || []).length ? (
            <ul className="af-radar-plan-warn">{plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          ) : null}
          <div className="af-radar-setup-foot">
            <button type="button" className="af-radar-ghost" onClick={() => setStep("ask")}>改描述重来</button>
            <button type="button" className="af-radar-primary" disabled={!items.length} onClick={() => setStep("flows")}>
              下一步：看流程（{items.length} 条事项）
            </button>
          </div>
        </div>
      ) : null}

      {step === "flows" ? (
        <div className="af-radar-setup-body">
          <p className="af-radar-setup-hint">
            这些流程会被建出来，<b>但默认停用</b>。建好之后去定时任务页手动开启 ——
            建它和让它开始每天调用 AI 是两个决定。
          </p>
          {(plan?.flows || []).map((flow) => (
            <label key={flow.flowId} className={`af-radar-setup-item${dropped.has(`flow:${flow.flowId}`) ? " af-radar-setup-item--off" : ""}`}>
              <input
                type="checkbox"
                checked={!dropped.has(`flow:${flow.flowId}`)}
                onChange={() => toggle(`flow:${flow.flowId}`)}
              />
              <span>
                <b>{flow.title || flow.flowId}</b>
                <code>{flow.flowId}</code>
                <i>{flow.cron || "节奏未定"}</i>
                <em>认领 {flow.owns?.includes("*") ? "全部条目" : `${flow.owns?.length || 0} 个`}</em>
                <em>写 {(flow.updates || []).join(" / ") || "state / current / evidence"}</em>
                {flow.cadenceWhy ? <em className="af-radar-muted">{flow.cadenceWhy}</em> : null}
              </span>
            </label>
          ))}
          {error ? <p className="af-radar-modal-error">{error}</p> : null}
          <div className="af-radar-setup-foot">
            <button type="button" className="af-radar-ghost" onClick={() => setStep("items")}>返回条目</button>
            <button type="button" className="af-radar-primary" disabled={busy || run.running} onClick={create}>
              {busy ? "建中…" : `建板（${items.length} 条事项 · ${flows.length} 条流程）`}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default function RadarPage() {
  const { path, navigate } = useRoute();
  // `/radar/item` 是条目自己的页面：同一份详情，没有板在后面，地址可以直接发人
  const standaloneItem = path === "/radar/item";
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const [boards, setBoards] = useState([]);
  const [board, setBoard] = useState(null);
  const [events, setEvents] = useState([]);
  const [active, setActive] = useState(String(query.get("board") || ""));
  /**
   * 开关藏起来的时候默认「全部」。
   *
   * 「我的」= 我认领的 + 无人认领的。别人认领过的行在这个视角下是看不见的——
   * 平时有按钮可以切回去，按钮没了就成了「行凭空消失且无法找回」。
   */
  const [scope, setScope] = useState(() => {
    if (query.get("scope") === "all") return "all";
    return SHOW_SCOPE_SWITCH ? "mine" : "all";
  });
  const [view, setView] = useState(String(query.get("view") || ""));
  const [year, setYear] = useState(() => new Date().getFullYear());
  // 分组字段。spec.encode.group 给默认值，人可以就地改而不写回板——
  // 「我这会儿想换个角度看」不该改掉所有人的板
  const [group, setGroup] = useState(String(query.get("group") || ""));
  /**
   * 多值分组默认「一条只进主组」。
   *
   * 一条带三个标签的会出现在三组里，那是标签的正确语义；但一块板打开就看到
   * 十六行去表示九条事，第一眼读到的是「怎么这么多」而不是分类。
   * 所以默认按主标签归一组，想看全的人自己打开。
   */
  const [primaryOnly, setPrimaryOnly] = useState(true);
  const [picked, setPicked] = useState(null);
  const [planSeed, setPlanSeed] = useState("");
  const [showEvents, setShowEvents] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showFlows, setShowFlows] = useState(false);
  // 协作视图要的运行台账。只在切到那一屏时才拉——其余视图用不上它
  const [runLanes, setRunLanes] = useState(null);
  const [runDays, setRunDays] = useState(14);
  const [showNewBoard, setShowNewBoard] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [resolving, setResolving] = useState(false);
  // resolvePending 定义在 reloadBoard 之前，用 ref 绕开顺序依赖而不是把两者揉成一个
  const reloadBoardRef = useRef(null);
  // 刚归档掉的那块，用来在顶上留一条撤销。可逆的动作，撤销比确认值钱——
  // 确认框只在动手前拦一次，人很快学会闭眼点；撤销在真的点错之后还在
  const [justArchived, setJustArchived] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadBoards = useCallback(async () => {
    const res = await fetch(`/api/radar/boards?scope=${scope}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "读取雷达失败");
    const list = Array.isArray(body.boards) ? body.boards : [];
    setBoards(list);
    return list;
  }, [scope]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const list = await loadBoards();
        if (cancelled) return;
        // 默认落到上次看的那块；没有记录就给最紧的
        let remembered = "";
        try { remembered = window.localStorage.getItem("af.radar.board") || ""; } catch { remembered = ""; }
        const pick = [active, remembered].find((id) => list.some((item) => item.board === id))
          || list.slice().sort((a, b) => (a.soonestDays ?? 1e9) - (b.soonestDays ?? 1e9))[0]?.board
          || "";
        setActive(pick);
      } catch (e) {
        if (!cancelled) setError(String(e.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadBoards]);

  /** 建完直接切过去：人刚建的板还要自己再点一下才能进，是多余的一步 */
  const onBoardCreated = useCallback(async (boardId) => {
    setShowNewBoard(false);
    try { await loadBoards(); } catch { /* 列表刷不出来不该挡住跳转 */ }
    setActive(boardId);
    setPicked(null);
    setShowEvents(false);
  }, [loadBoards]);

  /**
   * 归档当前这块板。
   *
   * 不是删除——分片、覆盖层、告警状态、变更流全留着。所以这里不做二次确认弹窗：
   * 可逆的动作加确认只是把成本转嫁给每一次正常操作，撤销入口比确认框更有用。
   */
  /**
   * 归档 / 取消归档一块板。
   *
   * 归档不是删除：分片、覆盖层、告警状态、变更流全留着。但它会让这块板从**所有人**的
   * 列表里消失，所以要确认一次——建板错了点归档就没了，代价不对称，确认也就不该对称。
   */
  const setArchived = useCallback(async (boardId, archived) => {
    if (!boardId || archiving) return;
    const archivedTitle = boards.find((item) => item.board === boardId)?.title || boardId;
    setArchiving(true);
    try {
      const res = await fetch("/api/radar/board/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ board: boardId, archived }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || (archived ? "归档失败" : "恢复失败"));
      const list = await loadBoards();
      setConfirmArchive(false);
      setPicked(null);
      setShowEvents(false);
      if (archived) {
        // 标题要在列表刷新**之前**就取好：刷完这块板已经不在列表里了，撤销条只剩一个 id
        setJustArchived({ board: boardId, title: archivedTitle });
        setActive(list[0]?.board || "");
      } else {
        setJustArchived(null);
        setActive(boardId);
      }
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setArchiving(false);
    }
  }, [archiving, loadBoards, boards]);

  useEffect(() => {
    if (view !== "agents" || !active) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/radar/runs?board=${encodeURIComponent(active)}&days=${runDays}`);
        const body = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) setRunLanes(Array.isArray(body.lanes) ? body.lanes : []);
      } catch {
        // 拉不到运行记录不该把整屏打掉，退回空列表由视图自己说「没有记录」
        if (!cancelled) setRunLanes([]);
      }
    })();
    return () => { cancelled = true; };
  }, [view, active, runDays]);

  /** 批准就写入，驳回不写但记事件——两者都要刷新板，不然人点完看到的还是旧的 */
  const resolvePending = useCallback(async (action, flow, id) => {
    if (resolving) return;
    setResolving(true);
    try {
      const res = await fetch("/api/radar/pending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ board: active, flow, id, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || "处理失败");
      await reloadBoardRef.current?.();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setResolving(false);
    }
  }, [active, resolving]);

  // 抽出来是因为改完状态要就地刷新：不刷新的话人点完看到的还是旧状态，会以为没生效
  const reloadBoard = useCallback(async () => {
    if (!active) { setBoard(null); return; }
    setError("");
    try {
      const res = await fetch(`/api/radar/board?board=${encodeURIComponent(active)}&scope=${scope}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "读取板失败");
      setBoard(body);
      // 协作视图不在 spec.views 里——它看的是喂这块板的流程，不是板的形态
      // agents 和 archived 不在 spec.views 里：它们看的不是板的形态（谁在喂、拿走了什么），
      // 不加进白名单的话，板一刷新就被踢回跑道，归档页根本停不住
      /**
       * 默认落在状态页。
       *
       * 跑道当默认是历史遗留——这块板 15 行里只有 3 条有截止日，甘特要的数据它没有。
       * 板自己在 spec 里点名要跑道的，照旧听板的。
       */
      setView((current) => {
        if (current && (current === "agents" || current === "archived" || current === "status")) return current;
        if (current && body.spec.views.includes(current)) return current;
        // 板没点名要别的形态时，跑道让位给状态页
        return body.spec.view === "runway" ? "status" : body.spec.view;
      });
      /**
       * 板的 spec 说了算，没说就**不分组**。
       *
       * 早先「板上有标签就默认按标签分」是自作主张：分组会把父子关系拍平，
       * 一进来看到的就不是「6 条政策」而是散开的十几条。要分组是人自己的动作。
       */
      setGroup((current) => current || String(body.spec?.encode?.group || ""));
      try { window.localStorage.setItem("af.radar.board", active); } catch { /* 隐私窗口，不记就是了 */ }
    } catch (e) {
      setError(String(e.message || e));
      setBoard(null);
    }
  }, [active, scope]);
  reloadBoardRef.current = reloadBoard;

  useEffect(() => {
    let cancelled = false;
    void reloadBoard();
    if (!active) return () => { cancelled = true; };
    (async () => {
      try {
        const res = await fetch(`/api/radar/events?board=${encodeURIComponent(active)}`);
        const body = await res.json().catch(() => ({}));
        if (!cancelled) setEvents(Array.isArray(body.events) ? body.events : []);
      } catch {
        if (!cancelled) setEvents([]);
      }
    })();
    return () => { cancelled = true; };
  }, [active, reloadBoard]);

  /**
   * 板、形态、**打开的那一条**都进地址。
   *
   * 条目也要进：人看到一条要命的政策，第一件事是把它发给能处理的人。
   * 地址里只有板的话，对方点开看到的是整块板，还得自己再找一遍——
   * 而「找一遍」正是发链接想省掉的那一步。
   */
  useEffect(() => {
    if (!active) return;
    const next = new URLSearchParams();
    next.set("board", active);
    if (view) next.set("view", view);
    if (scope === "all") next.set("scope", "all");
    if (picked?.id) next.set("item", String(picked.id));
    const base = standaloneItem ? "/radar/item" : "/radar";
    const target = `${base}?${next.toString()}`;
    if (`${window.location.pathname}${window.location.search}` !== target) {
      window.history.replaceState({}, "", target);
    }
  }, [active, view, scope, picked, standaloneItem]);

  /**
   * 地址里带着条目就把它打开——刷新、收藏、别人发来的链接都得能落到那一条上。
   * 板还没加载完时什么都不做，等 rows 到了再认。
   */
  useEffect(() => {
    const wanted = String(query.get("item") || "").trim();
    if (!wanted || !board?.rows?.length || picked) return;
    const found = board.rows.find((row) => String(row.id) === wanted);
    if (found) setPicked(found);
  }, [board, picked, query]);

  const encode = board?.spec?.encode || {};
  // 回到的是当前这块板的当前形态，不是雷达首页
  const radarSelfUrl = active
    ? `/radar?${new URLSearchParams({ board: active, ...(view ? { view } : {}), ...(scope === "all" ? { scope: "all" } : {}) }).toString()}`
    : "/radar";
  const boardFlows = board?.flows || [];
  // 只有一条就直达，多条才弹选择——为了一条流程还要点两下是白费的
  const soleCanvasUrl = boardFlows.length === 1
    ? flowCanvasUrl({ flowId: boardFlows[0].flowId, ...(boardFlows[0].flow || {}) }, radarSelfUrl)
    : "";
  // 可选的分组字段从**当前这块板的数据**里推，不是写死一张表——
  // AI 往条目里加了什么维度，这里就能按什么分
  // 字段名翻成人话由板自己的词典说了算（spec.fields）——没申明的才退回 key
  const groupChoices = useMemo(
    () => groupableFields(board?.rows || [], (key) => board?.spec?.fields?.[key]),
    [board],
  );
  // 年份按钮用没筛过的板算：按标签筛一下，能翻的年份跟着少一半，翻回来就找不到路了
  const yearChoices = useMemo(() => boardYears(board), [board]);
  /**
   * 归档页的数据单独拉。
   *
   * 不能塞进主板再前端筛：`readRadarBoard` 已经把两摞切开了，归档的那摞根本不在返回里；
   * 而且计数、汇总、缺席判定都是按「在架上的」算的，混回来会把它们全带偏。
   */
  const [archivedBoard, setArchivedBoard] = useState(null);
  const [archivedBusy, setArchivedBusy] = useState(false);
  const loadArchived = useCallback(async () => {
    if (!active) return;
    setArchivedBusy(true);
    try {
      const res = await fetch(`/api/radar/board?board=${encodeURIComponent(active)}&scope=${scope}&archived=1`);
      const body = await res.json().catch(() => ({}));
      if (res.ok) setArchivedBoard(body);
    } catch { /* 归档页读不出来不该打断主板 */ }
    setArchivedBusy(false);
  }, [active, scope]);
  useEffect(() => {
    if (view !== "archived") return;
    void loadArchived();
  }, [view, loadArchived]);

  const [tagFilter, setTagFilter] = useState("");
  /**
   * 按标签筛选。
   *
   * 命中的父项要**连它的子项一起留下**，反过来命中的子项也要把父项带上——
   * 只留命中的那些行，父子关系就断了：子项成了孤儿，父项没了汇总来源。
   */
  const filtered = useMemo(() => {
    if (!board) return board;
    if (!tagFilter) return board;
    const hit = new Set();
    for (const row of board.rows) {
      if (!(row.tags || []).includes(tagFilter)) continue;
      hit.add(String(row.id));
      if (row.parent) hit.add(String(row.parent));
      for (const kid of row.children || []) hit.add(String(kid));
    }
    return { ...board, rows: board.rows.filter((row) => hit.has(String(row.id))) };
  }, [board, tagFilter]);
  // 换了一块板之后，上一块板的分组字段可能在这块板上根本不存在。不归一的话
  // 下拉显示「不分组」，跑道上却多出一个「未填」的组，两边对不上
  const activeGroup = groupChoices.some((item) => item.field === group) ? group : "";
  const activeView = view;
  // 进归档页之前在看哪个视图。回来时回原地，而不是一律弹回跑道
  const beforeArchive = useRef("");
  const toggleArchive = useCallback(() => {
    setView((current) => {
      if (current === "archived") return beforeArchive.current || "";
      beforeArchive.current = current;
      return "archived";
    });
  }, []);
  const totalFailures = boards.reduce((sum, item) => sum + (item.fetchFailures || 0), 0);
  const totalStale = boards.reduce((sum, item) => sum + (item.staleFlows || 0), 0);

  if (loading) return <LoadingState variant="page" label="读取雷达" />;

  /*
   * 一条一页。
   *
   * 这个地址是发给别人的——对方要看的是这一条，不是这块板。所以板的壳一样都不留：
   * 没有侧栏（在 App.jsx 里按 fullBleed 摘掉）、没有面包屑、没有板页签、没有工具栏、
   * 没有下面那张列表。留着的话，收到链接的人打开是一整块板，还得自己在里面找一遍——
   * 而「省掉找这一遍」正是发链接的全部意义。
   */
  if (standaloneItem) {
    const wanted = String(query.get("item") || "").trim();
    // 别等 URL→picked 那个 effect 跑完，否则会先闪一下「没找到」
    const soloRow = picked || (board?.rows || []).find((row) => String(row.id) === wanted) || null;
    const backToBoard = `/radar?board=${encodeURIComponent(active)}${wanted ? `&item=${encodeURIComponent(wanted)}` : ""}`;
    return (
      <VocabContext.Provider value={board?.spec || null}>
        <div className="af-radar-page af-radar-solo">
          {soloRow ? (
            <RowDrawer
              row={soloRow}
              board={board}
              standalone
              onChanged={reloadBoard}
              onClose={() => navigate(backToBoard)}
              onAskAi={(text) => { setPlanSeed(text); setShowNew(true); }}
            />
          ) : (
            <div className="af-radar-solo-miss">
              <p className="af-radar-none">没有找到这一条。它可能已经归档了，或者地址里的 id 不对。</p>
              <a className="af-radar-link" href={backToBoard}>回到板上</a>
            </div>
          )}
          {showNew ? (
            <PlanDrawer
              board={board}
              boardId={active}
              navigate={navigate}
              returnTo={`${window.location.pathname}${window.location.search}`}
              seed={planSeed}
              onClose={() => { setShowNew(false); setPlanSeed(""); }}
            />
          ) : null}
        </div>
      </VocabContext.Provider>
    );
  }

  return (
    <VocabContext.Provider value={board?.spec || null}>
    <div className="af-settings-page af-radar-page">
      <div className="af-settings-top">
        <div className="af-settings-crumb">
          <span className="af-settings-crumb-muted">AgentFlow</span>
          <span className="af-settings-crumb-sep">/</span>
          <span className="af-settings-crumb-active">雷达</span>
        </div>
      </div>

      <div className="af-settings-body">
        <div className="af-settings-inner">
          {!boards.length ? (
            <section className="af-radar-empty">
              <h1 className="af-settings-h1">雷达</h1>
              <p className="af-settings-lead">
                一块板盯一件事。说清楚要盯什么，追踪项和定时流程会一起建出来。
              </p>
              {/* 一块板都没有时，唯一能做的事就是建板——直接摊开，不要一层「新建」按钮 */}
              <SetupPanel taken={[]} onCreated={onBoardCreated} bare />
              {error ? <p className="af-radar-error">{error}</p> : null}
            </section>
          ) : (
            <>
              <div className="af-radar-tabs">
                {boards.map((item) => (
                  <button
                    type="button"
                    key={item.board}
                    className={`af-radar-tab${item.board === active && !showNewBoard ? " af-radar-tab--on" : ""}`}
                    onClick={() => {
                      setShowNewBoard(false);
                      setActive(item.board);
                      setPicked(null);
                      setShowEvents(false);
                    }}
                  >
                    {item.title}
                    {item.counts.pending ? (
                      <span className={`af-radar-badge af-radar-badge--${item.worst}`}>{item.counts.pending}</span>
                    ) : null}
                    {/* 待审批单独一个角标：它和「几条没完成」是两件事，混在一起人分不清该干嘛 */}
                    {item.pendingCount ? (
                      <span className="af-radar-badge af-radar-badge--gate" title={`${item.pendingCount} 处改动等确认`}>
                        {item.pendingCount}
                      </span>
                    ) : null}
                  </button>
                ))}
                <button
                  type="button"
                  className={`af-radar-tab-add${showNewBoard ? " af-radar-tab-add--on" : ""}`}
                  title="新建雷达"
                  onClick={() => { setShowNewBoard((current) => !current); setConfirmArchive(false); }}
                >
                  <span className="material-symbols-outlined">add</span>
                </button>
                {/* 这三个数字是仅有的能证明监控没有静默死掉的东西，所以它们常驻 */}
                <span className="af-radar-health">
                  <i className={totalFailures || totalStale ? "af-radar-live-bad" : "af-radar-live"} />
                  {board?.updatedAt ? new Date(board.updatedAt).toLocaleString() : `${boards.length} 块板`}
                  {" · "}
                  <b className={totalFailures ? "af-radar-bad" : ""}>{totalFailures} 条抓取失败</b>
                  {totalStale ? <b className="af-radar-bad"> · {totalStale} 条编排哑了</b> : null}
                  {board?.conflicts?.length
                    ? <b className="af-radar-bad"> · {board.conflicts.length} 条被重复认领</b>
                    : null}
                </span>
              </div>

              {/* 撤销留在原地：可逆的动作，撤销入口在人真的点错之后还在，确认框只拦动手前那一次 */}
              {justArchived ? (
                <div className="af-radar-undo">
                  <span><b>{justArchived.title}</b> 已归档。</span>
                  <span className="af-radar-undo-sp" />
                  <button
                    type="button"
                    className="af-radar-link"
                    disabled={archiving}
                    onClick={() => setArchived(justArchived.board, false)}
                  >
                    撤销
                  </button>
                  <button type="button" className="af-radar-link" onClick={() => setJustArchived(null)}>知道了</button>
                </div>
              ) : null}

              {/* 建板独占：留着下面那块板，人一边填一边看着的是别人的跑道 */}
              {showNewBoard ? (
                <SetupPanel
                  taken={boards.map((item) => item.board)}
                  onCancel={() => setShowNewBoard(false)}
                  onCreated={onBoardCreated}
                />
              ) : (
                <>
                {error ? <p className="af-radar-error">{error}</p> : null}

                {board?.pending ? (
                  <PendingPanel
                    board={board}
                    pending={board.pending}
                    busy={resolving}
                    onResolve={resolvePending}
                  />
                ) : null}

                {board ? (
                  <>
                    <div className="af-radar-toolbar">
                      {/*
                        「我的」= 我认领的 ＋ 还没人认领的。无人认领是最危险的状态，
                        藏进「全部」里就等于没人会看见它，所以它跟着「我的」走。
                        按钮上带数字，否则这两个在没人认领的板上长得一模一样，看不出区别。
                      */}
                      {SHOW_SCOPE_SWITCH ? (
                        <div className="af-radar-seg">
                          <button
                            type="button"
                            className={scope === "mine" ? "af-radar-seg--on" : ""}
                            title="我认领的，加上还没人认领的"
                            onClick={() => setScope("mine")}
                          >
                            我的{scope === "mine" ? <i>{board.rows.length}</i> : null}
                          </button>
                          <button
                            type="button"
                            className={scope === "all" ? "af-radar-seg--on" : ""}
                            title="这块板上的每一条，包括别人认领的"
                            onClick={() => setScope("all")}
                          >
                            全部{board.totalRows ? <i>{board.totalRows}</i> : null}
                          </button>
                        </div>
                      ) : null}
                      {activeView === "agents" ? (
                        <div className="af-radar-seg">
                          {[7, 14, 30].map((value) => (
                            <button
                              type="button"
                              key={value}
                              className={runDays === value ? "af-radar-seg--on" : ""}
                              onClick={() => setRunDays(value)}
                            >
                              {value} 天
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {/* 年份是下拉不是分段：板跑几年之后按钮会把整条工具栏挤爆 */}
                      {activeView === "runway" ? (
                        <label className="af-radar-groupby">
                          <span>年度</span>
                          <select value={year} onChange={(event) => setYear(Number(event.target.value))}>
                            {yearChoices.map((value) => (
                              <option key={value} value={value}>{value} 年</option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                      {SHOW_GROUP_BY && (activeView === "runway" || activeView === "status") && groupChoices.length ? (
                        <label className="af-radar-groupby">
                          <span>分组</span>
                          <select value={activeGroup} onChange={(event) => setGroup(event.target.value)}>
                            <option value="">不分组</option>
                            {groupChoices.map((item) => (
                              <option key={item.field} value={item.field}>{item.label}</option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                      {SHOW_GROUP_BY && activeView === "runway" && FIXED_GROUPS.some((item) => item.multi && item.field === activeGroup) ? (
                        <button
                          type="button"
                          className={`af-radar-ghost af-radar-ghost--tiny${primaryOnly ? "" : " af-radar-ghost--on"}`}
                          title={primaryOnly ? "现在每条只进第一个标签的组" : "现在一条有几个标签就出现在几个组里"}
                          onClick={() => setPrimaryOnly((current) => !current)}
                        >
                          {primaryOnly ? "只进主标签" : "进所有标签组"}
                        </button>
                      ) : null}

                      {tagFilter ? (
                        <button
                          type="button"
                          className="af-radar-tagfilter"
                          onClick={() => setTagFilter("")}
                          title="取消筛选"
                        >
                          只看 <b>{tagFilter}</b> ×
                        </button>
                      ) : null}

                      <div className="af-radar-views">
                        <div className="af-radar-seg">
                          {Object.entries(VIEW_META).filter(([key]) => !HIDDEN_VIEWS.has(key)).map(([key, meta]) => {
                            // 协作视图看的是「谁在喂这块板」，和 spec 无关——任何板都该能看。
                            // 协作看的是「谁在喂这块板」，看板按状态分列，两者都不依赖板的形态。
                            // 只有跑道/表格这类和 encode 绑定的才问 spec
                            // 状态页和协作都不依赖板的 encode：一个看状态和变化，
                            // 一个看谁在喂。只有跑道/表格这类绑定通道的才问 spec
                            const available = key === "agents" || key === "board" || key === "status"
                              ? true
                              : board.spec.views.includes(key);
                            return (
                              <button
                                type="button"
                                key={key}
                                disabled={!available}
                                title={available ? meta.label : `这块板不支持${meta.label}`}
                                className={view === key ? "af-radar-seg--on" : ""}
                                onClick={() => setView(key)}
                              >
                                <span className="material-symbols-outlined">{meta.icon}</span>
                                {view === key ? meta.label : null}
                              </button>
                            );
                          })}
                        </div>

                        <button
                          type="button"
                          className="af-radar-ghost"
                          onClick={() => setShowEvents(true)}
                        >
                          <span className="material-symbols-outlined">history</span>
                          变更
                          {events.length ? <i className="af-radar-ghost-count">{events.length}</i> : null}
                        </button>

                        {/* 空板是「排」，已经有东西的板是「改」——同一个面板，问的不是同一件事 */}
                        <button
                          type="button"
                          className="af-radar-ghost af-radar-ghost--ai"
                          onClick={() => setShowNew((current) => !current)}
                        >
                          <span className="material-symbols-outlined">auto_awesome</span>
                          {board?.rows?.length ? "AI 调整" : "AI 编排"}
                        </button>


                        {/* 点「编排」回到产出这块板的画布，去配它的定时任务 */}
                        <button
                          type="button"
                          className="af-radar-ghost af-radar-ghost--primary"
                          disabled={!boardFlows.length}
                          title={boardFlows.length ? "打开产出这块板的编排" : "这块板还没有任何流程写过"}
                          onClick={() => {
                            if (soleCanvasUrl) navigate(soleCanvasUrl);
                            else if (boardFlows.length) setShowFlows((current) => !current);
                          }}
                        >
                          <span className="material-symbols-outlined">account_tree</span>
                          编排
                          {boardFlows.length > 1 ? <i className="af-radar-ghost-count">{boardFlows.length}</i> : null}
                        </button>
                        {showFlows ? (
                          <FlowPicker
                            flows={boardFlows}
                            navigate={navigate}
                            returnTo={radarSelfUrl}
                            onClose={() => setShowFlows(false)}
                            onAdd={() => {
                              setShowFlows(false);
                              setPlanSeed("再加一条流程，专门盯 ");
                              setShowNew(true);
                            }}
                          />
                        ) : null}

                        {/* 归档，不是删除：数据全留着，取消归档就完整回来 */}
                        <button
                          type="button"
                          className="af-radar-ghost af-radar-ghost--danger"
                          disabled={archiving}
                          title="归档这块板。分片、变更记录都留着，不是删除"
                          onClick={() => { setConfirmArchive((current) => !current); setShowNewBoard(false); }}
                        >
                          <span className="material-symbols-outlined">archive</span>
                          归档
                        </button>
                      </div>
                    </div>

                    {/*
                     * 确认行写清楚「留什么、丢什么」，而不是问一句「确定吗」。
                     * 人犹豫的是「这会不会把半年的记录删掉」——答了这个，确认才有意义。
                     */}
                    {confirmArchive ? (
                      <div className="af-radar-confirm">
                        <span>
                          归档 <b>{board.title}</b>？分片、变更记录、告警状态都留着，随时能恢复；
                          它会从所有人的雷达列表里消失。
                        </span>
                        <span className="af-radar-undo-sp" />
                        <button type="button" className="af-radar-ghost" onClick={() => setConfirmArchive(false)}>
                          取消
                        </button>
                        <button
                          type="button"
                          className="af-radar-danger"
                          disabled={archiving}
                          onClick={() => setArchived(active, true)}
                        >
                          {archiving ? "归档中…" : "归档"}
                        </button>
                      </div>
                    ) : null}

                    {view === "archived" ? (
                      <ArchivedView
                        board={archivedBoard}
                        busy={archivedBusy}
                        onPick={setPicked}
                        onRestore={async (row) => {
                          await fetch("/api/radar/item", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ board: active, itemId: row.id, archived: false }),
                          });
                          await Promise.all([loadArchived(), reloadBoard()]);
                        }}
                      />
                    ) : !board.rows.length ? (
                      <p className="af-radar-none">
                        这个视角下没有条目{board.totalRows ? `（这块板一共 ${board.totalRows} 条）` : ""}。
                      </p>
                    ) : view === "agents" ? (
                      <AgentsView
                        board={board}
                        lanes={runLanes || []}
                        days={runDays}
                        onPick={setPicked}
                        navigate={navigate}
                        returnTo={radarSelfUrl}
                      />
                    ) : activeView === "status" ? (
                      <StatusView
                        board={filtered}
                        events={events}
                        group={activeGroup}
                        onPick={setPicked}
                        tagFilter={tagFilter}
                        onTag={setTagFilter}
                      />
                    ) : activeView === "table" ? (
                      <TableView board={filtered} encode={encode} onPick={setPicked} />
                    ) : activeView === "board" ? (
                      <BoardView board={filtered} encode={encode} onPick={setPicked} />
                    ) : (
                      <Runway board={filtered} encode={encode} year={year} group={activeGroup} primaryOnly={primaryOnly} onPick={setPicked} tagFilter={tagFilter} onTag={setTagFilter} />
                    )}

                    {/*
                     * 归档是冷入口：人是翻到底、确认板上没有遗漏了，才会想起去看被拿走的东西。
                     * 摆在工具栏就是天天跟「AI 调整」「编排」抢位置——那两个是每天要点的。
                     * 一条都没归档过就不挂，空页面的入口只会让人白点一次。
                     */}
                    {board.archivedCount || view === "archived" ? (
                      <div className="af-radar-foot">
                        <button type="button" className="af-radar-foot-link" onClick={toggleArchive}>
                          <span className="material-symbols-outlined">
                            {view === "archived" ? "arrow_back" : "inventory_2"}
                          </span>
                          {view === "archived" ? "回到板上" : "已归档"}
                          {view === "archived" || !board.archivedCount ? null : <i>{board.archivedCount}</i>}
                        </button>
                      </div>
                    ) : null}
                </>
              ) : null}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {picked ? (
        <RowDrawer
          row={picked}
          board={board}
          standalone={standaloneItem}
          onChanged={reloadBoard}
          /* 新标签页：当前这块板别被顶掉。人点放大是想「把这一条拎出来」，
             不是想离开手上正在看的板 */
          onOpenPage={() => window.open(
            `/radar/item?board=${encodeURIComponent(active)}&item=${encodeURIComponent(picked.id)}`,
            "_blank",
            "noopener",
          )}
          onClose={() => {
            if (!standaloneItem) { setPicked(null); return; }
            // 独立页上「关闭」是回板，不是把内容清空后留一张白纸
            navigate(`/radar?board=${encodeURIComponent(active)}`);
          }}
          /* 条目里说的那句话交给同一个 AI 调整面板：提案、审批、落地都只有一条路 */
          onAskAi={(text) => { setPicked(null); setPlanSeed(text); setShowNew(true); }}
        />
      ) : null}
      {showEvents ? <EventsDrawer events={events} onClose={() => setShowEvents(false)} /> : null}
      {showNew ? (
        <PlanDrawer
          board={board}
          boardId={active}
          navigate={navigate}
          returnTo={radarSelfUrl}
          seed={planSeed}
          onClose={() => { setShowNew(false); setPlanSeed(""); }}
        />
      ) : null}
    </div>
    </VocabContext.Provider>
  );
}
