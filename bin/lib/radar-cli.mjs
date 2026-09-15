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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createEmptyFlow, resolveFlowDirForWrite } from "./flow-write.mjs";
import { autoCommit, readTrackerDocs, writeTrackerDoc } from "./radar-docs.mjs";
import { applyGate } from "./radar-gate.mjs";
import { writeWorkspaceGraph } from "./workspace-server.mjs";
import { materializeFlow, planToPending } from "./radar-plan-apply.mjs";
import { buildRadarPlanPrompt, normalizeRadarPlan, parseRadarPlan } from "./radar-planner.mjs";
import {
  RADAR_STATES,
  appendRadarEvent,
  createRadarBoard,
  setRadarBoardArchived,
  isValidBoardId,
  isValidShardId,
  listRadarBoardIds,
  listRadarBoards,
  ownsViolations,
  radarBoardDir,
  radarPlanFile,
  PENDING_PLAN_KEY,
  readRadarPending,
  writeRadarPending,
  resolveRadarPending,
  readRadarBoard,
  readRadarEvents,
  readRadarShard,
  rmRadarBoard,
  rmRadarShard,
  writeRadarBoardMeta,
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

/**
 * 上次由**人**改过的字段，精确到行。
 *
 * 板目录是 git 仓库时，`git blame` 就是权威的作者记录——不用往 frontmatter 里塞
 * `stateBy: human` 这种自制标记。约定：agent 提交时 author 设成 `agentflow`，其余当成人。
 *
 * **必须按行 blame，不能按文件。** 按文件的话，一次 `git commit -a` 就会把所有文件的
 * 所有字段都标成人改的，门禁当场变成一堵墙——这是实测撞出来的，不是假想。
 *
 * 拿不到 git（不是仓库、没装 git）返回空集：**降级成不拦**，而不是全拦。
 */
function humanEditedFields(dir) {
  const fields = new Set();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
  } catch {
    return fields;
  }
  for (const name of files) {
    const id = name.replace(/\.md$/, "");
    let text = "";
    try {
      // 必须 blame HEAD，不能 blame 工作区：这一轮待判定的改动本身还没提交，
      // 对未提交的行 git 会把作者填成本机 git 用户名——那会把 agent 刚改的每一行
      // 都算成人改的，门禁再次变成一堵墙。基线是「上一次提交时这行是谁写的」。
      text = execFileSync("git", ["blame", "--line-porcelain", "HEAD", "--", name], {
        cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      continue; // 这个文件还没提交过，或者根本不是 git 仓库
    }
    let author = "";
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("author ")) { author = line.slice(7).trim(); continue; }
      // porcelain 里正文行以 tab 开头
      if (!line.startsWith("\t")) continue;
      const content = line.slice(1);
      const match = content.match(/^([A-Za-z_][\w-]*):/);
      if (!match) continue;
      if (author && author !== "agentflow") fields.add(`${id}:${match[1]}`);
    }
  }
  return fields;
}

/** 待审批的人话版。审批页和企微通知看到的都是它 */
function heldMarkdown(board, flowId, held = []) {
  const lines = [`**${board}** 有 ${held.length} 处改动等确认（来自 ${flowId}）`, ""];
  for (const event of held) {
    const change = event.from !== undefined
      ? `\`${event.from || "空"}\` → \`${event.to || "空"}\``
      : "";
    lines.push(`- **${event.id}** ${event.kind} ${change}`);
    lines.push(`  ${event.reason}`);
  }
  lines.push("", "在确认之前，板上这几个字段仍然是旧值；同一条目上其它改动已经落地。");
  return lines.join("\n");
}

/** 待审批落在板目录里，和分片并列——它是板的状态，不是某次运行的副产品 */
function writePending(board, flowId, held = []) {
  try {
    const dir = path.join(radarBoardDir(board));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "_pending.json");
    const prev = readRadarPending(board);
    prev[flowId] = { at: new Date().toISOString(), held };
    fs.writeFileSync(file, `${JSON.stringify(prev, null, 2)}\n`, "utf-8");
  } catch (e) {
    console.error(`待审批写不进去：${(e && e.message) || e}`);
  }
}

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

