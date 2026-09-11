/**
 * 哪些改动可以直接落地，哪些要人点头。
 *
 * 规则不是拍脑袋列的，是从 `decideRadarAlert` **反推**出来的：凡是会让一条条目
 * 从此不再告警的改动，都要审批。今天让告警永久闭嘴的只有三种：
 *
 *   settled === true        radar-alerts.mjs:53
 *   state === "ok"          radar-alerts.mjs:75  （done）
 *   due 变成空              radar-alerts.mjs:93  （no_due，阈值告警不再触发）
 *
 * 加上两种虽然不静音、但同样不可逆或越权的：条目消失、覆盖上次由人改的字段。
 *
 * **其余一律直接落地。** 这一条和门禁本身同等重要——每天一个 diff 全都要批，
 * 两周之后就是闭眼点，那时候门禁比没有更糟，因为它制造了「已经审过」的假象。
 * 而且待审批意味着板是旧的，这套系统存在的意义正是发现陈旧。
 *
 * 不对称是有意的：**误报只花注意力，漏报会让违规的包发出去。**
 * 所以状态变坏不用批，变好要批。
 */

/** 只有 ok 会让 decideRadarAlert 闭嘴；warn / risk / idle 照常走阈值和过期逻辑 */
const SILENCING_STATE = "ok";

function toDay(value) {
  if (value === undefined || value === null || value === "") return NaN;
  const text = String(value).trim();
  const time = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00`) : Date.parse(text);
  return Number.isFinite(time) ? time : NaN;
}

/**
 * 判一条改动该不该拦。
 *
 * @param {object} event diffRows 产出的变更事件
 * @param {object} ctx   { previous, next, humanFields }
 *   humanFields: Set<`${id}:${field}`>，上次由人改过的字段。git blame 能算出来，
 *   但这里只收结果——判定要能脱离 git 单独测。
 * @returns {{ gate: "auto"|"review", reason: string }}
 */
export function classifyChange(event = {}, ctx = {}) {
  const id = String(event.id || "");
  const humanFields = ctx.humanFields instanceof Set ? ctx.humanFields : new Set();

  // 条目从输出里消失 = 停止追踪，不可逆
  if (event.kind === "dropped") return { gate: "review", reason: "条目将不再被追踪" };

  // 新增的条目没有历史可覆盖，也没有告警可关——天然过不了任何拦截条件
  if (event.kind === "added") return { gate: "auto", reason: "新条目" };

  const field = event.kind === "state" || event.kind === "due" || event.kind === "current"
    ? event.kind
    : String(event.field || event.kind || "");

  // 人改过的字段被 agent 改回去，正是覆盖层要防的那件事
  if (humanFields.has(`${id}:${field}`)) {
    return { gate: "review", reason: `上次由人改的 ${field}，agent 要改回去` };
  }

  if (event.kind === "state") {
    if (String(event.to) === SILENCING_STATE) return { gate: "review", reason: "改成已满足会关掉这条的告警" };
    return { gate: "auto", reason: "状态变坏或平移，收紧不需要证据" };
  }

  if (event.kind === "due") {
    const from = toDay(event.from);
    const to = toDay(event.to);
    // 清空截止日 → daysLeft 变 NaN → 阈值告警从此不触发，和改成 ok 一样是静音
    if (!Number.isFinite(to)) return { gate: "review", reason: "清空截止日会让阈值提醒不再触发" };
    if (Number.isFinite(from) && to > from) return { gate: "review", reason: "推后截止日会推后所有提醒" };
    return { gate: "auto", reason: "截止日提前或补齐" };
  }

  if (event.kind === "settled") {
    if (event.to === true) return { gate: "review", reason: "封存会让这条从此不再出声" };
    return { gate: "auto", reason: "解除封存" };
  }

  // current / evidence 这类描述性字段没有告警吃它们，写错了人一眼看得出来
  return { gate: "auto", reason: "描述性字段" };
}

/**
 * 把一次提交拆成「现在就写」和「等人点头」两部分。
 *
 * 被拦下的字段**回退成上一次的值**，而不是整条不写——否则一条待审批会把同一条目上
 * 其它本该落地的改动一起卡住，板照样是旧的。
 */
export function applyGate(previous, nextRows = [], events = [], ctx = {}) {
  const before = new Map(
    (Array.isArray(previous?.rows) ? previous.rows : [])
      .map((row) => [String(row?.id || ""), row])
      .filter(([id]) => id),
  );
  const held = [];
  const applied = [];
  const revert = new Map();

  for (const event of events) {
    const verdict = classifyChange(event, ctx);
    if (verdict.gate === "auto") { applied.push(event); continue; }
    held.push({ ...event, reason: verdict.reason });
    const id = String(event.id || "");
    if (!revert.has(id)) revert.set(id, new Set());
    revert.get(id).add(event.kind);
  }

  const rows = nextRows.map((row) => {
    const fields = revert.get(String(row.id || ""));
    if (!fields) return row;
    const prior = before.get(String(row.id || ""));
    if (!prior) return row;
    const merged = { ...row };
    // 只回退被拦的那几个字段，同一条目上其它改动照常落地
    for (const field of fields) if (field in prior) merged[field] = prior[field];
    return merged;
  });

  // 被拦下的「条目消失」要把它留在板上，否则等审批期间它已经不见了
  for (const event of held) {
    if (event.kind !== "dropped") continue;
    const prior = before.get(String(event.id || ""));
    if (prior && !rows.some((row) => String(row.id) === String(event.id))) rows.push(prior);
  }

  return { rows, applied, held };
}
