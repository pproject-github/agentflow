/**
 * `agentflow track` —— 雷达追踪板的命令行入口。
 *
 * 存在的理由是**定时流程需要一条写回的路**。流程末尾挂一个 `tool_nodejs`：
 *
 *     agentflow track commit --board=compliance --flow=play-policy-watch --rows=${rows}
 *
 * `${rows}` 由 Workspace 运行时解析成上游节点的输出文件路径，退出码即成败，stdout
 * 不做 JSON 包装——和 `tool_nodejs` 的既有契约完全一致，不引入新概念。
 *
 * `commit` 替流程做三件它自己做不好的事：
 *
 *   1. **继承 settled**。流程每次整片重写；人标成「已封存」的条目如果不继承，
 *      下一次扫描就会把它们全部复活并开始告警。
 *   2. **产出变更事件**。diff 上一片和这一片，自动写进变更流。否则「变更」抽屉
 *      永远是空的，或者每个流程作者都得手写事件。
 *   3. **挡住互相覆盖**。分片上盖 `writtenBy`，换个人的流程写同一片时拒绝。
 *
 * 其余子命令（list/show/events/rm）是给人排查用的，不进流程。
 */
import fs from "node:fs";

import {
  RADAR_STATES,
  appendRadarEvent,
  isValidBoardId,
  isValidShardId,
  listRadarBoardIds,
  listRadarBoards,
  readRadarBoard,
  readRadarEvents,
  readRadarShard,
  rmRadarBoard,
  rmRadarShard,
  writeRadarShard,
} from "./radar.mjs";

/**
 * 能写进 `state` 的值。
 *
 * `unknown` 是**故意**收的：规划提示词明确要求脚本匹配不到时返回 unknown，而不是
 * 默认当成通过。它落到 idle（没什么可报告的）。
 *
 * 但 `normalizeState` 对任何不认识的值都静默给 idle——这意味着一个拼错的 `"warning"`
 * 会变成「没什么可报告的」，也就是一张假的合格证。所以这里**先验再交给它**：
 * 有意的 unknown 放行，拼错的报错。
 */
const ACCEPTED_STATES = new Set([...RADAR_STATES, "unknown"]);
/** 核心字段。和 radar-planner 的 UPDATABLE_FIELDS 对齐，两处发散了板上就会出现对不上的列 */
const CORE_FIELDS = ["state", "current", "required", "evidence", "due", "owner", "title", "source"];

function fail(message) {
  const error = new Error(message);
  error.trackCli = true;
  return error;
}

/** `--board=x` 和 `--board x` 都收；`--json` 这种布尔位单独给 true */
export function parseTrackArgs(argv = []) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = String(argv[index] || "");
    if (!item.startsWith("--")) { positional.push(item); continue; }
    const body = item.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith("--")) { flags[body] = String(next); index += 1; }
    else flags[body] = true;
  }
  return { flags, positional };
}

/**
 * 校验并规整模型产出的条目。
 *
 * 不做字段白名单——多出来的字段是**特性**：`spareFields()` 就是拿它们做多维展示的，
 * 剥掉就把这块板锁死成固定几列了。只验真正会让下游出错的东西。
 */
export function normalizeCommitRows(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.rows) ? raw.rows : null;
  if (!list) return { rows: [], errors: ["rows 必须是数组，或是带 rows 数组的对象"] };

  const rows = [];
  const errors = [];
  const seen = new Set();
  list.forEach((item, index) => {
    const where = `第 ${index + 1} 条`;
    if (!item || typeof item !== "object" || Array.isArray(item)) { errors.push(`${where}不是对象`); return; }
    const id = String(item.id || "").trim();
    if (!id) { errors.push(`${where}缺 id`); return; }
    if (seen.has(id)) { errors.push(`${where} id 重复：${id}`); return; }
    seen.add(id);
    if (!String(item.title || "").trim()) { errors.push(`${where}（${id}）缺 title`); return; }

    const state = String(item.state ?? "").trim();
    if (state && !ACCEPTED_STATES.has(state)) {
      // 静默降级成 idle 的话，拼错的状态会变成「没什么可报告的」
      errors.push(`${where}（${id}）state 不认识：${state}。只能是 ${[...ACCEPTED_STATES].join(" / ")}`);
      return;
    }
    rows.push({ ...item, id, state: state || "idle" });
  });
  return { rows, errors };
}

