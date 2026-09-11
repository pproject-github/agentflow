/**
 * 定时任务失败通知。
 *
 * 在这之前，一条定时坏掉的唯一痕迹是登记表里的 `lastStatus` / `lastError`——没人主动去看
 * 就没人知道。线上真发生过一条每半小时跑一次的流程连炸两天、失败 126 次没人察觉。
 *
 * 降噪是这件事的主要难点，不是发消息本身：一条每半小时跑一次的流程一天能失败 48 次，如果每次
 * 都发，收件人第二天就会把这个应用静音，于是通知等于没做。所以：
 *
 * - 状态从「好」变「坏」的那一次发一条；
 * - 一直坏着，每天最多再补一条（提醒它还没好，但不刷屏）；
 * - 恢复时发一条，这条比失败通知更重要——它让人知道问题结束了，不用去猜。
 *
 * 收件人是这条定时的 owner，取他绑定的企业微信 userid（见 wecom-directory.mjs）。没绑定
 * 的人退回运维群 webhook；两者都没有就跳过，绝不把失败通知本身变成一次失败。
 */
import { readWecomBinding } from "./wecom-directory.mjs";
import { readAuthUsers } from "./auth.mjs";
import { sendWecomAppMarkdown, sendWecomGroupMarkdown } from "./wecom.mjs";
import { readGlobalEnvObject } from "./user-env.mjs";

/** 同一条定时持续失败时，两次通知之间至少隔这么久 */
export const SCHEDULE_ALERT_REPEAT_MS = 24 * 60 * 60 * 1000;
/** 错误正文截断长度：企微消息里贴整段堆栈没人看，第一行才是信息 */
const ERROR_EXCERPT_MAX = 400;

function truncateError(error) {
  const text = String(error || "").trim();
  if (!text) return "";
  const firstLine = text.split(/\r?\n/)[0].trim();
  const body = firstLine.length >= 24 ? firstLine : text;
  return body.length > ERROR_EXCERPT_MAX ? `${body.slice(0, ERROR_EXCERPT_MAX)}…` : body;
}

function scheduleLink(entry, publicBaseUrl) {
  const base = String(publicBaseUrl || "").replace(/\/+$/, "");
  if (!base) return "";
  const query = new URLSearchParams({
    flowId: String(entry?.flowId || ""),
    flowSource: String(entry?.flowSource || "user"),
  });
  const nodeId = String(entry?.scheduleNodeId || "");
  if (nodeId) query.set("focusNodeId", nodeId);
  return `${base}/workspace?${query.toString()}`;
}

/**
 * 该不该发，以及发哪一种。纯函数，好测。
 * @param {{ lastAlertStatus?: string, lastFailureAlertAt?: number }} alertState 登记表里存的上一次通知状态
 * @param {"success"|"failed"|string} status 这次运行的结果
 * @param {number} now
 * @returns {{ kind: "failed"|"recovered"|null, reason: string }}
 */
export function decideScheduleAlert(alertState = {}, status, now = Date.now()) {
  const previous = String(alertState?.lastAlertStatus || "");
  if (status === "failed") {
    if (previous !== "failed") return { kind: "failed", reason: "first_failure" };
    const lastAt = Number(alertState?.lastFailureAlertAt || 0);
    if (!Number.isFinite(lastAt) || now - lastAt >= SCHEDULE_ALERT_REPEAT_MS) {
      return { kind: "failed", reason: "still_failing" };
    }
    // 还在坏着，但今天已经说过了
    return { kind: null, reason: "muted_repeat" };
  }
  if (status === "success") {
    if (previous === "failed") return { kind: "recovered", reason: "recovered" };
    return { kind: null, reason: "still_healthy" };
  }
  // stopped / skipped / disabled 这些不是"坏了"，不打扰人
  return { kind: null, reason: `ignored_status:${status}` };
}

