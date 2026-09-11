/**
 * 雷达条目的告警判定。
 *
 * 一条原则贯穿始终：**只有未完成的才告警**。已经满足的、人工封存的，无论离截止日多近、
 * 过期多久，都不该出声——催一件已经做完的事，是让人静音这个应用最快的方式。
 *
 * 第二条原则：**过期之前降噪，过期之后升噪**。
 *
 * 截止日之前这是「追踪」：跨过 T-90 / T-30 / T-7 各提醒一次，其余时间闭嘴，免得人把通知
 * 关掉。截止日之后这是「事故」：它已经在烧了，该每天出声，而且收件人要逐级扩大——
 * owner → 加上兜底账号 → 加上群。这不是重复发送，是升级。
 *
 * 判定是纯函数，状态由调用方存回条目上。和定时失败通知那套（schedule-alerts.mjs）
 * 是同一套骨架，但阶段不同，所以没有合并——把两组不同的状态机塞进一个函数，
 * 结果是两边都读不懂。
 */

/** 截止日之前的提醒档位，单位天。跨过哪一档就发哪一档，不补发更早的 */
export const RADAR_ALERT_THRESHOLDS = [90, 30, 7];
/** 过期之后每天最多一条 */
const OVERDUE_REPEAT_MS = 24 * 60 * 60 * 1000;
/** 人的判断和脚本观测矛盾多久之后，提醒本人复核一次 */
export const OVERRIDE_CONFLICT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;


function toTime(value) {
  if (value === undefined || value === null || value === "") return NaN;
  const time = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(time) ? time : NaN;
}

/** 收件人随阶段逐级扩大。这是升级，不是重复 */
function recipientsFor(kind) {
  if (kind === "overdue" || kind === "overdue_daily") return ["owner", "fallback", "group"];
  if (kind === "threshold") return ["owner"];
  return ["owner"];
}

/**
 * 该不该为这一条发告警，以及发哪一种。
 *
 * @param {object} row 已经 decorate 过的条目（带 state / overdue / settled / daysLeft）
 * @param {{ lastKind?: string, lastAt?: number, sentThresholds?: number[], lastAlertState?: string }} alert
 *   上一次告警留下的状态，存在条目上
 * @param {number} now
 * @returns {{ kind: string|null, reason: string, recipients?: string[], threshold?: number }}
 */
export function decideRadarAlert(row = {}, alert = {}, now = Date.now()) {
  const state = String(row?.state || "");
  const previousState = String(alert?.lastAlertState || "");

  // 已封存：人明确说过不用再盯了。政策改期让流程重新写它时，调用方会清掉 settled
  if (row?.settled === true) return { kind: null, reason: "settled" };

  /**
   * 人说完成、脚本说没完成。
   *
   * 必须挡在「完成就闭嘴」前面：人一标成 ok，`row.state` 就是 ok 了，放在后面这段永远走不到。
   * 尊重人——不告警——但矛盾挂太久要提醒本人回头看一眼，否则一次点击就把一次真实退化
   * 永久盖住了。也不发「已完成」：那是人自己刚点的，再通知他一遍纯属噪音。
   */
  if (row?.overrideConflict && String(row?.override?.state || "") === "ok") {
    const at = toTime(row?.override?.at);
    if (Number.isFinite(at) && now - at > OVERRIDE_CONFLICT_GRACE_MS && alert?.lastKind !== "override_conflict") {
      return { kind: "override_conflict", reason: "override_conflict", recipients: ["owner"] };
    }
    return { kind: null, reason: "override_ok" };
  }

  // 完成了。如果上一次是「未完成」状态下发过告警，补一条「好了」然后闭嘴
  if (state === "ok") {
    if (previousState && previousState !== "ok") {
      return { kind: "cleared", reason: "cleared", recipients: recipientsFor("cleared") };
    }
    return { kind: null, reason: "done" };
  }

  if (row?.overdue) {
    const lastAt = toTime(alert?.lastAt);
    // 越过截止日的第一条，收件人就地扩大
    if (alert?.lastKind !== "overdue" && alert?.lastKind !== "overdue_daily") {
      return { kind: "overdue", reason: "just_overdue", recipients: recipientsFor("overdue") };
    }
    if (!Number.isFinite(lastAt) || now - lastAt >= OVERDUE_REPEAT_MS) {
      return { kind: "overdue_daily", reason: "still_overdue", recipients: recipientsFor("overdue_daily") };
    }
    return { kind: null, reason: "muted_overdue" };
  }

  // `Number(null)` 是 0，而 0 是有限数——不显式挡掉的话，没有截止日期的条目会被当成
  // 「剩 0 天」，一上来就触发 T-7
  const daysLeft = row?.daysLeft === null || row?.daysLeft === undefined ? NaN : Number(row.daysLeft);
  if (!Number.isFinite(daysLeft)) return { kind: null, reason: "no_due" };

  const sent = new Set((Array.isArray(alert?.sentThresholds) ? alert.sentThresholds : []).map(Number));
  // 跨过哪一档发哪一档。一次跨过好几档时只发最小的那档——它最紧急，也最能说明问题
  const crossed = RADAR_ALERT_THRESHOLDS.filter((day) => daysLeft <= day && !sent.has(day));
  if (crossed.length) {
    const threshold = Math.min(...crossed);
    return { kind: "threshold", reason: `t_minus_${threshold}`, threshold, recipients: recipientsFor("threshold") };
  }

  return { kind: null, reason: "quiet" };
}