/**
 * 把上一片里人工封存的标记带过来。
 *
 * settled 是人做的决定（「这条定了，别再盯了」），存在条目上而不是覆盖层里，
 * 所以整片重写时会被抹掉。流程作者不该需要知道这件事。
 *
 * 反过来，这一次**显式**写了 `settled: false` 的，尊重流程——政策改期导致条目重新
 * 亮起来，正是它该有的权力。
 */
export function inheritSettled(rows = [], previous = null) {
  const before = new Map(
    (Array.isArray(previous?.rows) ? previous.rows : [])
      .map((row) => [String(row?.id || ""), row])
      .filter(([id]) => id),
  );
  return rows.map((row) => {
    if (Object.prototype.hasOwnProperty.call(row, "settled")) return row;
    const prior = before.get(row.id);
    return prior?.settled === true ? { ...row, settled: true } : row;
  });
}

/**
 * 上一片和这一片的差异，变成变更流里的事件。
 *
 * 只报会改变「人要不要采取行动」的字段。把每个字段的每次抖动都记下来，变更抽屉
 * 会被噪音淹掉，真正的状态翻转反而看不见了。
 */
export function diffRows(previous = null, next = []) {
  const before = new Map(
    (Array.isArray(previous?.rows) ? previous.rows : [])
      .map((row) => [String(row?.id || ""), row])
      .filter(([id]) => id),
  );
  const events = [];
  for (const row of next) {
    const prior = before.get(row.id);
    if (!prior) {
      events.push({ kind: "added", id: row.id, title: row.title, state: row.state });
      continue;
    }
    before.delete(row.id);
    const priorState = String(prior.state || "idle");
    if (priorState !== row.state) {
      events.push({ kind: "state", id: row.id, title: row.title, from: priorState, to: row.state });
    }
    const priorDue = String(prior.due || "");
    const nextDue = String(row.due || "");
    if (priorDue !== nextDue) {
      events.push({ kind: "due", id: row.id, title: row.title, from: priorDue, to: nextDue });
    }
    const priorCurrent = String(prior.current || "");
    const nextCurrent = String(row.current || "");
    if (priorCurrent !== nextCurrent) {
      events.push({ kind: "current", id: row.id, title: row.title, from: priorCurrent, to: nextCurrent });
    }
  }
  // 上一片有、这一片没有 = 这条不再被更新了。不是删除——板上还看得见它，
  // 只是会慢慢变陈旧并被点名。这个事件是唯一能解释「它为什么开始发灰」的线索
  for (const [id, prior] of before.entries()) {
    events.push({ kind: "dropped", id, title: String(prior?.title || id) });
  }
  return events;
}

function readRowsFile(filePath) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    throw fail(`读不到 rows 文件 ${filePath}：${(e && e.message) || e}`);
  }
  if (!text.trim()) throw fail(`rows 文件是空的：${filePath}`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw fail(`rows 文件不是合法 JSON（${filePath}）：${(e && e.message) || e}`);
  }
}

/**
 * 写一片。
 *
 * @param {object} options
 * @param {string} options.board
 * @param {string} options.flowId
 * @param {Array|object} options.rows 已解析的条目，或带 rows 的对象
 * @param {string} [options.actor] 谁在写，缺省取 AGENTFLOW_USER_ID
 * @param {boolean} [options.force] 忽略 writtenBy 冲突
 */
