/**
 * 把雷达条目的告警判定送出去。
 *
 * 判定本身在 radar-alerts.mjs，是纯函数；这里只管**谁收得到**和**怎么发**。分开是因为
 * 「什么时候该响」的规则要能单独测，而它一旦和企微 SDK 缠在一起就测不动了。
 *
 * 收件人随阶段扩大（owner → 兜底账号 → 运维群），链路复用定时失败通知那套现成的：
 * 同一份绑定表、同一个兜底账号配置、同一个群 webhook。再造一套的结果是两套各配一半。
 *
 * 扫描是幂等的：每条条目的告警状态存在板目录下的 `_alerts.json`，不进流程分片——
 * 进了的话流程每天整片覆盖一次，就等于把「今天已经提醒过了」忘掉，降噪当场失效。
 */
import { readAuthUsers } from "./auth.mjs";
import { decideRadarAlert, nextRadarAlertState, radarAlertText } from "./radar-alerts.mjs";
import {
  listRadarBoardIds,
  readRadarAlertStates,
  readRadarBoard,
  writeRadarAlertStates,
} from "./radar.mjs";
import { readGlobalEnvObject } from "./user-env.mjs";
import { readWecomBinding } from "./wecom-directory.mjs";
import { sendWecomAppMarkdown, sendWecomGroupMarkdown } from "./wecom.mjs";

/**
 * 按 `recipients` 逐级解析出真正要发的目标。
 *
 * owner 没绑企微时不是跳过，而是落到兜底账号——「没人绑定也别把通知丢了」是这条链存在的
 * 全部意义。三级都空就明说 no_recipient，不要静默吞掉。
 */
export function resolveRecipients(recipients = [], { owner, env = {}, deps = {} } = {}) {
  const readBinding = deps.readWecomBinding || readWecomBinding;
  const fallbackUserId = String(env.AGENTFLOW_SCHEDULE_ALERT_FALLBACK_USER || "").trim();
  const groupWebhook = String(env.AGENTFLOW_SCHEDULE_ALERT_WEBHOOK || "").trim();
  const wanted = new Set(recipients);
  const users = [];
  const seen = new Set();

  if (wanted.has("owner") && owner) {
    const binding = readBinding(owner);
    if (binding?.wecomUserId) { users.push({ via: "owner", userId: owner, wecomUserId: binding.wecomUserId }); seen.add(binding.wecomUserId); }
  }
  // owner 没绑定时，兜底账号要顶上，而不是只在明确要求扩散时才出现
  const needFallback = wanted.has("fallback") || !users.length;
  if (needFallback && fallbackUserId && fallbackUserId !== owner) {
    const binding = readBinding(fallbackUserId);
    if (binding?.wecomUserId && !seen.has(binding.wecomUserId)) {
      users.push({ via: "fallback", userId: fallbackUserId, wecomUserId: binding.wecomUserId });
      seen.add(binding.wecomUserId);
    }
  }
  const webhook = wanted.has("group") && groupWebhook ? groupWebhook : "";
  return { users, webhook, ownerUnbound: Boolean(owner) && !users.some((user) => user.via === "owner") };
}

/**
 * 扫一块板，把该发的告警发出去，并把告警状态写回。
 *
 * 发送失败只记结果、照样推进状态：一条投递不出去的通知，如果每次扫描都重试，
 * 就会把降噪整个绕过去。
 */
export async function sweepRadarBoard(board, { now = Date.now(), deps = {} } = {}) {
  const env = (deps.readGlobalEnv || readGlobalEnvObject)();
  if (String(env?.AGENTFLOW_RADAR_ALERTS ?? "").trim().toLowerCase() === "off") {
    return { board, sent: [], skipped: "disabled" };
  }
  const loaded = (deps.readRadarBoard || readRadarBoard)(board, { scope: "all", now });
  if (!loaded) return { board, sent: [], skipped: "no_board" };

  const states = (deps.readAlertStates || readRadarAlertStates)(board);
  const users = (deps.readAuthUsers || readAuthUsers)();
  const sendApp = deps.sendAppMarkdown || sendWecomAppMarkdown;
  const sendGroup = deps.sendGroupMarkdown || sendWecomGroupMarkdown;
  const nextStates = { ...states };
  const sent = [];
  let changed = false;

  for (const row of loaded.rows) {
    const id = String(row.id || row.title || "").trim();
    if (!id) continue;
    const decision = decideRadarAlert(row, states[id] || {}, now);
    if (!decision.kind) continue;

    const owner = String(row.owner || "");
    const { users: targets, webhook, ownerUnbound } = resolveRecipients(decision.recipients || ["owner"], {
      owner, env, deps,
    });
    if (!targets.length && !webhook) {
      // 没人收得到就不算通知过：等这个人绑定了企微，下一次要从头提醒
      sent.push({ id, kind: decision.kind, ok: false, reason: "no_recipient" });
      continue;
    }

    const username = String(users?.[owner]?.username || owner);
    let markdown = radarAlertText(decision, { ...row, owner: username }, loaded);
    if (ownerUnbound && owner) markdown += `\n\n> ${username} 没有绑定企业微信，转发给你`;

    let ok = true;
    let error = "";
    try {
      for (const target of targets) await sendApp({ toUser: target.wecomUserId, markdown }, env);
      if (webhook) await sendGroup({ webhookUrl: webhook, markdown }, env);
    } catch (e) {
      ok = false;
      error = (e && e.message) || String(e);
    }
    // 状态照样推进：投递失败就重试的话，每次扫描都会再发一遍。
    // 「发失败」和「没人收」是两回事——后者上面已经 continue 掉了，它才该保持原样
    nextStates[id] = nextRadarAlertState(decision, row, states[id] || {}, now);
    changed = true;
    sent.push({ id, kind: decision.kind, ok, ...(error ? { error } : {}), to: targets.map((t) => t.via) });
  }

  // 板上已经没有的条目，它的告警状态留着没意义，顺手清掉
  const live = new Set(loaded.rows.map((row) => String(row.id || row.title || "")));
  for (const id of Object.keys(nextStates)) {
    if (live.has(id)) continue;
    delete nextStates[id];
    changed = true;
  }

  if (changed) (deps.writeAlertStates || writeRadarAlertStates)(board, nextStates);
  return { board, sent };
}

/** 扫全部板。定时 tick 调它 */
export async function sweepAllRadarBoards(options = {}) {
  const boards = (options.deps?.listBoardIds || listRadarBoardIds)();
  const results = [];
  for (const board of boards) results.push(await sweepRadarBoard(board, options));
  return results;
}
