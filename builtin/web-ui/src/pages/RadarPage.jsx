import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useRoute } from "../routeContext.jsx";
import LoadingState from "../components/LoadingState.jsx";

/**
 * 雷达：定时流程产出的专项监控板。
 *
 * 这个页面**不认识业务**——合规追踪、证书到期、线上问题走的是同一份渲染代码，区别只在板里带的
 * `spec.encode`：哪个字段绑到哪个视觉通道。加一个领域不用动这里。
 *
 * 主图通道是稀缺的（行标签／条长度／颜色／标记／右侧值／分组），行上其余字段一律沉到抽屉。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HORIZONS = [3, 6, 12];
const VIEW_META = {
  runway: { label: "跑道", icon: "view_timeline" },
  board: { label: "看板", icon: "view_kanban" },
  table: { label: "表格", icon: "table_rows" },
  calendar: { label: "日历", icon: "calendar_month" },
  agents: { label: "协作", icon: "hub" },
};
const STATE_LABEL = { risk: "未开始", warn: "进行中", idle: "待确认", ok: "已满足" };
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

const PLAN_EXAMPLES = [
  "盯 Android 和 iOS 商店的政策与平台要求，代码现状也要能看出来",
  "盯我们所有证书、密钥、Token 的到期时间",
  "盯开了超过 90 天还没下线的 AB 实验",
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
function PlanDrawer({ board, boardId, returnTo, onClose, navigate }) {
  const [ask, setAsk] = useState("");
  const [plan, setPlan] = useState(null);
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState("");

  const requestPlan = async () => {
    if (!ask.trim() || busy) { if (!ask.trim()) setError("说一下你想盯什么"); return; }
    setBusy(true);
    setError("");
    setPlan(null);
    setLogs([]);
    try {
      const res = await fetch("/api/radar/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ board: boardId || "", ask }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `规划失败（HTTP ${res.status}）`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // NDJSON：按行切，最后一段可能是半行，留到下一块再拼
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === "log") setLogs((current) => [...current, event.text]);
          else if (event.type === "started") setLogs((current) => [...current, `读到 ${event.flows} 条编排、${event.rows} 个追踪项`]);
          else if (event.type === "plan") setPlan(event);
          else if (event.type === "error") setError(event.error || "规划失败");
        }
      }
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
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
      <aside className="af-radar-drawer af-radar-plan-drawer" role="dialog" aria-modal="true" aria-label="AI 编排">
        <button type="button" className="af-radar-drawer-close" onClick={onClose} aria-label="关闭">×</button>
        <h3>AI 编排</h3>
        <p className="af-radar-drawer-lead">
          读当前这块板，排出该配几条定时、各管哪些条目、各自什么节奏。这一步不动任何东西。
        </p>

        <label className="af-radar-new-field">
          <span>{boardId ? `想让「${board?.title || boardId}」盯什么` : "想盯什么"}</span>
          <textarea
            rows={3}
            value={ask}
            disabled={busy}
            placeholder="盯 Android 和 iOS 商店的政策与平台要求…"
            onChange={(event) => setAsk(event.target.value)}
          />
        </label>
        {!plan && !busy ? (
          <div className="af-radar-new-examples">
            {PLAN_EXAMPLES.map((example) => (
              <button type="button" key={example} onClick={() => setAsk(example)}>
                {example.slice(0, 16)}…
              </button>
            ))}
          </div>
        ) : null}
        <button type="button" className="af-radar-new-go" disabled={busy} onClick={() => void requestPlan()}>
          <span className="material-symbols-outlined">auto_awesome</span>
          {busy ? "正在排…" : plan ? "换个说法重排" : "让 AI 排一下"}
        </button>

        {/* 过程摊开给人看。转圈转三分钟，谁都会以为它挂了 */}
        {logs.length ? (
          <div className="af-radar-plan-log">
            {logs.map((line, index) => <p key={`${index}-${line.slice(0, 12)}`}>{line}</p>)}
            {busy ? <p className="af-radar-plan-log-live"><i className="af-radar-dot" />进行中…</p> : null}
          </div>
        ) : busy ? (
          <p className="af-radar-plan-log-live"><i className="af-radar-dot" />正在读这块板…</p>
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
  cursor.setMonth(cursor.getMonth() + 1);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() < end && ticks.length < 24) {
    ticks.push(cursor.getTime());
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return ticks;
}

/** 跑道上固定能分的两组：负责人、来源流程。它们一定存在，也一定有意义 */
const FIXED_GROUPS = [
  { field: "owner", label: "负责人" },
  { field: "flowId", label: "来源流程" },
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
function groupableFields(rows = []) {
  const counts = new Map();
  for (const row of rows) {
    for (const [field, value] of Object.entries(row || {})) {
      if (NEVER_GROUP.has(field) || FIXED_GROUPS.some((item) => item.field === field)) continue;
      if (value === null || value === undefined || value === "" || typeof value === "object") continue;
      if (typeof value === "boolean") continue;
      const seen = counts.get(field) || new Set();
      seen.add(String(value));
      counts.set(field, seen);
    }
  }
  const derived = [...counts.entries()]
    .filter(([, seen]) => seen.size >= 2 && seen.size <= 8)
    .map(([field]) => ({ field, label: field }))
    .sort((a, b) => a.field.localeCompare(b.field));
  return [...FIXED_GROUPS, ...derived];
}

/** 按字段把行切成段。空值单独归一组放最后——它们通常正是要补的那批 */
function groupRows(rows = [], field = "") {
  if (!field) return [{ key: "", label: "", rows }];
  const buckets = new Map();
  for (const row of rows) {
    const raw = row?.[field];
    const key = raw === null || raw === undefined || raw === "" ? "" : String(raw);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const sections = [...buckets.entries()]
    .map(([key, list]) => ({ key, label: key || (field === "owner" ? "无人认领" : "未填"), rows: list }));
  sections.sort((a, b) => (a.key ? 0 : 1) - (b.key ? 0 : 1) || a.key.localeCompare(b.key));
  return sections;
}

function Runway({ board, encode, months, group, onPick }) {
  const now = Date.now();
  const start = now;
  const end = now + months * 30.44 * DAY_MS;
  const at = (time) => ((time - start) / (end - start)) * 100;
  const ticks = monthTicks(start, end);
  const trains = (board.trains || [])
    .map((train) => ({ ...train, time: toTime(train.cutoff) }))
    .filter((train) => train.time > start && train.time < end);

  const guides = (
    <>
      {ticks.map((tick) => <i key={`t${tick}`} className="af-radar-tick" style={{ left: `${at(tick)}%` }} />)}
      {trains.map((train) => <i key={`v${train.cutoff}`} className="af-radar-train" style={{ left: `${at(train.time)}%` }} />)}
      <i className="af-radar-now" style={{ left: 0 }} />
    </>
  );

  return (
    <div className="af-radar-runway">
      <div className="af-radar-axis">
        {/* 左边这 250px 是条目名那一列，之前是空的——时间轴有刻度、条目列却没抬头，
            看着像表格少画了一块。计数跟着当前视角走（「我的」和「全部」数出来不一样） */}
        <span className="af-radar-axis-head">
          追踪项目<i>{board.rows.length}</i>
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
          <i className="af-radar-now" style={{ left: 0 }}><b>今天</b></i>
        </div>
      </div>

      {groupRows(board.rows, group).map((section) => (
        <Fragment key={section.key || "_all"}>
          {/* 分组抬头。不分组时 label 是空的，这一条就不画 */}
          {section.label ? (
            <div className="af-radar-group">
              <span>{section.label}</span>
              <i>{section.rows.length}</i>
            </div>
          ) : null}
          {section.rows.map((row) => {
        const endTime = toTime(readCell(row, encode.end));
        const state = String(readCell(row, encode.color) || row.state || "idle");
        const rawEnd = Number.isFinite(endTime) ? at(endTime) : null;
        const clipped = rawEnd !== null && rawEnd > 100;
        const width = rawEnd === null ? 0 : Math.max(Math.min(rawEnd, 100), 1.2);
        const markerTime = toTime(readCell(row, encode.marker));
        const markerAt = Number.isFinite(markerTime) ? at(markerTime) : null;
        const badges = (encode.badges || []).map((field) => row?.[field]).filter(Boolean);
        return (
          <button
            type="button"
            key={row.id || row.title}
            className={[
              "af-radar-row",
              row.overdue ? "af-radar-row--overdue" : "",
              row.done ? "af-radar-row--done" : "",
              row.settled ? "af-radar-row--settled" : "",
            ].filter(Boolean).join(" ")}
            onClick={() => onPick(row)}
          >
            <span className="af-radar-label">
              <span className="af-radar-name">{String(readCell(row, encode.lane) ?? row.title ?? "")}</span>
              <span className="af-radar-badges">
                {badges.map((badge) => <i key={String(badge)}>{String(badge)}</i>)}
                {row.owner ? null : <i className="af-radar-badge--none">无人认领</i>}
                {row.settled ? <i className="af-radar-badge--settled">已封存</i> : null}
                {/* 这一条多久没被写过了。分片还在跑不代表这一条还在被更新 */}
                {row.staleItem ? <i className="af-radar-badge--stale">没再更新</i> : null}
                {/* 人的标记和脚本观测不一致，得能一眼看出来 */}
                {row.overrideConflict ? <i className="af-radar-badge--override">人工标记</i> : null}
              </span>
            </span>
            <span className="af-radar-track">
              {guides}
              {/* 过期了就没有跑道可言。钳到最小宽度画出来的残条像渲染故障，
                  不如不画——红色边条和「已过期 N 天」已经把话说完了 */}
              {/* 没有截止日的也不画。2.5% 的残条读起来是「快到期了」，
                  而实际是「根本没有期限」——意思正好相反 */}
              {row.overdue || rawEnd === null ? null : (
                <span
                  className={`af-radar-bar af-radar-bar--${state}${clipped ? " af-radar-bar--clipped" : ""}`}
                  style={{ width: `${width}%` }}
                />
              )}
              {markerAt !== null && markerAt <= 100 && markerAt >= 0
                ? <i className="af-radar-cut" style={{ left: `${markerAt}%` }} />
                : null}
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
  );
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
  return (
    <div className="af-radar-kanban">
      {["risk", "warn", "idle", "ok"].map((state) => {
        const rows = board.rows.filter((row) => String(readCell(row, encode.color) || row.state) === state);
        return (
          <div key={state} className="af-radar-column">
            <h4 className={`af-radar-col-head af-radar-col-head--${state}`}>
              {STATE_LABEL[state]}<span>{rows.length}</span>
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

const SET_STATE_OPTIONS = [
  { state: "ok", label: "已完成" },
  { state: "warn", label: "进行中" },
  { state: "risk", label: "未开始" },
];

function RowDrawer({ row, board, onClose, onChanged }) {
  const [saving, setSaving] = useState("");
  const [saveError, setSaveError] = useState("");

  const setState = async (patch, tag) => {
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
      onClose();
    } catch (e) {
      setSaveError(String(e.message || e));
      setSaving("");
    }
  };

  const sections = board.spec?.detail?.sections || [];
  const shown = new Set(["title", "state", "due", "effectiveDue", "effectiveTrain", "daysLeft", "owner", "flowId"]);
  return (
    <>
      <div className="af-radar-scrim" onClick={onClose} />
      <aside className="af-radar-drawer" role="dialog" aria-modal="true" aria-label={String(row.title || "")}>
        <button type="button" className="af-radar-drawer-close" onClick={onClose} aria-label="关闭">×</button>
        <h3>{String(row.title || row.id || "")}</h3>
        <span className={`af-radar-pill af-radar-pill--${row.state}`}>{STATE_LABEL[row.state] || row.state}</span>

        <h4>时间</h4>
        <dl className="af-radar-dl">
          <dt>截止</dt><dd>{formatDay(row.due)}</dd>
          <dt>有效截止</dt>
          <dd>
            {formatDay(row.effectiveDue)}
            {effectiveNote(row) ? <span className="af-radar-note"> · {effectiveNote(row)}</span> : null}
          </dd>
          <dt>剩余</dt>
          <dd>{row.daysLeft === null ? "没有截止日期" : row.daysLeft > 0 ? `${row.daysLeft} 天` : "已过期"}</dd>
          <dt>负责人</dt>
          <dd>{row.owner || <span className="af-radar-bad">无人认领</span>}</dd>
          {/* 一块板由多条流程喂，出问题时第一件事是知道这条是谁写的 */}
          {row.flowId ? <><dt>由谁写入</dt><dd className="af-radar-mono">{row.flowId}</dd></> : null}
        </dl>

        {/* 人的判断优先，但脚本的观测留着——一次点击不该永久盖住一次真实退化 */}
        {row.overrideConflict ? (
          <div className="af-radar-conflict">
            <b>你的标记和扫描结果不符</b>
            <p>
              {row.override?.by || "有人"}在 {String(row.override?.at || "").slice(0, 10)} 标成
              「{STATE_LABEL[row.override?.state] || row.override?.state}」，
              但最近一次扫描仍然是「{STATE_LABEL[row.observedState] || row.observedState}」。
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
        </div>
        {saveError ? <p className="af-radar-new-error">{saveError}</p> : null}
        <p className="af-radar-setstate-hint">
          只有<b>未完成</b>的条目才会告警。标成已完成或封存之后，这一条就不再出声。
        </p>

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
                    <dd>{typeof row[field] === "object" ? JSON.stringify(row[field]) : String(row[field])}</dd>
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
                <dd>{typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}</dd>
              </div>
            ))}
        </dl>
      </aside>
    </>
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
 * 就地建板的那一条，展开在 tab 下面。
 *
 * 不做弹框：人取名字时要照着已有的板看——别撞车、命名风格一致。弹框正好把它们盖住，
 * 于是人得先关掉看一眼再重开。
 *
 * id 跟着标题自动生成，但改过一次就固定下来。一直跟着标题走的话，改一次标题就把所有
 * 已经配好的流程指向了一块不存在的板。
 */
function NewBoardBar({ onCancel, onCreated }) {
  const [title, setTitle] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const slug = (text) => String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const effectiveId = idTouched ? id : slug(title);

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const boardId = effectiveId.trim();
    if (!boardId) { setError("给它一个 id —— 标题里没有字母数字时要自己填"); return; }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/radar/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ board: boardId, title: title.trim() || boardId }),
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
    <form className="af-radar-newbar" onSubmit={submit}>
      <label className="af-radar-field">
        <span>叫什么</span>
        <input
          autoFocus
          value={title}
          placeholder="Android 政策追踪"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}
        />
      </label>
      <label className="af-radar-field af-radar-field--mono">
        <span>id</span>
        <input
          value={effectiveId}
          placeholder="android-policy"
          onChange={(event) => { setIdTouched(true); setId(event.target.value); }}
          onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}
        />
      </label>
      <button type="button" className="af-radar-ghost" onClick={onCancel}>取消</button>
      <button type="submit" className="af-radar-primary" disabled={busy}>{busy ? "建中…" : "建板"}</button>
      <p className="af-radar-newbar-hint">
        {error
          ? <b className="af-radar-bad">{error}</b>
          : <>id 会进深链，也是流程里 <code>--board=</code> 用的值。跟着标题自动生成，改过就固定下来 —— 建好之后不再变。</>}
      </p>
    </form>
  );
}

export default function RadarPage() {
  const { navigate } = useRoute();
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const [boards, setBoards] = useState([]);
  const [board, setBoard] = useState(null);
  const [events, setEvents] = useState([]);
  const [active, setActive] = useState(String(query.get("board") || ""));
  const [scope, setScope] = useState(query.get("scope") === "all" ? "all" : "mine");
  const [view, setView] = useState(String(query.get("view") || ""));
  const [months, setMonths] = useState(6);
  // 分组字段。spec.encode.group 给默认值，人可以就地改而不写回板——
  // 「我这会儿想换个角度看」不该改掉所有人的板
  const [group, setGroup] = useState(String(query.get("group") || ""));
  const [picked, setPicked] = useState(null);
  const [showEvents, setShowEvents] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showFlows, setShowFlows] = useState(false);
  // 协作视图要的运行台账。只在切到那一屏时才拉——其余视图用不上它
  const [runLanes, setRunLanes] = useState(null);
  const [runDays, setRunDays] = useState(14);
  const [showNewBoard, setShowNewBoard] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
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
      setView((current) => (
        current && (current === "agents" || body.spec.views.includes(current)) ? current : body.spec.view
      ));
      setGroup((current) => (current || String(body.spec.encode.group || "")));
      try { window.localStorage.setItem("af.radar.board", active); } catch { /* 隐私窗口，不记就是了 */ }
    } catch (e) {
      setError(String(e.message || e));
      setBoard(null);
    }
  }, [active, scope]);

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

  // 板和形态都进地址：企微通知的深链要能精确到「某块板的某个形态」
  useEffect(() => {
    if (!active) return;
    const next = new URLSearchParams();
    next.set("board", active);
    if (view) next.set("view", view);
    if (scope === "all") next.set("scope", "all");
    const target = `/radar?${next.toString()}`;
    if (`${window.location.pathname}${window.location.search}` !== target) {
      window.history.replaceState({}, "", target);
    }
  }, [active, view, scope]);

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
  const groupChoices = useMemo(() => groupableFields(board?.rows || []), [board]);
  // 换了一块板之后，上一块板的分组字段可能在这块板上根本不存在。不归一的话
  // 下拉显示「不分组」，跑道上却多出一个「未填」的组，两边对不上
  const activeGroup = groupChoices.some((item) => item.field === group) ? group : "";
  const totalFailures = boards.reduce((sum, item) => sum + (item.fetchFailures || 0), 0);
  const totalStale = boards.reduce((sum, item) => sum + (item.staleFlows || 0), 0);

  if (loading) return <LoadingState variant="page" label="读取雷达" />;

  return (
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
                还没有板。一块板是一个主题下的监控面，由定时流程往里写。
              </p>
              {/* 按钮就地换成建板条，而不是开一层弹框盖住下面的说明 */}
              {showNewBoard ? (
                <NewBoardBar onCancel={() => setShowNewBoard(false)} onCreated={onBoardCreated} />
              ) : (
                <div className="af-radar-empty-actions">
                  <button type="button" className="af-radar-primary" onClick={() => setShowNewBoard(true)}>
                    <span className="material-symbols-outlined">add</span>
                    新建雷达
                  </button>
                </div>
              )}
              {error ? <p className="af-radar-error">{error}</p> : null}
              <p className="af-settings-lead">
                建好之后，在流程末尾挂一个 <code>tool_nodejs</code> 写回结果：
              </p>
              <pre className="af-radar-empty-cmd">
                agentflow track commit --board=&lt;板&gt; --flow=&lt;流程&gt; --rows=$&#123;rows&#125;
              </pre>
              <p className="af-settings-lead">
                <code>$&#123;rows&#125;</code> 解析成上游节点的输出文件，内容是
                <code> {"{ rows: [{ id, title, state, owner, due, current, required }] }"}</code>。
                <code>commit</code> 会继承人工封存的标记、自动记录变更。
              </p>
              <p className="af-settings-lead">
                没开页面也能建：<code>agentflow track create &lt;板&gt; --title=&lt;标题&gt;</code>
              </p>
            </section>
          ) : (
            <>
              <div className="af-radar-tabs">
                {boards.map((item) => (
                  <button
                    type="button"
                    key={item.board}
                    className={`af-radar-tab${item.board === active ? " af-radar-tab--on" : ""}`}
                    onClick={() => { setActive(item.board); setPicked(null); setShowEvents(false); }}
                  >
                    {item.title}
                    {item.counts.pending ? (
                      <span className={`af-radar-badge af-radar-badge--${item.worst}`}>{item.counts.pending}</span>
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
                  <i className={totalFailures || totalStale ? "af-radar-dot-bad" : "af-radar-dot"} />
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

              {showNewBoard ? (
                <NewBoardBar onCancel={() => setShowNewBoard(false)} onCreated={onBoardCreated} />
              ) : null}

              {error ? <p className="af-radar-error">{error}</p> : null}

              {board ? (
                <>
                  <div className="af-radar-toolbar">
                    <div className="af-radar-seg">
                      {["mine", "all"].map((value) => (
                        <button
                          type="button"
                          key={value}
                          className={scope === value ? "af-radar-seg--on" : ""}
                          onClick={() => setScope(value)}
                        >
                          {value === "mine" ? "我的" : "全部"}
                        </button>
                      ))}
                    </div>
                    {view === "agents" ? (
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
                    {view === "runway" ? (
                      <div className="af-radar-seg">
                        {HORIZONS.map((value) => (
                          <button
                            type="button"
                            key={value}
                            className={months === value ? "af-radar-seg--on" : ""}
                            onClick={() => setMonths(value)}
                          >
                            {value} 月
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {view === "runway" && groupChoices.length ? (
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

                    <div className="af-radar-views">
                      <div className="af-radar-seg">
                        {Object.entries(VIEW_META).map(([key, meta]) => {
                          // 协作视图看的是「谁在喂这块板」，和 spec 无关——任何板都该能看
                          const available = key === "agents" || board.spec.views.includes(key);
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

                      {/* 板级编排：AI 看着这块板，排出该配几条定时、各管哪些条目 */}
                      <button
                        type="button"
                        className="af-radar-ghost af-radar-ghost--ai"
                        onClick={() => setShowNew((current) => !current)}
                      >
                        <span className="material-symbols-outlined">auto_awesome</span>
                        AI 编排
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

                  {!board.rows.length ? (
                    <p className="af-radar-none">
                      这个视角下没有条目{board.totalRows ? `（这块板一共 ${board.totalRows} 条，切到「全部」看看）` : ""}。
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
                  ) : view === "table" ? (
                    <TableView board={board} encode={encode} onPick={setPicked} />
                  ) : view === "board" ? (
                    <BoardView board={board} encode={encode} onPick={setPicked} />
                  ) : (
                    <Runway board={board} encode={encode} months={months} group={activeGroup} onPick={setPicked} />
                  )}
                </>
              ) : null}
            </>
          )}
        </div>
      </div>

      {picked ? (
        <RowDrawer
          row={picked}
          board={board}
          onChanged={reloadBoard}
          onClose={() => setPicked(null)}
        />
      ) : null}
      {showEvents ? <EventsDrawer events={events} onClose={() => setShowEvents(false)} /> : null}
      {showNew ? (
        <PlanDrawer
          board={board}
          boardId={active}
          navigate={navigate}
          returnTo={radarSelfUrl}
          onClose={() => setShowNew(false)}
        />
      ) : null}
    </div>
  );
}