export function commitTrack({
  board,
  flowId,
  rows: rawRows,
  actor = "",
  force = false,
  fetchFailures = 0,
  staleAfterMs = 0,
  flow = null,
  now = Date.now(),
} = {}) {
  if (!isValidBoardId(board)) throw fail(`board 不合法：${board}`);
  if (!isValidShardId(flowId)) throw fail(`flow 不合法：${flowId}`);

  const { rows, errors } = normalizeCommitRows(rawRows);
  if (errors.length) throw fail(`条目有 ${errors.length} 处问题，一条都没写：\n  - ${errors.join("\n  - ")}`);

  const previous = readRadarShard(board, flowId);
  const owner = String(previous?.writtenBy || "").trim();
  const me = String(actor || "").trim();
  // 两边都知道是谁、而且不是同一个人，才算冲突。手工跑 CLI 时没有 AGENTFLOW_USER_ID，
  // 那种情况不该被自己的历史记录挡住
  if (owner && me && owner !== me && !force) {
    throw fail(
      `这一片上次是 ${owner} 写的，你是 ${me}。\n` +
      `两条流程写同一片会互相覆盖，板上会开始自相矛盾。\n` +
      `确认要接手就加 --force，或者换一个 --flow 名字。`,
    );
  }

  /**
   * 抓取失败、这次一条都拿不到时，**保留上一片的条目**。
   *
   * 写空数组的话每一条都会被记成 dropped、然后慢慢发灰——但它们并没有消失，
   * 只是这次没抓到。真实情况是「我这次瞎了」，该表达它的是 fetchFailures，
   * 不是把已知的事实抹掉。
   *
   * 反过来，抓取**成功**而结果确实为空，那就是真的空，照常写。
   */
  const failures = Number(fetchFailures) || 0;
  const salvaged = !rows.length && failures > 0 && Array.isArray(previous?.rows) && previous.rows.length;
  const finalRows = salvaged ? previous.rows : rows;

  const withSettled = salvaged ? finalRows : inheritSettled(finalRows, previous);
  // 保留上一片时不产事件：什么都没变，变更流不该出现一次抓取失败留下的假动静
  const events = salvaged ? [] : diffRows(previous, withSettled);
  const updatedAt = new Date(now).toISOString();

  const written = writeRadarShard(board, flowId, {
    // 保留下来的条目带着原来的 lastSeenAt：这次并没有真的看见它们，刷新时间戳
    // 等于把「已经三天没更新了」这个事实抹掉，陈旧告警就永远不会响
    rows: withSettled,
    updatedAt,
    fetchFailures: failures,
    ...(Number(staleAfterMs) > 0 ? { staleAfterMs: Number(staleAfterMs) } : {}),
    ...(flow ? { flow } : {}),
    ...(me ? { writtenBy: me } : owner ? { writtenBy: owner } : {}),
  });
  if (!written.ok) throw fail(written.error || "写入失败");

  for (const event of events) appendRadarEvent(board, { ...event, flowId, by: me || "flow" });

  return { ok: true, board, flowId, path: written.path, rows: withSettled.length, events, salvaged: Boolean(salvaged) };
}

function printBoards() {
  const boards = listRadarBoards({ scope: "all" });
  if (!boards.length) { console.log("还没有板。"); return 0; }
  for (const item of boards) {
    const parts = [
      item.board.padEnd(24),
      String(item.counts.risk || 0).padStart(3) + " 危",
      String(item.counts.warn || 0).padStart(3) + " 警",
      `${item.flows.length} 片`,
    ];
    if (item.staleFlows) parts.push(`${item.staleFlows} 片哑了`);
    if (item.fetchFailures) parts.push(`${item.fetchFailures} 次抓取失败`);
    console.log(parts.join("  "));
  }
  return 0;
}

