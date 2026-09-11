/**
 * 雷达：定时流程产出的「专项监控板」。
 *
 * 一块板 = 一份 spec（怎么画）+ 一组 row（画什么）。页面只认 spec，不认业务——所以合规追踪、
 * 证书到期、线上问题共用同一个渲染器，加一个领域不用动前端。
 *
 * 板文件由流程写，但**有效截止日不归流程算**：
 *
 *   有效截止日 = min(政策截止日, 最后一班赶得上的版本封包日)
 *
 * 政策写 11 月 1 日，而 v43 在 10 月 25 日封包，那 10 月 25 日才是真正的墙。这一步放在这里
 * 统一算，而不是让每条流程各算一遍——算错一次，整块板的排序和提醒阈值就全是错的。
 *
 * 一块板可以由**多条流程**喂。每条流程只写自己那一片，读的时候合并：
 *
 *   radar/boards/<board>/_board.json     板级：标题、版本车、spec（可选）
 *   radar/boards/<board>/<flowId>.json   每条流程自己一片
 *   radar/events/<board>.jsonl           变更流，append-only
 *
 * 为什么分片而不是整份覆盖：两条流程写同一个文件会互相清空，后跑的把先跑的条目抹掉，
 * 而且**一点报错都不会有**。分片还顺带换来一件事——能看出某一片多久没更新了，
 * 也就是「某条流程哑了」。整份覆盖的话，哑掉的流程和「这次没有条目」长得一模一样。
 */
import fs from "fs";
import path from "path";

import { getAgentflowDataRoot } from "./paths.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 行的状态取值，顺序即严重度：越靠前越该先看 */
export const RADAR_STATES = ["risk", "warn", "idle", "ok"];
/** 变更流一次最多回多少条：这是给人看的近况，不是审计日志 */
const EVENTS_DEFAULT_LIMIT = 40;
/** 一片多久没更新就算哑了。流程自己知道 cron，可以在片里写 staleAfterMs 覆盖它 */
const DEFAULT_STALE_AFTER_MS = 36 * 60 * 60 * 1000;
/** 板级元信息的文件名。前缀下划线，好和流程分片区分开 */
const BOARD_META_FILE = "_board.json";
/**
 * 人工改过的状态存在这里，**不进流程分片**。
 *
 * 进分片的话，流程下次整片覆盖就会把人的判断冲掉——人点一次、明天就没了，
 * 这种交互只会让人不再点。
 */
const BOARD_OVERRIDES_FILE = "_overrides.json";
/**
 * 每条条目上一次告警留下的状态。
 *
 * 和覆盖层一样**不进流程分片**——它要活过流程的整片覆盖，否则每天重跑一次就等于把
 * 「今天已经提醒过了」忘掉，降噪当场失效。
 */
const BOARD_PENDING_FILE = "_pending.json";
const BOARD_ALERTS_FILE = "_alerts.json";

function radarRoot() {
  return path.join(getAgentflowDataRoot(), "radar");
}

function boardsDir() {
  return path.join(radarRoot(), "boards");
}

function eventsDir() {
  return path.join(radarRoot(), "events");
}

/**
 * 板绑定的编排：点「编排」跳回画布配它的定时任务时要用。
 *
 * 只认这几个字段，其余一律丢掉——这份数据会直接拼进跳转地址，不能让写板的人塞进任意东西。
 */
function normalizeBoundFlow(flow) {
  const flowId = String(flow?.flowId || "").trim();
  if (!flowId) return null;
  return {
    flowId,
    flowSource: String(flow?.flowSource || "user").trim() || "user",
    workspaceId: String(flow?.workspaceId || "").trim(),
    scheduleNodeId: String(flow?.scheduleNodeId || "").trim(),
    ownerUserId: String(flow?.ownerUserId || "").trim(),
  };
}

/** 板 id 直接进文件名，必须先挡住路径穿越 */
export function isValidBoardId(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(String(value || "")) && !String(value).includes("..");
}

function boardDir(board) {
  return path.join(boardsDir(), board);
}

function boardMetaPath(board) {
  return path.join(boardDir(board), BOARD_META_FILE);
}

function shardPath(board, flowId) {
  return path.join(boardDir(board), `${flowId}.json`);
}

function overridesPath(board) {
  return path.join(boardDir(board), BOARD_OVERRIDES_FILE);
}

function alertsPath(board) {
  return path.join(boardDir(board), BOARD_ALERTS_FILE);
}

/** 板目录的绝对路径。待审批之类和分片并列的东西要往这儿写 */
export function radarBoardDir(board) {
  return boardDir(board);
}

