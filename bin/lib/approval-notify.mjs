/**
 * 审批产生时通知人。
 *
 * 在此之前审批只有拉取：`/api/workspace/my-approvals` + 侧栏那一页。**没人打开页面就没人知道**，
 * 于是一条挂起的运行可以静静躺几天——而挂起期间流程是停着的，板上的值是旧的。
 *
 * 投递链复用定时失败通知那套：同一份绑定表、同一个兜底账号、同一个群 webhook。
 * 再造一套的结果是两套各配一半。
 *
 * 通知失败**绝不能让审批创建失败**：宁可没人收到提醒（页面上还看得见），
 * 也不能因为企微挂了就让整条运行崩掉。
 */
import { readAuthUsers } from "./auth.mjs";
import { readGlobalEnvObject } from "./user-env.mjs";
import { readWecomBinding } from "./wecom-directory.mjs";
import { sendWecomAppMarkdown, sendWecomGroupMarkdown } from "./wecom.mjs";

/** 审批理由 → 给人看的一句话。`reason` 同时是审批页上的 tag */
const REASON_LABEL = {
  radar_gate: "雷达追踪项变更",
  plan_confirmation: "执行计划确认",
  user_confirmation: "人工确认",
};

/** 正文。说清楚「谁、为什么、要你看什么」，只有一句「有审批待处理」等于没通知 */
export function approvalText(record = {}, { baseUrl = "" } = {}) {
  const label = REASON_LABEL[String(record.reason || "")] || String(record.reason || "待确认");
  const lines = [
    `**待你确认：${label}**`,
    `> 流程：${record.flowId || "-"}`,
    `> 发起：${record.requestedBy || record.userId || "-"}`,
  ];
  const content = String(record?.value?.content || "").trim();
  if (content) {
    // 企微 markdown 有长度上限，正文只带开头——细节在审批页看
    const brief = content.length > 600 ? `${content.slice(0, 600)}…` : content;
    lines.push("", brief);
  }
  if (baseUrl) lines.push("", `[去审批](${baseUrl.replace(/\/+$/, "")}/approvals)`);
  return lines.join("\n");
}

/**
 * 把一条新建的审批推给该看的人。
 *
 * 没有指定 approvers 时不发：那种中断是「谁看见谁处理」，群发只会变成噪音。
 */
export async function notifyApproval(record = {}, { deps = {} } = {}) {
  const approvers = Array.isArray(record.approvers) ? record.approvers.filter(Boolean) : [];
  if (!approvers.length) return { ok: false, reason: "no_approvers" };

  const env = (deps.readGlobalEnv || readGlobalEnvObject)();
  if (String(env?.AGENTFLOW_APPROVAL_NOTIFY ?? "").trim().toLowerCase() === "off") {
    return { ok: false, reason: "disabled" };
  }
  const readBinding = deps.readWecomBinding || readWecomBinding;
  const users = (deps.readAuthUsers || readAuthUsers)();
  const sendApp = deps.sendAppMarkdown || sendWecomAppMarkdown;
  const sendGroup = deps.sendGroupMarkdown || sendWecomGroupMarkdown;

  const targets = [];
  const unbound = [];
  for (const approver of approvers) {
    const binding = readBinding(approver);
    if (binding?.wecomUserId) targets.push({ userId: approver, wecomUserId: binding.wecomUserId });
    else unbound.push(String(users?.[approver]?.username || approver));
  }

  const fallbackUserId = String(env.AGENTFLOW_SCHEDULE_ALERT_FALLBACK_USER || "").trim();
  // 审批人一个都没绑定时落到兜底账号——审批卡住比通知发错人贵得多
  if (!targets.length && fallbackUserId) {
    const binding = readBinding(fallbackUserId);
    if (binding?.wecomUserId) targets.push({ userId: fallbackUserId, wecomUserId: binding.wecomUserId, via: "fallback" });
  }
  if (!targets.length) return { ok: false, reason: "no_recipient", unbound };

  let markdown = approvalText(record, { baseUrl: String(env.AGENTFLOW_PUBLIC_BASE_URL || env.AGENTFLOW_SHARE_BASE_URL || "") });
  if (unbound.length) markdown += `\n\n> ${unbound.join("、")} 没有绑定企业微信，转发给你`;

  const sent = [];
  for (const target of targets) {
    try {
      await sendApp({ toUser: target.wecomUserId, markdown }, env);
      sent.push({ userId: target.userId, ok: true, via: target.via || "approver" });
    } catch (e) {
      sent.push({ userId: target.userId, ok: false, error: (e && e.message) || String(e) });
    }
  }
  const webhook = String(env.AGENTFLOW_APPROVAL_WEBHOOK || "").trim();
  if (webhook) {
    try {
      await sendGroup({ webhookUrl: webhook, markdown }, env);
      sent.push({ via: "group", ok: true });
    } catch (e) {
      sent.push({ via: "group", ok: false, error: (e && e.message) || String(e) });
    }
  }
  return { ok: sent.some((item) => item.ok), sent };
}