/**
 * `--owns=a,b` / `--apps=x,y` 这类逗号列表。
 *
 * 没传返回 null 而不是空数组：空数组在 commitTrack 里意味着「没有契约」，
 * 而没传的语义是「沿用上一片声明过的」。两者混起来会让一次忘带 --owns 的手工 commit
 * 悄悄把契约卸掉。
 */
function parseOwns(value) {
  if (value === undefined || value === null || value === true) return null;
  const list = String(value).split(",").map((item) => item.trim()).filter(Boolean);
  return list.length ? list : null;
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
  gate = false,
  humanFields = new Set(),
  owns = null,
  covers = null,
} = {}) {
  if (!isValidBoardId(board)) throw fail(`board 不合法：${board}`);
  if (!isValidShardId(flowId)) throw fail(`flow 不合法：${flowId}`);

  const { rows, errors } = normalizeCommitRows(rawRows);
  if (errors.length) throw fail(`条目有 ${errors.length} 处问题，一条都没写：\n  - ${errors.join("\n  - ")}`);

  const previous = readRadarShard(board, flowId);

  /**
   * owns 契约：这一片只能写自己声明负责的 id。
   *
   * 这一层挡的不是「判断错了」——那是门禁的活。它挡的是**越权**：模型把 Likee 的结论
   * 写到 BigoLive 的条目上时，行 id 完全合法、状态也合法，事后只能靠板上标红发现，
   * 而那时两片已经在互相覆盖了。
   *
   * 没传就沿用上一片声明过的。否则一次忘了带 --owns 的手工 commit 会把契约悄悄卸掉，
   * 而卸掉契约恰恰不会有任何报错——最危险的那种默认值。
   */
  const declaredOwns = Array.isArray(owns) && owns.length
    ? owns.map((pattern) => String(pattern).trim()).filter(Boolean)
    : (Array.isArray(previous?.owns) ? previous.owns.map(String) : []);
  // covers 和 owns 一样，不传就沿用上一片声明过的
  const declaredCovers = Array.isArray(covers) && covers.length
    ? covers.map((pattern) => String(pattern).trim()).filter(Boolean)
    : (Array.isArray(previous?.covers) ? previous.covers.map(String) : []);
  const trespass = ownsViolations(rows, declaredOwns);
  if (trespass.length) {
    throw fail(
      `${trespass.length} 条越界，整次没写：\n  - ${trespass.join("\n  - ")}\n` +
      `这一片声明只负责 ${declaredOwns.join(" / ")}。\n` +
      `别的条目由别的流程认领——写进来就是重复认领，板上会开始自相矛盾。`,
    );
  }
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
  const allEvents = salvaged ? [] : diffRows(previous, withSettled);

  /**
   * 门禁：会让告警闭嘴的、覆盖人工判断的、让条目消失的，拦下来等人点头；其余照常落地。
   *
   * 被拦的只回退那几个字段，不是整条不写——否则一条待审批会把同一条目上其它本该落地的
   * 改动一起卡住，板照样是旧的，而发现陈旧正是这套东西存在的意义。
   */
  const gated = gate
    ? applyGate(previous, withSettled, allEvents, { humanFields })
    : { rows: withSettled, applied: allEvents, held: [] };
  const finalWrite = gated.rows;
  const events = gated.applied;
  const updatedAt = new Date(now).toISOString();

  const written = writeRadarShard(board, flowId, {
    // 保留下来的条目带着原来的 lastSeenAt：这次并没有真的看见它们，刷新时间戳
    // 等于把「已经三天没更新了」这个事实抹掉，陈旧告警就永远不会响
    rows: finalWrite,
    updatedAt,
    fetchFailures: failures,
    ...(Number(staleAfterMs) > 0 ? { staleAfterMs: Number(staleAfterMs) } : {}),
    ...(flow ? { flow } : {}),
    ...(declaredOwns.length ? { owns: declaredOwns } : {}),
    ...(declaredCovers.length ? { covers: declaredCovers } : {}),
    ...(me ? { writtenBy: me } : owner ? { writtenBy: owner } : {}),
  });
  if (!written.ok) throw fail(written.error || "写入失败");

  for (const event of events) appendRadarEvent(board, { ...event, flowId, by: me || "flow" });

  return {
    ok: true, board, flowId, path: written.path, rows: finalWrite.length,
    events, held: gated.held, salvaged: Boolean(salvaged), owns: declaredOwns, covers: declaredCovers,
  };
}