function buildMarkdown({ kind, entry, error, reason, link, username }) {
  const label = String(entry?.label || entry?.flowId || "定时任务");
  const where = `${entry?.flowId || "-"} · ${entry?.scheduleNodeId || "-"}`;
  const cron = `${entry?.cron || "-"}（${entry?.timezone || "Asia/Shanghai"}）`;
  const lines = kind === "recovered"
    ? [
      `**定时任务已恢复：${label}**`,
      `> 流程：${where}`,
      `> 计划：${cron}`,
      "",
      "上一次失败已经过去，这次跑成功了。",
    ]
    : [
      `**定时任务失败：${label}**`,
      `> 负责人：${username || "-"}`,
      `> 流程：${where}`,
      `> 计划：${cron}`,
      ...(reason === "still_failing" ? ["> 状态：持续失败中（每天提醒一次）"] : []),
      "",
      `\`\`\`\n${error || "未提供错误信息"}\n\`\`\``,
    ];
  if (link) lines.push("", `[打开这个节点](${link})`);
  return lines.join("\n");
}

/**
 * 发一条定时结果通知，并返回要写回登记表的通知状态。
 *
 * 发送失败只记日志：通知链路不能反过来影响运行本身，更不能让一次投递问题把调度拖垮。
 * @param {object} input
 * @param {object} input.entry 登记表里的这条定时
 * @param {"success"|"failed"|string} input.status
 * @param {string} [input.error]
 * @param {object} [input.deps] 便于测试注入
 */
export async function notifyScheduleOutcome(input = {}) {
  const {
    entry = {},
    status,
    error = "",
    now = Date.now(),
    publicBaseUrl = process.env.AGENTFLOW_PUBLIC_BASE_URL || process.env.AGENTFLOW_SHARE_BASE_URL || "",
    deps = {},
  } = input;

  const env = (deps.readGlobalEnv || readGlobalEnvObject)();
  const enabled = String(env?.AGENTFLOW_SCHEDULE_ALERTS ?? "").trim().toLowerCase() !== "off";
  const decision = decideScheduleAlert(entry?.alert, status, now);
  if (!enabled) return { sent: false, reason: "disabled", alert: entry?.alert };
  if (!decision.kind) return { sent: false, reason: decision.reason, alert: entry?.alert };

  const userId = String(entry?.userId || "").trim();
  const binding = userId ? (deps.readWecomBinding || readWecomBinding)(userId) : null;
  const users = (deps.readAuthUsers || readAuthUsers)();
  const username = String(users?.[userId]?.username || userId);
  const groupWebhook = String(env?.AGENTFLOW_SCHEDULE_ALERT_WEBHOOK || "").trim();

  const markdown = buildMarkdown({
    kind: decision.kind,
    entry,
    error: truncateError(error),
    reason: decision.reason,
    link: scheduleLink(entry, publicBaseUrl),
    username,
  });

  // 通知状态无论发没发成功都要推进：否则一条投递不出去的通知会每次运行都重试，
  // 把降噪彻底绕过去
  const alert = {
    lastAlertStatus: status === "failed" ? "failed" : "success",
    ...(decision.kind === "failed" ? { lastFailureAlertAt: now } : { lastFailureAlertAt: 0 }),
    lastAlertAt: now,
    lastAlertKind: decision.kind,
  };

  try {
    if (binding?.wecomUserId) {
      await (deps.sendAppMarkdown || sendWecomAppMarkdown)({ toUser: binding.wecomUserId, markdown }, env);
      return { sent: true, via: "app", toUser: binding.wecomUserId, kind: decision.kind, reason: decision.reason, alert };
    }
    if (groupWebhook) {
      await (deps.sendGroupMarkdown || sendWecomGroupMarkdown)({ webhookUrl: groupWebhook, markdown }, env);
      return { sent: true, via: "group", kind: decision.kind, reason: decision.reason, alert };
    }
    // 没人可通知：不推进状态，等这个人绑定了企微再从头提醒一次
    return { sent: false, reason: "no_recipient", alert: entry?.alert };
  } catch (e) {
    return {
      sent: false,
      reason: "send_failed",
      error: (e && e.message) || String(e),
      kind: decision.kind,
      alert,
    };
  }
}