function printBoard(board, asJson) {
  if (!isValidBoardId(board)) throw fail(`board 不合法：${board}`);
  const loaded = readRadarBoard(board, { scope: "all" });
  if (!loaded) throw fail(`没有这块板：${board}`);
  if (asJson) { console.log(JSON.stringify(loaded, null, 2)); return 0; }
  console.log(`${loaded.title}（${board}）  ${loaded.rows.length} 条  ${loaded.flows.length} 片`);
  for (const row of loaded.rows) {
    const days = row.daysLeft === null ? "   -" : String(row.daysLeft).padStart(4);
    const marks = [row.settled ? "封存" : "", row.overdue ? "过期" : "", row.staleItem ? "陈旧" : ""].filter(Boolean);
    console.log(
      `  ${row.state.padEnd(5)} ${days}天  ${String(row.id).padEnd(28)} ${row.title}` +
      (marks.length ? `  [${marks.join(" ")}]` : ""),
    );
  }
  return 0;
}

export async function runTrackCommand(argv = []) {
  const { flags, positional } = parseTrackArgs(argv);
  const action = String(positional[0] || "").trim();

  if (!action || action === "help") {
    console.log([
      "agentflow track <命令>",
      "",
      "  commit --board=<板> --flow=<流程> --rows=<json文件>   写一片（流程里用）",
      "         [--fetch-failures=N] [--stale-after-ms=N] [--force]",
      "  list                                                 列出所有板",
      "  show <板> [--json]                                   看一块板的条目",
      "  events <板> [--limit=N]                              看变更流",
      "  rm <板> [--flow=<流程>]                              删一块板，或只删一片",
    ].join("\n"));
    return 0;
  }

  if (action === "commit") {
    const board = String(flags.board || "");
    const flowId = String(flags.flow || flags.flowId || "");
    const rowsPath = String(flags.rows || "");
    if (!board || !flowId || !rowsPath) throw fail("commit 需要 --board、--flow、--rows");
    const result = commitTrack({
      board,
      flowId,
      rows: readRowsFile(rowsPath),
      actor: String(process.env.AGENTFLOW_USER_ID || ""),
      force: flags.force === true || flags.force === "true",
      fetchFailures: flags["fetch-failures"] ?? flags.fetchFailures ?? 0,
      staleAfterMs: flags["stale-after-ms"] ?? flags.staleAfterMs ?? 0,
    });
    if (result.salvaged) {
      console.log(`抓取失败，保留上一次的 ${result.rows} 条：${board}/${flowId}`);
      return 0;
    }
    const changed = result.events.length ? `，${result.events.length} 处变更` : "，无变更";
    console.log(`已写入 ${board}/${flowId}：${result.rows} 条${changed}`);
    return 0;
  }

  if (action === "list") return printBoards();
  if (action === "show") return printBoard(String(positional[1] || flags.board || ""), flags.json === true);

  if (action === "events") {
    const board = String(positional[1] || flags.board || "");
    if (!isValidBoardId(board)) throw fail(`board 不合法：${board}`);
    const limit = Number(flags.limit) > 0 ? Number(flags.limit) : 50;
    const events = readRadarEvents(board, { limit });
    if (!events.length) { console.log("还没有变更记录。"); return 0; }
    for (const event of events) {
      const change = event.from !== undefined ? ` ${event.from || "空"} → ${event.to || "空"}` : "";
      console.log(`  ${String(event.at || "").slice(0, 19)}  ${String(event.kind || "").padEnd(8)} ${event.id || ""}${change}`);
    }
    return 0;
  }

  if (action === "rm") {
    const board = String(positional[1] || flags.board || "");
    if (!isValidBoardId(board)) throw fail(`board 不合法：${board}`);
    if (!listRadarBoardIds().includes(board)) throw fail(`没有这块板：${board}`);
    const flowId = String(flags.flow || "");
    if (flowId) {
      if (!isValidShardId(flowId)) throw fail(`flow 不合法：${flowId}`);
      const done = rmRadarShard(board, flowId);
      if (!done.ok) throw fail(done.error || "删除失败");
      console.log(`已删除 ${board}/${flowId}`);
      return 0;
    }
    const done = rmRadarBoard(board);
    if (!done.ok) throw fail(done.error || "删除失败");
    console.log(`已删除整块板 ${board}`);
    return 0;
  }

  throw fail(`不认识的命令：${action}。看 \`agentflow track help\``);
}