/** 发完之后要写回条目上的告警状态 */
export function nextRadarAlertState(decision, row = {}, alert = {}, now = Date.now()) {
  if (!decision?.kind) return alert;
  const sent = new Set((Array.isArray(alert?.sentThresholds) ? alert.sentThresholds : []).map(Number));
  if (decision.kind === "threshold" && Number.isFinite(decision.threshold)) {
    // 已经跨过的更大档位一并记上：T-30 才接手时，不该回头再补一条 T-90
    for (const day of RADAR_ALERT_THRESHOLDS) if (day >= decision.threshold) sent.add(day);
  }
  if (decision.kind === "cleared") {
    // 完成之后清空档位：日期又被推后、重新变回未完成时，该从头提醒一轮
    return { lastKind: "cleared", lastAt: now, sentThresholds: [], lastAlertState: String(row?.state || "") };
  }
  return {
    lastKind: decision.kind,
    lastAt: now,
    sentThresholds: [...sent].sort((left, right) => right - left),
    lastAlertState: String(row?.state || ""),
  };
}

/** 告警正文。带上「为什么现在收到这条」，否则人只会觉得被打扰 */
export function radarAlertText(decision, row = {}, board = {}) {
  const title = String(row?.title || row?.id || "追踪项");
  const where = `${board?.title || board?.board || "雷达"}`;
  const days = Number(row?.daysLeft);
  const lines = [];
  if (decision.kind === "cleared") {
    lines.push(`**已完成：${title}**`, `> 来自：${where}`, "", "这一条不用再管了。");
    return lines.join("\n");
  }
  if (decision.kind === "override_conflict") {
    lines.push(
      `**标记与扫描结果不符：${title}**`,
      `> 来自：${where}`,
      `> 你在 ${String(row?.override?.at || "").slice(0, 10)} 标成了已完成`,
      `> 但最近一次扫描仍然是：${row?.observedState || "未完成"}（${row?.current || "-"}）`,
      "",
      "麻烦回头看一眼：是扫描规则该改，还是这一条其实退回去了。",
    );
    return lines.join("\n");
  }
  const head = decision.kind === "threshold"
    ? `**还剩 ${days} 天：${title}**`
    : `**已经过期${Number.isFinite(days) && days < 0 ? ` ${Math.abs(days)} 天` : ""}：${title}**`;
  lines.push(
    head,
    `> 来自：${where}`,
    `> 负责人：${row?.owner || "无人认领"}`,
    `> 现状：${row?.current || "-"}`,
    `> 要求：${row?.required || "-"}`,
  );
  if (row?.effectiveTrain) lines.push(`> 有效截止：${row.effectiveTrain} 封包`);
  return lines.join("\n");
}