/** 列出所有板的 id。告警扫描要遍历它们 */
export function listRadarBoardIds() {
  try {
    return fs.readdirSync(boardsDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter(isValidBoardId)
      .sort();
  } catch {
    return [];
  }
}

export function readRadarAlertStates(board) {
  if (!isValidBoardId(board)) return {};
  return readJsonFile(alertsPath(board)) || {};
}

export function writeRadarAlertStates(board, states = {}) {
  if (!isValidBoardId(board)) return { ok: false, error: "board id 不合法" };
  fs.mkdirSync(boardDir(board), { recursive: true });
  writeJsonAtomic(alertsPath(board), states);
  return { ok: true };
}

/** 流程 id 也会进文件名，和 board id 一样要挡住穿越 */
export function isValidShardId(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,96}$/.test(String(value || "")) && !String(value).includes("..");
}

/** 列出一块板下的所有流程分片，按流程 id 排序 */
function listShardIds(board) {
  try {
    return fs.readdirSync(boardDir(board))
      .filter((name) => name.endsWith(".json") && name !== BOARD_META_FILE)
      .map((name) => name.slice(0, -5))
      .filter(isValidShardId)
      .sort();
  } catch {
    return [];
  }
}

function readJsonFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toTime(value) {
  if (value === undefined || value === null || value === "") return NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const text = String(value).trim();
  // 只写日期时按当地 00:00 解释，而不是 UTC——否则东八区会整体偏一天
  const time = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00`) : Date.parse(text);
  return Number.isFinite(time) ? time : NaN;
}

/**
 * 有效截止日：最后一班不晚于政策截止日、且还没发车的班次。
 *
 * 没有可赶的班次时退回政策截止日本身，并说明原因——「赶不上任何一班车」和「本来就没有车」
 * 是两件事，页面要能分开讲。
 * @param {string|number} due 政策截止日
 * @param {Array<{version?: string, cutoff?: string}>} trains 版本车
 * @param {number} now
 */
export function effectiveCutoff(due, trains = [], now = Date.now()) {
  const wall = toTime(due);
  if (!Number.isFinite(wall)) return { at: NaN, train: "", reason: "no_due" };
  const cutoffs = (Array.isArray(trains) ? trains : [])
    .map((train) => ({ at: toTime(train?.cutoff), version: String(train?.version || "") }))
    .filter((train) => Number.isFinite(train.at));
  if (!cutoffs.length) return { at: wall, train: "", reason: "no_trains" };

  // 版本车表是有限的（只排到已知的最后一班）。截止日如果落在它之后，说明到那时还会有新车，
  // 现在挑「我恰好知道的最后一班」会把紧迫度凭空夸大——真实截止日 2027-04，却报成 2026-12。
  // 这种情况老实退回政策日期，并说明是排期没排到那儿。
  const lastKnown = cutoffs.reduce((max, train) => Math.max(max, train.at), -Infinity);
  if (wall > lastKnown) return { at: wall, train: "", reason: "beyond_known_trains" };

  let best = null;
  for (const train of cutoffs) {
    if (train.at > wall || train.at < now) continue;
    if (!best || train.at > best.at) best = train;
  }
  if (best) return { at: best.at, train: best.version, reason: "train" };
  return { at: wall, train: "", reason: "no_train_in_reach" };
}

function normalizeState(value) {
  const state = String(value || "").trim();
  return RADAR_STATES.includes(state) ? state : "idle";
}

/**
 * 给一行补上算出来的字段。流程只需要写 `due` 和 `state`，剩下的这里统一推。
 */
export function decorateRow(row = {}, trains = [], now = Date.now(), options = {}) {
  const due = row.due ?? row.deadline ?? "";
  const wall = toTime(due);
  const effective = effectiveCutoff(due, trains, now);
  const state = normalizeState(row.state);
  const at = Number.isFinite(effective.at) ? effective.at : wall;
  // 「定了就不用再盯了」：不再期待更新，也就不该因为陈旧而报警。
  // 但**不是删除**——政策改期后还要能重新亮起来，所以条目留着，只是不催
  const settled = row.settled === true;
  const lastSeenAt = toTime(row.lastSeenAt);
  const staleAfterMs = Number(options.staleAfterMs) > 0 ? Number(options.staleAfterMs) : 0;
  return {
    ...row,
    state,
    due: Number.isFinite(wall) ? new Date(wall).toISOString() : "",
    effectiveDue: Number.isFinite(at) ? new Date(at).toISOString() : "",
    effectiveTrain: effective.train,
    effectiveReason: effective.reason,
    // 只有真的挂上了某班车才有「封包日」；没挂上时给空，免得跑道上画一个骗人的标记
    cutoffDate: effective.train && Number.isFinite(effective.at) ? new Date(effective.at).toISOString() : "",
    daysLeft: Number.isFinite(at) ? Math.round((at - now) / DAY_MS) : null,
    // 「不用再管了」只有一种：真的满足了。
    // 截止日过了而且没满足，是**最该看见**的状态，不是完成——早先把它算进 done，
    // 结果是过期未完成的条目被排到最后、变灰，跟已满足待遇一样
    done: state === "ok",
    overdue: state !== "ok" && Number.isFinite(wall) && wall < now,
    settled,
    lastSeenAt: Number.isFinite(lastSeenAt) ? new Date(lastSeenAt).toISOString() : "",
    /**
     * 这一条多久没被写过了。
     *
     * 分片新鲜 ≠ 条目新鲜：流程还在跑，但某个条目已经不在它的输出里了（checker 挂了、
     * 或者被静默丢掉）。分片级的 stale 看不出这件事，条目级的才行。
     * 已经 settled 的不算陈旧——本来就不指望它再更新。
     */
    staleItem: !settled && staleAfterMs > 0 && Number.isFinite(lastSeenAt)
      ? now - lastSeenAt > staleAfterMs
      : false,
    owner: String(row.owner || ""),
  };
}

/**
 * 视角过滤。
 *
 * `mine` = 我负责的 ＋ **没人负责的**。后者故意也算进来：无人认领是最危险的状态，
 * 把它藏在「全部」里，就等于没人会看见它。
 */
export function rowsForActor(rows = [], { scope = "mine", username = "", userId = "" } = {}) {
  if (scope === "all") return rows;
  const me = new Set([String(username || ""), String(userId || "")].filter(Boolean));
  return rows.filter((row) => !row.owner || me.has(String(row.owner)));
}

/** 每种状态各几条，给 tab 上的角标用 */
export function boardCounts(rows = []) {
  const counts = { risk: 0, warn: 0, idle: 0, ok: 0, overdue: 0, stale: 0, settled: 0, total: rows.length };
  for (const row of rows) {
    const state = normalizeState(row.state);
    if (row.overdue) counts.overdue += 1;
    if (row.staleItem) counts.stale += 1;
    if (row.settled) { counts.settled += 1; continue; }
    counts[state] = (counts[state] || 0) + 1;
  }
  // 角标只显示「要人管的」：已满足和已封存的不该催人点进去
  counts.pending = counts.risk + counts.warn + counts.idle;
  return counts;
}

function sortRows(rows) {
  return [...rows].sort((left, right) => {
    // 过期未完成排最前——它已经在烧了，不该被埋在按日期排的中间
    if (Boolean(left.overdue) !== Boolean(right.overdue)) return left.overdue ? -1 : 1;
    if (left.done !== right.done) return left.done ? 1 : -1;
    // 定了不用再盯的沉到已满足那一档去
    if (Boolean(left.settled) !== Boolean(right.settled)) return left.settled ? 1 : -1;
    const a = toTime(left.effectiveDue);
    const b = toTime(right.effectiveDue);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b;
    if (Number.isFinite(a) !== Number.isFinite(b)) return Number.isFinite(a) ? -1 : 1;
    return String(left.title || "").localeCompare(String(right.title || ""));
  });
}

function defaultSpec(spec = {}) {
  const encode = spec.encode && typeof spec.encode === "object" ? spec.encode : {};
  return {
    view: String(spec.view || "runway"),
    views: Array.isArray(spec.views) && spec.views.length ? spec.views.map(String) : ["runway", "table"],
    encode: {
      lane: encode.lane || "title",
      end: encode.end || "effectiveDue",
      color: encode.color || "state",
      marker: encode.marker || "",
      value: encode.value || "daysLeft",
      group: encode.group || "",
      badges: Array.isArray(encode.badges) ? encode.badges.map(String) : [],
    },
    detail: spec.detail && typeof spec.detail === "object" ? spec.detail : { sections: [] },
  };
}

/** 行上出现过、但没被任何通道用掉的字段——编排面板要列出来给人挑 */
export function spareFields(rows = [], encode = {}) {
  const used = new Set([
    encode.lane, encode.end, encode.color, encode.marker, encode.value, encode.group,
    ...(Array.isArray(encode.badges) ? encode.badges : []),
  ].map((value) => (typeof value === "object" && value ? String(value.field || "") : String(value || ""))).filter(Boolean));
  const derived = new Set(["effectiveDue", "effectiveTrain", "effectiveReason", "cutoffDate", "daysLeft", "done", "id"]);
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      if (used.has(key) || derived.has(key)) continue;
      seen.add(key);
    }
  }
  return [...seen].sort();
}

/**
 * 把一块板的所有分片读进来合并。
 *
 * 条目按 id 去重：同一个 id 出现在两片里是配置错了（两条流程都声称自己负责这一条），
 * 这时取更新时间较新的那片，并把冲突记下来——静默挑一个，是让人不再相信这块板的最快方式。
 */
function loadBoard(board, now = Date.now()) {
  if (!isValidBoardId(board)) return null;
  const meta = readJsonFile(boardMetaPath(board)) || {};
  const shardIds = listShardIds(board);
  if (!shardIds.length && !Object.keys(meta).length) return null;

  const shards = [];
  for (const flowId of shardIds) {
    const file = readJsonFile(shardPath(board, flowId));
    if (!file) continue;
    const updatedAt = toTime(file.updatedAt);
    const staleAfterMs = Number(file.staleAfterMs) > 0 ? Number(file.staleAfterMs) : DEFAULT_STALE_AFTER_MS;
    shards.push({
      flowId,
      flow: normalizeBoundFlow({ flowId, ...(file.flow || {}) }),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      staleAfterMs,
      // 这一片多久没更新了。整份覆盖的年代看不出这件事——哑掉和「这次没条目」长得一样
      stale: Number.isFinite(updatedAt) ? now - updatedAt > staleAfterMs : true,
      fetchFailures: Number(file.fetchFailures) || 0,
      writtenBy: String(file.writtenBy || ""),
      rows: Array.isArray(file.rows) ? file.rows : [],
      trains: Array.isArray(file.trains) ? file.trains : [],
      spec: file.spec && typeof file.spec === "object" ? file.spec : null,
    });
  }

  const byId = new Map();
  const conflicts = new Map();
  for (const shard of shards) {
    for (const row of shard.rows) {
      const id = String(row?.id || row?.title || "").trim();
      const tagged = { ...row, flowId: shard.flowId };
      if (!id) { byId.set(`${shard.flowId}:${byId.size}`, tagged); continue; }
      const existing = byId.get(id);
      if (!existing) { byId.set(id, tagged); continue; }
      const seen = conflicts.get(id) || new Set([String(existing.flowId || "")]);
      seen.add(shard.flowId);
      conflicts.set(id, seen);
      const existingAt = shards.find((item) => item.flowId === existing.flowId)?.updatedAt || 0;
      if (shard.updatedAt >= existingAt) byId.set(id, tagged);
    }
  }

  const overrides = readJsonFile(overridesPath(board)) || {};
  for (const [id, row] of byId.entries()) {
    const override = overrides[id];
    if (!override || typeof override !== "object") continue;
    const observed = normalizeState(row.state);
    const decided = normalizeState(override.state);
    byId.set(id, {
      ...row,
      // 观测值留着：人的判断优先，但**不能让它静默盖住观测**。
      // 一次点击就永久掩盖一次真实退化，是这套面板失去可信度的最短路径
      observedState: observed,
      state: decided,
      settled: override.settled === true || row.settled === true,
      override: {
        state: decided,
        by: String(override.by || ""),
        at: String(override.at || ""),
        note: String(override.note || ""),
      },
      // 人说完成、脚本说没完成——这个矛盾要摆在台面上，而不是二选一后闭嘴
      overrideConflict: decided !== observed,
    });
  }

  return {
    board,
    title: String(meta.title || board),
    icon: String(meta.icon || "radar"),
    archived: meta.archived === true,
    createdAt: String(meta.createdAt || ""),
    createdBy: String(meta.createdBy || ""),
    // 板级的 spec / 版本车优先；没写板级元信息时，从第一片有的那个拿，单流程的板就不用建两个文件
    spec: meta.spec && typeof meta.spec === "object" ? meta.spec : (shards.find((shard) => shard.spec)?.spec || {}),
    trains: Array.isArray(meta.trains) && meta.trains.length
      ? meta.trains
      : (shards.find((shard) => shard.trains.length)?.trains || []),
    rows: [...byId.values()],
    shards,
    conflicts: [...conflicts.entries()].map(([id, flows]) => ({ id, flows: [...flows].sort() })),
    updatedAt: shards.reduce((max, shard) => Math.max(max, shard.updatedAt), 0),
    fetchFailures: shards.reduce((sum, shard) => sum + shard.fetchFailures, 0),
  };
}

/**
 * 人工改一条的状态。
 *
 * 只动覆盖层，碰不到流程分片——所以流程下次跑照样写它的观测值，两边各说各的，
 * 由读的时候合并，并把矛盾标出来。传 `state` 为空表示撤销覆盖，让它回到脚本判定。
 */
export function setRadarItemState(board, itemId, { state, by = "", note = "", settled } = {}) {
  if (!isValidBoardId(board)) return { ok: false, error: "board id 不合法" };
  const id = String(itemId || "").trim();
  if (!id) return { ok: false, error: "缺少条目 id" };
  const next = readJsonFile(overridesPath(board)) || {};
  const decided = String(state || "").trim();
  if (!decided && settled === undefined) {
    delete next[id];
  } else {
    if (decided && !RADAR_STATES.includes(decided)) return { ok: false, error: "state 取值不合法" };
    const previous = next[id] && typeof next[id] === "object" ? next[id] : {};
    next[id] = {
      ...previous,
      ...(decided ? { state: decided } : {}),
      ...(settled === undefined ? {} : { settled: settled === true }),
      by: String(by || previous.by || ""),
      note: String(note ?? previous.note ?? ""),
      at: new Date().toISOString(),
    };
  }
  fs.mkdirSync(boardDir(board), { recursive: true });
  writeJsonAtomic(overridesPath(board), next);
  return { ok: true, board, itemId: id, override: next[id] || null };
}

function shardSummary(shard) {
  return {
    flowId: shard.flowId,
    flow: shard.flow,
    updatedAt: shard.updatedAt ? new Date(shard.updatedAt).toISOString() : "",
    stale: shard.stale,
    // 这一片预期多久更新一次。「三天没写」对日更是故障，对周更是正常——
    // 不把它带出来，页面只能拿一个猜的阈值去判断
    staleAfterMs: shard.staleAfterMs,
    rows: shard.rows.length,
    fetchFailures: shard.fetchFailures,
    // 它到底写了哪几条。协作视图要靠它看出「谁在管什么」和「谁没人管」
    owns: shard.rows.map((row) => String(row?.id || row?.title || "")).filter(Boolean),
    writtenBy: String(shard.writtenBy || ""),
  };
}

/** 列出所有板。只回摘要——tab 条要的是名字和待办数，不是全部行 */
export function listRadarBoards({
  scope = "mine",
  username = "",
  userId = "",
  now = Date.now(),
  includeArchived = false,
} = {}) {
  let names = [];
  try {
    names = fs.readdirSync(boardsDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter(isValidBoardId);
  } catch {
    return [];
  }
  const boards = [];
  for (const board of names.sort()) {
    const loaded = loadBoard(board, now);
    if (!loaded) continue;
    if (loaded.archived && !includeArchived) continue;
    const shardStale = new Map(loaded.shards.map((shard) => [shard.flowId, shard.staleAfterMs]));
    const rows = rowsForActor(
      loaded.rows.map((row) => decorateRow(row, loaded.trains, now, {
        staleAfterMs: shardStale.get(row.flowId) || 0,
      })),
      { scope, username, userId },
    );
    const counts = boardCounts(rows);
    const soonest = sortRows(rows).find((row) => !row.done && Number.isFinite(row.daysLeft));
    boards.push({
      board,
      title: loaded.title,
      icon: loaded.icon,
      archived: loaded.archived,
      flows: loaded.shards.map((shard) => shard.flowId),
      updatedAt: loaded.updatedAt ? new Date(loaded.updatedAt).toISOString() : "",
      // 「抓取失败几条」和「几片哑了」是仅有的两个能证明监控没静默死掉的数字，一路带到最外层
      fetchFailures: loaded.fetchFailures,
      staleFlows: loaded.shards.filter((shard) => shard.stale).length,
      conflicts: loaded.conflicts.length,
      counts,
      // 列表也要知道有没有待审批——切板之前就该看见，而不是点进去才发现
      pendingCount: Object.values(readRadarPending(board))
        .reduce((sum, entry) => sum + (Array.isArray(entry?.held) ? entry.held.length : 0), 0),
      worst: RADAR_STATES.find((state) => counts[state] > 0) || "ok",
      soonestDays: soonest ? soonest.daysLeft : null,
    });
  }
  return boards;
}

/**
 * 反查：哪条流程在喂哪块板。
 *
 * 定时任务那一侧**不存**雷达归属，是有意的。存一个 `track: "compliance"` 字段等于开第二个
 * 真相源：流程改成写另一块板之后那个字段不会自己变，列表显示的归属就成了过期的谎话；
 * 而且分片模型允许一条流程写多块板，单个字段也装不下。
 *
 * 分片文件本身就是权威记录——它存在，就证明这条流程真的往这块板写过；它的 `updatedAt`
 * 还能证明**最后一次成功写入**是什么时候。这是证据，不是声明。
 *
 * 匹配优先用分片里记着的 `flow.flowId`（真正的绑定），退回分片名——手工
 * `track commit --flow=x` 时分片名就是唯一线索。
 *
 * @returns {Map<string, Array<{board, title, flowId, rows, updatedAt, stale, staleAfterMs}>>}
 */
export function boardsByFlow({ now = Date.now() } = {}) {
  const index = new Map();
  const attach = (key, entry) => {
    const id = String(key || "").trim();
    if (!id) return;
    const list = index.get(id);
    if (!list) { index.set(id, [entry]); return; }
    // 同一条流程通过两个键指到同一片时只留一份
    if (!list.some((item) => item.board === entry.board && item.flowId === entry.flowId)) list.push(entry);
  };

  for (const board of listRadarBoardIds()) {
    const loaded = loadBoard(board, now);
    if (!loaded) continue;
    for (const shard of loaded.shards) {
      const entry = {
        board,
        title: loaded.title,
        flowId: shard.flowId,
        rows: shard.rows.length,
        updatedAt: shard.updatedAt ? new Date(shard.updatedAt).toISOString() : "",
        // 「定时任务跑成功了」和「真的写进板了」是两回事，只看 schedule 那一侧永远发现不了空转
        stale: shard.stale,
        staleAfterMs: shard.staleAfterMs,
        fetchFailures: shard.fetchFailures,
      };
      attach(shard.flow?.flowId, entry);
      attach(shard.flowId, entry);
    }
  }
  return index;
}

/** 读一块板的完整内容，行已经补好算出来的字段并排好序 */
export function readRadarBoard(board, { scope = "mine", username = "", userId = "", now = Date.now() } = {}) {
  const loaded = loadBoard(board, now);
  if (!loaded) return null;
  const shardStale = new Map(loaded.shards.map((shard) => [shard.flowId, shard.staleAfterMs]));
  const decorated = loaded.rows.map((row) => decorateRow(row, loaded.trains, now, {
    // 预期更新间隔取自写这一条的那片流程：每周跑的流程，它的条目不该按日更去判陈旧
    staleAfterMs: shardStale.get(row.flowId) || 0,
  }));
  const visible = sortRows(rowsForActor(decorated, { scope, username, userId }));
  const spec = defaultSpec(loaded.spec);
  return {
    board,
    title: loaded.title,
    icon: loaded.icon,
    archived: loaded.archived,
    // 一块板由哪几条流程喂，各自多久没更新——「编排」入口和哑掉告警都靠它
    flows: loaded.shards.map(shardSummary),
    staleFlows: loaded.shards.filter((shard) => shard.stale).map((shard) => shard.flowId),
    conflicts: loaded.conflicts,
    updatedAt: loaded.updatedAt ? new Date(loaded.updatedAt).toISOString() : "",
    fetchFailures: loaded.fetchFailures,
    spec,
    trains: loaded.trains
      .map((train) => ({ version: String(train?.version || ""), cutoff: String(train?.cutoff || "") }))
      .filter((train) => Number.isFinite(toTime(train.cutoff))),
    rows: visible,
    // 待审批要跟着板一起回：它是板的状态，页面上得有个角标，而不是等人想起来敲 CLI
    pending: readRadarPending(board),
    counts: boardCounts(visible),
    spareFields: spareFields(visible, spec.encode),
    totalRows: decorated.length,
  };
}

/** 变更流。文件不存在就是「还没有变更」，不是错误 */
export function readRadarEvents(board, { limit = EVENTS_DEFAULT_LIMIT } = {}) {
  if (!isValidBoardId(board)) return [];
  let text = "";
  try {
    text = fs.readFileSync(path.join(eventsDir(), `${board}.jsonl`), "utf-8");
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines.slice(-Math.max(1, Number(limit) || EVENTS_DEFAULT_LIMIT))) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {
      // 单行坏掉不该让整条变更流消失
    }
  }
  return out.reverse();
}

function writeJsonAtomic(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
  fs.renameSync(temp, filePath);
  return filePath;
}

/**
 * 写板级元信息：标题、版本车、spec。
 *
 * 单条流程独占一块板时可以不写它——`_board.json` 缺失时，这些会从流程分片里取。
 */
export function writeRadarBoardMeta(board, meta = {}) {
  if (!isValidBoardId(board)) return { ok: false, error: "board id 不合法" };
  const body = {
    board,
    title: String(meta.title || board),
    icon: String(meta.icon || "radar"),
    ...(Array.isArray(meta.trains) ? { trains: meta.trains } : {}),
    ...(meta.spec && typeof meta.spec === "object" ? { spec: meta.spec } : {}),
    // 归档不是删除：板和它的分片、变更流都留着，只是不再出现在列表里。
    // 真删掉的话，一块攒了半年状态的板一次误点就没了
    ...(meta.archived === true ? { archived: true } : {}),
    ...(meta.createdAt ? { createdAt: String(meta.createdAt) } : {}),
    ...(String(meta.createdBy || "").trim() ? { createdBy: String(meta.createdBy).trim() } : {}),
    updatedAt: meta.updatedAt || new Date().toISOString(),
  };
  return { ok: true, board, path: writeJsonAtomic(boardMetaPath(board), body) };
}

/**
 * 读一条流程那一片的**原始内容**，不 decorate、不合并覆盖层。
 *
 * `readRadarBoard` 给的是拿来展示的：算过天数、套过人工覆盖、按可见性过滤过。
 * 重写这一片的人要的是上一次**自己写进去了什么**——继承 settled、和新结果做 diff，
 * 都只能拿原始值比，拿展示值比会把覆盖层当成自己写的。
 */
export function readRadarShard(board, flowId) {
  if (!isValidBoardId(board) || !isValidShardId(flowId)) return null;
  return readJsonFile(shardPath(board, flowId));
}

/**
 * 写一条流程自己那一片。
 *
 * 每条流程只碰自己的文件，所以同一块板上的几条流程互不覆盖，也不需要加锁。
 * `staleAfterMs` 由流程自己给——它知道自己的 cron，比这边猜一个固定值准。
 */
export function writeRadarShard(board, flowId, payload = {}) {
  if (!isValidBoardId(board)) return { ok: false, error: "board id 不合法" };
  if (!isValidShardId(flowId)) return { ok: false, error: "flowId 不合法" };
  const updatedAt = payload.updatedAt || new Date().toISOString();
  const body = {
    flowId,
    ...(payload.flow && typeof payload.flow === "object" ? { flow: payload.flow } : {}),
    updatedAt,
    ...(Number(payload.staleAfterMs) > 0 ? { staleAfterMs: Number(payload.staleAfterMs) } : {}),
    fetchFailures: Number(payload.fetchFailures) || 0,
    // 谁写的这一片。没有它就无法分辨「我的流程在更新」和「别人的流程覆盖了我」
    ...(String(payload.writtenBy || "").trim() ? { writtenBy: String(payload.writtenBy).trim() } : {}),
    ...(Array.isArray(payload.trains) ? { trains: payload.trains } : {}),
    ...(payload.spec && typeof payload.spec === "object" ? { spec: payload.spec } : {}),
    // 出现在本次输出里的条目盖上时间戳。没出现的不会被刷新，于是自然变陈旧并被点名——
    // 「条目从输出里消失」不等于「这条没了」，等于「没人再更新它了」
    rows: (Array.isArray(payload.rows) ? payload.rows : []).map((row) => ({
      ...row,
      lastSeenAt: row?.lastSeenAt || updatedAt,
    })),
  };
  return { ok: true, board, flowId, path: writeJsonAtomic(shardPath(board, flowId), body) };
}

/**
 * 建一块空板。
 *
 * 空板是有意义的：先把板立起来、绑上编排，再让流程往里写。反过来要求「先有流程才有板」
 * 的话，人第一次用这个功能时面对的是一个没有任何入口的空页面。
 *
 * 已经存在就拒绝——建板是人点出来的动作，静默覆盖会把一块攒了半年的板清成新的。
 */
export function createRadarBoard(board, { title = "", icon = "radar", createdBy = "", spec = null, trains = null } = {}) {
  if (!isValidBoardId(board)) return { ok: false, error: "board id 不合法：只允许字母数字和 - _ .，字母数字开头" };
  if (fs.existsSync(boardMetaPath(board)) || listShardIds(board).length) {
    return { ok: false, error: `${board} 已经存在` };
  }
  const now = new Date().toISOString();
  return writeRadarBoardMeta(board, {
    title: String(title || board),
    icon: String(icon || "radar"),
    createdAt: now,
    createdBy,
    updatedAt: now,
    ...(spec ? { spec } : {}),
    ...(Array.isArray(trains) ? { trains } : {}),
  });
}

/**
 * 归档 / 取消归档一块板。
 *
 * 归档只翻 `_board.json` 上的一位：分片、覆盖层、告警状态、变更流全部原样留着，
 * 取消归档就完整回来。「删除」在界面上写成归档，是因为这类板攒的是**时间**——
 * 半年的状态变迁没法重建，而误点一次删除只要一秒。
 *
 * 真要彻底删除走 `agentflow track rm`，那是命令行上的显式动作。
 */
export function setRadarBoardArchived(board, archived = true) {
  if (!isValidBoardId(board)) return { ok: false, error: "board id 不合法" };
  const meta = readJsonFile(boardMetaPath(board));
  if (!meta && !listShardIds(board).length) return { ok: false, error: `没有这块板：${board}` };
  // 分片先建、板级元信息还没写过的板也要能归档，所以缺 meta 时补一份
  return writeRadarBoardMeta(board, {
    ...(meta || {}),
    archived: archived === true,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * 删掉一条流程那一片。
 *
 * 板留着——另外几条流程还在喂它。这一片的条目会从板上消失，但**告警状态不清**：
 * 清了的话，误删再重建就会把已经提醒过的档位全部重放一遍。
 */
export function rmRadarShard(board, flowId) {
  if (!isValidBoardId(board)) return { ok: false, error: "board id 不合法" };
  if (!isValidShardId(flowId)) return { ok: false, error: "flowId 不合法" };
  try {
    fs.rmSync(shardPath(board, flowId), { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 删掉整块板：分片、板级元信息、覆盖层、告警状态一起走。
 *
 * 变更流**留着**。它记的是「这块板上发生过什么」，板没了那段历史反而更该留——
 * 误删之后它是唯一能说清丢了什么的东西。
 */
export function rmRadarBoard(board) {
  if (!isValidBoardId(board)) return { ok: false, error: "board id 不合法" };
  try {
    fs.rmSync(boardDir(board), { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 待审批的改动。和分片并列存在板目录里——它是**板的状态**，不是某次运行的副产品。
 *
 * 放运行记录里的话，运行一轮转就没了，而「这条改动还等着人点头」得一直看得见。
 */
export function readRadarPending(board) {
  if (!isValidBoardId(board)) return {};
  const raw = readJsonFile(path.join(boardDir(board), BOARD_PENDING_FILE)) || {};
  /**
   * 丢掉已经不成立的：目标值和现在的值已经一样了。
   *
   * 会发生是因为门禁是逐条流程选择开不开的——同一个条目被另一条没开门禁的流程写成了
   * 目标值，这条待审批就成了幻影。留着的话人会去批一件已经发生的事，
   * 而「批准」在变更流里又记一条，把真正的那次改动淹掉。
   */
  const out = {};
  for (const [flowId, entry] of Object.entries(raw)) {
    const shard = readRadarShard(board, flowId);
    const byId = new Map((shard?.rows || []).map((row) => [String(row?.id || ""), row]));
    const held = (Array.isArray(entry?.held) ? entry.held : []).filter((item) => {
      const row = byId.get(String(item?.id || ""));
      if (!row) return item?.kind === "dropped" ? false : true;
      return String(row[item.kind] ?? "") !== String(item.to ?? "");
    });
    if (held.length) out[flowId] = { ...entry, held };
  }
  return out;
}

export function writeRadarPending(board, value = {}) {
  if (!isValidBoardId(board)) return { ok: false, error: "board id 不合法" };
  const file = path.join(boardDir(board), BOARD_PENDING_FILE);
  // 清空时把文件删掉，而不是留一个 `{}` 的空壳——目录里少一个文件比多一个空文件好读
  if (!Object.keys(value).length) {
    try { fs.rmSync(file, { force: true }); } catch { /* 本来就没有 */ }
    return { ok: true };
  }
  fs.mkdirSync(boardDir(board), { recursive: true });
  writeJsonAtomic(file, value);
  return { ok: true };
}

/**
 * 批准或驳回挂起的改动。
 *
 * 批准 = 把目标值真的写进分片；驳回 = 不写。两者都往变更流记一条。
 *
 * 驳回必须留痕，而且不是为了审计：**agent 连着三轮想把同一条改成 ok 都被驳回，
 * 说明它的判定规则该改了**，而不是让它每轮再试一次。静默丢弃会把这个信号一起丢掉。
 */
export function resolveRadarPending(board, flowId, { action = "approve", ids = [], by = "" } = {}) {
  if (!isValidBoardId(board)) return { ok: false, error: "board id 不合法" };
  if (!isValidShardId(flowId)) return { ok: false, error: "flowId 不合法" };
  const pending = readRadarPending(board);
  const entry = pending[flowId];
  if (!entry || !Array.isArray(entry.held) || !entry.held.length) {
    return { ok: false, error: `${board}/${flowId} 没有待审批的改动` };
  }
  const wanted = new Set((Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean));
  const picked = wanted.size ? entry.held.filter((item) => wanted.has(String(item.id))) : entry.held;
  if (!picked.length) return { ok: false, error: "待审批里没有指定的条目" };
  const rest = entry.held.filter((item) => !picked.includes(item));

  if (action === "approve") {
    const shard = readRadarShard(board, flowId);
    if (!shard) return { ok: false, error: `没有这一片：${board}/${flowId}` };
    const rows = (shard.rows || []).map((row) => ({ ...row }));
    const byId = new Map(rows.map((row) => [String(row.id || ""), row]));
    for (const item of picked) {
      const id = String(item.id || "");
      if (item.kind === "dropped") { byId.delete(id); continue; }
      const row = byId.get(id);
      if (row) row[item.kind] = item.to;
    }
    const written = writeRadarShard(board, flowId, {
      ...shard,
      rows: rows.filter((row) => byId.has(String(row.id || ""))),
      updatedAt: new Date().toISOString(),
      writtenBy: shard.writtenBy || by,
    });
    if (!written.ok) return written;
  }

  for (const item of picked) {
    appendRadarEvent(board, {
      kind: action === "approve" ? "approved" : "rejected",
      id: item.id, field: item.kind, from: item.from, to: item.to,
      why: item.reason, by: by || "unknown", flowId,
    });
  }

  if (rest.length) pending[flowId] = { ...entry, held: rest };
  else delete pending[flowId];
  writeRadarPending(board, pending);
  return { ok: true, action, resolved: picked, remaining: rest.length };
}

/** 往变更流追加一条 */
export function appendRadarEvent(board, event = {}) {
  if (!isValidBoardId(board)) return { ok: false, error: "board id 不合法" };
  fs.mkdirSync(eventsDir(), { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  fs.appendFileSync(path.join(eventsDir(), `${board}.jsonl`), `${line}\n`, "utf-8");
  return { ok: true };
}