function printBoards(includeArchived = false) {
  const boards = listRadarBoards({ scope: "all", includeArchived });
  if (!boards.length) { console.log("还没有板。"); return 0; }
  for (const item of boards) {
    const parts = [
      item.board.padEnd(24),
      String(item.counts.risk || 0).padStart(3) + " 危",
      String(item.counts.warn || 0).padStart(3) + " 警",
      `${item.flows.length} 片`,
    ];
    if (item.archived) parts.push("已归档");
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
    // 没有截止日就整块留白。`-` 后面跟个「天」会被读成「负几天」，
    // 而「没有日期」和「还剩负几天」是完全相反的两件事
    const days = (row.daysLeft === null ? "无期限" : `${row.daysLeft}天`).padStart(7);
    const marks = [row.settled ? "封存" : "", row.overdue ? "过期" : "", row.staleItem ? "陈旧" : ""].filter(Boolean);
    console.log(
      `  ${row.state.padEnd(5)} ${days}  ${String(row.id).padEnd(28)} ${row.title}` +
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
      "         [--owns=<glob,glob>] [--covers=<glob,glob>]   owns=只准写这些 id；covers=替哪些父项作答（缺席靠它判）",
      "  create <板> [--title=<标题>]                          建一块空板",
      "  sync --board --flow --dir=<trackers 目录> [--gate]    从 trackers/*.md 同步（agent 改文件，这里校验）",
      "       [--flow-ref=<流程 id>] [--owns=<..>] [--covers=<..>] 分片名和流程不同名时要带 flow-ref",
      "  trains --board [--scope=<分片>] --file=<json>        刷新版本车（只写板级元信息，不认领条目）",
      "  export --board --flow --dir=<trackers 目录>          把一条流程那一片导成 trackers/*.md",
      "  list [--archived]                                    列出所有板",
      "  archive <板> [--undo]                                归档 / 取消归档（不是删除）",
      "  pending <板>                                         看有哪些改动等确认",
      "  approve --board --flow [--id=<条目>]                  批准并写入",
      "  reject  --board --flow [--id=<条目>]                  驳回（不写，但记一条事件）",
      "  plan apply --board --plan=<plan.md> --workspace=<板目录>  把指挥官的计划提案成待审批",
      "  plan prompt --out=<路径> [--board=<板>] [--ask=<一句话>]  组装规划提示词（radar-plan 流程里用）",
      "  plan check --ok=<路径> --report=<路径> --plan=<路径>     校验模型给的计划（radar-plan 流程里用）",
      "             [--run-id=<id>]                             结果按 runId 存一份给服务端取回",
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
      owns: parseOwns(flags.owns),
      covers: parseOwns(flags.covers),
      flow: String(flags["flow-ref"] || "").trim()
        ? { flowId: String(flags["flow-ref"]).trim(), flowSource: String(flags["flow-source"] || "user") }
        : null,
    });
    if (result.salvaged) {
      console.log(`抓取失败，保留上一次的 ${result.rows} 条：${board}/${flowId}`);
      return 0;
    }
    const changed = result.events.length ? `，${result.events.length} 处变更` : "，无变更";
    console.log(`已写入 ${board}/${flowId}：${result.rows} 条${changed}`);
    return 0;
  }

  if (action === "create") {
    const board = String(positional[1] || flags.board || "");
    const created = createRadarBoard(board, {
      title: String(flags.title || ""),
      icon: String(flags.icon || "radar"),
      createdBy: String(process.env.AGENTFLOW_USER_ID || ""),
    });
    if (!created.ok) throw fail(created.error || "建板失败");
    console.log(`已建板 ${board}。现在让流程往里写：`);
    console.log(`  agentflow track commit --board=${board} --flow=<流程> --rows=<json文件>`);
    return 0;
  }

  if (action === "archive") {
    const board = String(positional[1] || flags.board || "");
    if (!isValidBoardId(board)) throw fail(`board 不合法：${board}`);
    const undo = flags.undo === true || flags.undo === "true";
    const saved = setRadarBoardArchived(board, !undo);
    if (!saved.ok) throw fail(saved.error || "操作失败");
    // 说清楚它没被删：这是归档和 rm 唯一的区别，也是人最需要确认的一点
    console.log(undo
      ? `已取消归档 ${board}`
      : `已归档 ${board}。分片、变更记录、告警状态都留着，agentflow track archive ${board} --undo 可恢复`);
    return 0;
  }

  /**
   * 刷新某个 app 的版本车。
   *
   * 单独一个入口，因为它**一条条目都不认领**：版本车是板级事实（哪个版本什么时候封包），
   * 不属于任何一条政策。让排期流程走 commit 的话，它得先声明 owns、再写一批假条目，
   * 然后这些假条目会跟真的政策条目一起出现在板上。
   *
   * 只替换这个 app 名下的车，别的 app 和通用车原样留着——两个 app 的排期流程各跑各的，
   * 不该互相清空。
   */
  if (action === "trains") {
    const board = String(flags.board || "");
    // 限定到某一片：写这些条目的那条流程有自己的发版节奏。
    // 不是「哪个 app」——板不认识业务，只认识分片
    const scope = String(flags.scope || "").trim();
    const file = String(flags.file || flags.rows || "");
    if (!board || !file) throw fail("trains 需要 --board 和 --file");
    if (!isValidBoardId(board)) throw fail(`board 不合法：${board}`);
    const parsed = readRowsFile(file);
    const incoming = (Array.isArray(parsed) ? parsed : Array.isArray(parsed?.trains) ? parsed.trains : null);
    if (!incoming) throw fail("版本车文件要是数组，或是带 trains 数组的对象");
    const next = [];
    const bad = [];
    incoming.forEach((item, index) => {
      const version = String(item?.version || "").trim();
      const cutoff = String(item?.cutoff || "").trim();
      if (!version || !cutoff) { bad.push(`第 ${index + 1} 班缺 version 或 cutoff`); return; }
      if (!Number.isFinite(Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(cutoff) ? `${cutoff}T00:00:00` : cutoff))) {
        bad.push(`第 ${index + 1} 班（${version}）cutoff 不是日期：${cutoff}`);
        return;
      }
      next.push({ version, cutoff, ...(scope ? { scope } : {}) });
    });
    if (bad.length) throw fail(`版本车有 ${bad.length} 处问题，一班都没写：\n  - ${bad.join("\n  - ")}`);

    const loaded = readRadarBoard(board, { scope: "all" });
    if (!loaded) throw fail(`没有这块板：${board}`);
    const kept = (loaded.trains || []).filter((train) => {
      const owner = String(train?.scope || "").trim();
      return scope ? owner !== scope : Boolean(owner);
    });
    const written = writeRadarBoardMeta(board, {
      title: loaded.title,
      icon: loaded.icon,
      ...(loaded.archived ? { archived: true } : {}),
      spec: loaded.spec,
      trains: [...kept, ...next],
    });
    if (!written.ok) throw fail(written.error || "写不进板级元信息");
    appendRadarEvent(board, {
      kind: "trains",
      id: scope || "*",
      title: `${scope || "通用"} 版本车 ${next.length} 班`,
      by: String(process.env.AGENTFLOW_USER_ID || "flow"),
    });
    console.log(`已更新 ${board} 的版本车（${scope || "通用"}）：${next.length} 班，保留其它 ${kept.length} 班`);
    for (const train of next) console.log(`  ${train.version.padEnd(12)} 封包 ${train.cutoff}`);
    return 0;
  }

  /**
   * 从 `trackers/*.md` 同步到板。
   *
   * 和 `commit` 的区别只在入口：commit 吞一份 agent 直接产出的 JSON，sync 读一个目录。
   * 校验、继承 settled、diff 事件、writtenBy 全部共用——**校验不能因为换了入口就松掉**，
   * 那一层正是挡住「state 拼成 warning 变成假合格证」的东西。
   */
  if (action === "sync") {
    const board = String(flags.board || "");
    const flowId = String(flags.flow || flags.flowId || "");
    const dir = String(flags.dir || "");
    if (!board || !flowId || !dir) throw fail("sync 需要 --board、--flow、--dir");
    const { rows, errors, notes } = readTrackerDocs(dir);
    for (const note of notes) console.log(`  ${note}`);
    if (errors.length) throw fail(`${errors.length} 个文件有问题，一条都没写：\n  - ${errors.join("\n  - ")}`);
    if (!rows.length) throw fail(`${dir} 下没有带 frontmatter 的 .md`);

    const result = commitTrack({
      board,
      flowId,
      rows,
      actor: String(process.env.AGENTFLOW_USER_ID || ""),
      force: flags.force === true || flags.force === "true",
      fetchFailures: flags["fetch-failures"] ?? 0,
      staleAfterMs: flags["stale-after-ms"] ?? 0,
      gate: flags.gate === true || flags.gate === "true",
      owns: parseOwns(flags.owns),
      covers: parseOwns(flags.covers),
      humanFields: humanEditedFields(dir),
      // 分片名可以和跑它的那条流程不同名。不记下来的话，协作视图和定时归属
      // 都会按分片名去找流程，找不到就显示「从没跑过」
      flow: String(flags["flow-ref"] || "").trim()
        ? { flowId: String(flags["flow-ref"]).trim(), flowSource: String(flags["flow-source"] || "user") }
        : null,
    });
    const changed = result.events.length ? `，${result.events.length} 处落地` : "，无变更";
    console.log(`已同步 ${board}/${flowId}：${result.rows} 条${changed}`);
    for (const event of result.events) {
      const change = event.from !== undefined ? ` ${event.from || "空"} → ${event.to || "空"}` : "";
      console.log(`  ${String(event.kind).padEnd(8)} ${event.id}${change}`);
    }
    if (result.held.length) {
      writePending(board, flowId, result.held);
      // 给 control.interrupt 吃的正文：人话的 diff，不是 JSON。
      // 审批页和企微上看到的就是这一段，看不懂就只能点「通过」了事
      const markdown = heldMarkdown(board, flowId, result.held);
      const out = String(flags["held-out"] || "");
      if (out) fs.writeFileSync(out, markdown, "utf-8");
      console.log(`\n${result.held.length} 处等人点头（板上已标为待审批，值还是旧的）：`);
      console.log(markdown.split("\n").map((line) => `  ${line}`).join("\n"));
    }
    return 0;
  }

  /**
   * 把**一条流程那一片**导成文件。
   *
   * 必须按片导，不能导板的合并视图，两个原因：
   *
   * 1. 分片是原始事实，板是**推导结果**——`decorateRow` 会把 `unknown` 归一成 `idle` 给页面用。
   *    把推导值写回文件，再 sync 回去，`unknown`（没查出来）就被悄悄改成了 `idle`（没什么可报告的）。
   *    这正是这套设计最在意的那个区别，不能在一次往返里丢掉。
   * 2. 板上的条目来自多片。导合并视图会让 sync 把别的流程的条目写进这一片，就是重复认领。
   */
  if (action === "export") {
    const board = String(flags.board || "");
    const flowId = String(flags.flow || flags.flowId || "");
    const dir = String(flags.dir || "");
    if (!board || !flowId || !dir) throw fail("export 需要 --board、--flow、--dir");
    const shard = readRadarShard(board, flowId);
    if (!shard) throw fail(`没有这一片：${board}/${flowId}`);
    let written = 0;
    for (const row of shard.rows || []) {
      // lastSeenAt 是运行时盖的时间戳，不是人写的事实，不进文件
      const { lastSeenAt, doc, docLines, ...core } = row;
      const out = writeTrackerDoc(dir, core);
      if (out.ok) written += 1;
      else console.log(`  跳过 ${row.id}：${out.error}`);
    }
    if (autoCommit(dir, `track export: ${board}/${flowId} ${written} 条`)) {
      console.log(`已导出 ${written} 条到 ${dir}（来自 ${board}/${flowId}），并以 agentflow 身份提交`);
    } else {
      console.log(`已导出 ${written} 条到 ${dir}（来自 ${board}/${flowId}）`);
    }
    return 0;
  }

  /**
   * 处理挂起的改动。
   *
   * 批准 = 把待审批里的目标值真的写进分片；驳回 = 不写，但**记一条事件**。
   * 驳回本身是信息：agent 连着三轮想把同一条改成 ok 都被驳回，说明它的判定规则该改了，
   * 而不是让它每轮再试一次。静默丢弃会把这个信号一起丢掉。
   */
  /**
   * 把指挥官的计划提案成待审批。
   *
   * 不直接建流程：一条每小时跑的 agent 流程是在烧钱，而且它认领了条目就会开始覆盖
   * 别人写的值。更要紧的是**图仍然是授权边界**——agent 提议图，人批准图，图约束执行。
   */
  if (action === "plan") {
    const sub = String(positional[1] || "").trim();

    /**
     * 槽值可能是内容，也可能是路径。
     *
     * 运行时把超过阈值的输入物化成 `inputs/<槽>/<槽>.json`，**值就变成了相对路径**；
     * 没超过阈值的还是原文。于是同一个槽短的时候是内容、长的时候是路径——
     * 不认这一层的话，校验节点会拿着一行 `inputs/raw/raw.json` 去解析 JSON，
     * 然后报「模型返回的不是可解析的 JSON」，把运行时的行为诬赖给模型。
     */
    const slotText = (value) => {
      const text = String(value ?? "");
      const oneLine = text.trim();
      if (oneLine && !oneLine.includes("\n") && oneLine.length < 400) {
        try {
          const candidate = path.resolve(process.cwd(), oneLine);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return fs.readFileSync(candidate, "utf-8");
          }
        } catch {
          // 当成普通文本
        }
      }
      return text;
    };

    /**
     * 组装规划提示词。规划跑在 `radar-plan` 流程里，提示词得由一个节点算出来——
     * 板的现状（有几条流程、哪些条目没人认领、谁哑了）每次都不一样，写死在图里就永远是旧的。
     */
    if (sub === "prompt") {
      const board = String(flags.board || "").trim();
      const outPath = String(flags.out || "");
      if (!outPath) throw fail("plan prompt 需要 --out");
      if (board && !isValidBoardId(board)) throw fail(`board 不合法：${board}`);
      const ask = slotText(flags.ask || process.env.AGENTFLOW_RADAR_ASK || "").trim();
      if (!ask) throw fail("plan prompt 需要 --ask（或环境变量 AGENTFLOW_RADAR_ASK）");
      const loaded = board ? readRadarBoard(board, { scope: "all" }) : null;
      fs.writeFileSync(outPath, buildRadarPlanPrompt({ board: loaded, ask, boardId: board }), "utf-8");
      console.log(board ? `已按 ${board} 的现状组装提示词` : "已组装提示词（新板，从零规划）");
      return 0;
    }

    /**
     * 校验模型给的计划，拆成三个槽。
     *
     * **本节点总是 exit 0**：解析不出来不是这一步失败，是下一步要让它重发的事。
     * 真正的失败只有「文件写不出去」。和 `new` 流程里的 lint 节点同一个契约。
     */
    if (sub === "check") {
      const okPath = String(flags.ok || "");
      const reportPath = String(flags.report || "");
      const planPath = String(flags.plan || "");
      if (!okPath || !reportPath || !planPath) throw fail("plan check 需要 --ok、--report、--plan");
      const board = String(flags.board || "").trim();
      if (board && !isValidBoardId(board)) throw fail(`board 不合法：${board}`);

      // 大段 JSON 不走命令行：`${slot}` 会把整份计划内联进 shell
      let raw = String(flags.raw || "");
      if (!raw) {
        try {
          const inputs = JSON.parse(String(process.env.AGENTFLOW_INPUTS_JSON || "{}"));
          raw = String(inputs.raw || inputs.result || Object.values(inputs).find((v) => typeof v === "string" && v.trim()) || "");
        } catch { raw = ""; }
      }
      raw = slotText(raw);

      /**
       * 把结果留一份到雷达自己的数据目录，服务端按 runId 取回。
       *
       * 一次运行一份，不是「最新那份」：两次规划并行时，后跑完的会盖掉前一个，
       * 于是人拿到的是别人那份计划——而且看不出来。
       */
      const runId = String(flags["run-id"] || flags.runId || process.env.AGENTFLOW_RUN_ID || "");
      const recordPlan = (data) => {
        const file = radarPlanFile(runId);
        if (!file) return;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
          runId, at: new Date().toISOString(), board, ...data,
        }, null, 2), "utf-8");
      };

      const parsed = parseRadarPlan(raw);
      if (!parsed.ok) {
        fs.writeFileSync(okPath, "false", "utf-8");
        fs.writeFileSync(reportPath, [
          `# 计划没解析出来`, "",
          parsed.error, "",
          "## 它上一轮的输出（截断）", "",
          "```", String(raw || "(空)").slice(0, 4000), "```", "",
        ].join("\n"), "utf-8");
        fs.writeFileSync(planPath, "{}", "utf-8");
        recordPlan({ ok: false, error: parsed.error, report: fs.readFileSync(reportPath, "utf-8") });
        console.log(`计划未通过：${parsed.error}，交给下游重发`);
        return 0;
      }

      const loaded = board ? readRadarBoard(board, { scope: "all" }) : null;
      const normalized = normalizeRadarPlan(parsed.plan, loaded);
      const usable = normalized.flows.length > 0;
      fs.writeFileSync(planPath, JSON.stringify(normalized, null, 2), "utf-8");
      fs.writeFileSync(okPath, usable ? "true" : "false", "utf-8");
      fs.writeFileSync(reportPath, [
        usable ? `# 计划已就绪` : `# 计划解析出来了，但没有一条可用的流程`, "",
        normalized.summary || "(没有摘要)", "",
        `- 追踪项 ${normalized.items.length} 条`,
        `- 流程 ${normalized.flows.length} 条`,
        normalized.board?.title ? `- 板名：${normalized.board.title}（id ${normalized.board.id || "未定"}）` : null,
        "",
        ...(normalized.warnings.length ? ["## 校验提醒", "", ...normalized.warnings.map((w) => `- ${w}`), ""] : []),
      ].filter((line) => line !== null).join("\n"), "utf-8");
      recordPlan(usable
        ? { ok: true, plan: normalized }
        : { ok: false, error: "计划里没有一条可用的流程", report: fs.readFileSync(reportPath, "utf-8") });
      console.log(usable
        ? `计划通过：${normalized.items.length} 条追踪项 / ${normalized.flows.length} 条流程`
        : "计划里没有一条可用的流程，交给下游重来");
      return 0;
    }

    if (sub !== "apply") throw fail("只支持 `track plan apply` / `plan prompt` / `plan check`");
    const board = String(flags.board || "");
    const planPath = String(flags.plan || "");
    const workspacePath = String(flags.workspace || flags.dir || "");
    if (!isValidBoardId(board)) throw fail(`board 不合法：${board}`);
    if (!planPath || !workspacePath) throw fail("plan apply 需要 --board、--plan、--workspace");

    let text = "";
    try { text = fs.readFileSync(planPath, "utf-8"); }
    catch (e) { throw fail(`读不到计划文件 ${planPath}：${(e && e.message) || e}`); }
    const parsed = parseRadarPlan(text);
    if (!parsed.ok) throw fail(`计划不是合法 JSON：${parsed.error}`);

    const loaded = readRadarBoard(board, { scope: "all" });
    const normalized = normalizeRadarPlan(parsed.plan, loaded);
    for (const warning of normalized.warnings || []) console.log(`  ⚠ ${warning}`);

    const held = planToPending(normalized, { board, workspacePath });
    if (!held.length) { console.log("计划里没有要建或要改的流程。"); return 0; }

    const pending = readRadarPending(board);
    const key = PENDING_PLAN_KEY;
    pending[key] = { at: new Date().toISOString(), held: [...(pending[key]?.held || []), ...held] };
    writeRadarPending(board, pending);
    console.log(`${held.length} 条流程提案等确认：`);
    for (const item of held) console.log(`  ${item.id}\n    ${item.reason}`);
    return 0;
  }

  if (action === "approve" || action === "reject") {
    const board = String(flags.board || "");
    const flowId = String(flags.flow || flags.flowId || "");
    if (!isValidBoardId(board)) throw fail(`board 不合法：${board}`);
    if (!flowId) throw fail(`${action} 需要 --flow`);
    const result = resolveRadarPending(board, flowId, {
      action,
      ids: String(flags.id || "").trim() ? [String(flags.id).trim()] : [],
      by: String(process.env.AGENTFLOW_USER_ID || flags.by || "").trim(),
    });
    if (!result.ok) throw fail(result.error || "处理失败");
    for (const item of result.flowProposals || []) {
      if (action !== "approve") { console.log(`  已驳回流程提案 ${item.id}`); continue; }
      const out = materializeFlow(
        { ...item.flowSpec, action: item.action },
        {
          workspaceRoot: process.cwd(),
          userId: String(process.env.AGENTFLOW_USER_ID || ""),
          createEmptyFlow, writeWorkspaceGraph, resolveFlowDirForWrite,
        },
      );
      console.log(out.ok
        ? `  已建流程 ${out.flowId}（默认停用，去定时任务页开启）`
        : `  流程 ${item.id} 没建成：${out.error}`);
    }
    console.log(`${action === "approve" ? "已批准并写入" : "已驳回（未写入）"} ${result.resolved.length} 处：`);
    for (const item of result.resolved) {
      console.log(`  ${item.id} ${item.kind} ${item.from ?? ""} → ${item.to ?? ""}`);
    }
    if (result.remaining) console.log(`还剩 ${result.remaining} 处待处理`);
    return 0;
  }

  /** 看有哪些待审批 */
  if (action === "pending") {
    const board = String(positional[1] || flags.board || "");
    if (!isValidBoardId(board)) throw fail(`board 不合法：${board}`);
    const pending = readRadarPending(board);
    const flows = Object.keys(pending);
    if (!flows.length) { console.log("没有待审批的改动。"); return 0; }
    for (const flowId of flows) {
      console.log(`${flowId}（${String(pending[flowId].at || "").slice(0, 19)}）`);
      for (const item of pending[flowId].held || []) {
        console.log(`  ${String(item.kind).padEnd(8)} ${item.id}  ${item.from ?? ""} → ${item.to ?? ""}`);
        console.log(`           ${item.reason}`);
      }
    }
    return 0;
  }

  if (action === "list") return printBoards(flags.archived === true || flags.archived === "true");
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
