/**
 * 登录名 → 企业微信 userid 的绑定。
 *
 * 企微投递认的是 openid（`00320` 这种工号式 ID），AgentFlow 认的是登录名
 * （`wangfang1`）。两者对不上，就是线上那批「user & party & tag all invalid」的来源。
 *
 * 换算本身内网早就有了——Privilege 用户中心按 user_name 查得到 openid，marketplace 里
 * `my_wecom_id` 节点就是这么做的。问题是它停在节点层：每个人在自己的流程里拼一遍，平台
 * 不知道结果，于是「当前用户的企微是谁」这个问题，每条流程都要重新解一次。
 *
 * 这里把它收进平台：查一次、存进用户记录，运行时统一注入（见 user-env.mjs）。
 */
import { readAuthUsers, writeAuthUserNotify } from "./auth.mjs";

const DEFAULT_PRIVILEGE_URL = "https://privileges.bigo.sg";
const DEFAULT_PRIVILEGE_USER_API = "/api/getUserList";

function envValue(env = {}, keys = []) {
  for (const key of keys) {
    const value = String(env?.[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

/** 拿去 Privilege 查的名字：CAS 用户名优先，本地账号退回 userId */
export function directoryLookupName(userId, users = readAuthUsers()) {
  const id = String(userId || "").trim();
  if (!id) return "";
  return String(users?.[id]?.casUsername || "").trim() || id;
}

/**
 * 读已经存下来的绑定。同步——运行时注入走的就是这条，不能等网络。
 * @returns {{ wecomUserId: string, source: string, verifiedAt: string, lookupName: string } | null}
 */
export function readWecomBinding(userId, users = readAuthUsers()) {
  const id = String(userId || "").trim();
  if (!id) return null;
  const notify = users?.[id]?.notify;
  const wecomUserId = String(notify?.wecomUserId || "").trim();
  if (!wecomUserId) return null;
  return {
    wecomUserId,
    source: String(notify?.wecomUserIdSource || ""),
    verifiedAt: String(notify?.wecomUserIdVerifiedAt || ""),
    lookupName: String(notify?.wecomLookupName || ""),
  };
}

/** 直接查 Privilege，不读缓存也不写缓存。 */
export async function lookupWecomUserIdFromPrivilege(lookupName, env = {}) {
  const username = String(lookupName || "").trim();
  if (!username) throw new Error("缺少查询用户名");
  const password = envValue(env, ["PRIVILEGE_PASSWORD", "Privilege_Password", "PRIVILEGE_PASS"]);
  if (!password) {
    throw new Error("缺少 PRIVILEGE_PASSWORD，请在全局环境变量里配置 Privilege 账号密码");
  }
  const account = envValue(env, ["PRIVILEGE_ACCOUNT", "Privilege_Account"]) || username;
  const baseUrl = (envValue(env, ["PRIVILEGE_URL", "Privilege_Url"]) || DEFAULT_PRIVILEGE_URL).replace(/\/$/, "");
  const userApi = envValue(env, ["PRIVILEGE_USER_API", "Privilege_UserApi"]) || DEFAULT_PRIVILEGE_USER_API;

  const url = new URL(userApi.startsWith("http") ? userApi : `${baseUrl}${userApi}`);
  url.searchParams.set("disabled", "0");
  url.searchParams.set("user_name", username);
  const auth = Buffer.from(`${account}:${password}`, "utf8").toString("base64");

  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Privilege 返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(`Privilege HTTP ${response.status}：${text.slice(0, 200)}`);
  if (body?.errcode != null && Number(body.errcode) !== 0) {
    throw new Error(`Privilege errcode=${body.errcode} ${body.errmsg || ""}`);
  }
  const list = Array.isArray(body?.data) ? body.data : [];
  // 精确匹配优先；查不到精确的才退回第一条——和 my_wecom_id 节点保持同一套判定
  const hit = list.find((item) => String(item?.user_name || item?.name || "").trim() === username) || list[0];
  if (!hit) throw new Error(`Privilege 里没有 user_name=${username} 这个人`);
  const wecomUserId = String(hit.openid || "").trim();
  if (!wecomUserId) throw new Error(`Privilege 用户 ${username} 的 openid 是空的`);
  return wecomUserId;
}

/**
 * 解析并落盘某个用户的企微 userid。
 * @param {string} userId AgentFlow 用户
 * @param {{ env?: Record<string,string>, force?: boolean }} [options] `force` 忽略已有绑定重新查
 */
export async function resolveWecomUserId(userId, options = {}) {
  const id = String(userId || "").trim();
  if (!id) return { ok: false, error: "缺少 userId" };
  const users = readAuthUsers();
  if (!users[id]) return { ok: false, error: `用户不存在：${id}` };
  if (options.force !== true) {
    const cached = readWecomBinding(id, users);
    if (cached) return { ok: true, cached: true, ...cached };
  }
  const lookupName = directoryLookupName(id, users);
  try {
    const wecomUserId = await lookupWecomUserIdFromPrivilege(lookupName, options.env || {});
    const verifiedAt = new Date().toISOString();
    writeAuthUserNotify(id, {
      wecomUserId,
      wecomUserIdSource: "privilege",
      wecomUserIdVerifiedAt: verifiedAt,
      wecomLookupName: lookupName,
    });
    return { ok: true, cached: false, wecomUserId, source: "privilege", verifiedAt, lookupName };
  } catch (error) {
    return { ok: false, lookupName, error: (error && error.message) || String(error) };
  }
}

/** 手工指定绑定（Privilege 查不到、或要发给别人时的兜底）。 */
export function writeManualWecomBinding(userId, wecomUserId) {
  const value = String(wecomUserId || "").trim();
  if (!value) return { ok: false, error: "企微 userid 不能为空" };
  const saved = writeAuthUserNotify(userId, {
    wecomUserId: value,
    wecomUserIdSource: "manual",
    wecomUserIdVerifiedAt: new Date().toISOString(),
    wecomLookupName: directoryLookupName(userId),
  });
  if (!saved) return { ok: false, error: `用户不存在：${userId}` };
  return { ok: true, wecomUserId: value, source: "manual", verifiedAt: saved.wecomUserIdVerifiedAt };
}

/**
 * 批量补齐。串行跑——46 个人量级，别把 Privilege 打出限流。
 * @param {{ env?: Record<string,string>, userIds?: string[], force?: boolean }} [options]
 */
export async function backfillWecomBindings(options = {}) {
  const users = readAuthUsers();
  const targets = Array.isArray(options.userIds) && options.userIds.length
    ? options.userIds.map(String)
    : Object.keys(users);
  const rows = [];
  for (const userId of targets) {
    if (!users[userId]) {
      rows.push({ userId, ok: false, error: "用户不存在" });
      continue;
    }
    // 链接过来的历史账号自己不跑流程，跳过，避免白查一遍
    if (String(users[userId]?.linkedToUserId || "").trim()) {
      rows.push({ userId, ok: true, skipped: "linked", wecomUserId: "" });
      continue;
    }
    rows.push({ userId, ...(await resolveWecomUserId(userId, options)) });
  }
  return {
    total: rows.length,
    bound: rows.filter((row) => row.ok && row.wecomUserId).length,
    failed: rows.filter((row) => !row.ok).length,
    rows,
  };
}

/**
 * 反查：企微 userid → AgentFlow 用户。
 *
 * 外部应用（比如萌买）手里只有企微 id，要代表这个人操作就得先落到我们的用户上。
 * 只认绑定来源是 `privilege` 的——`manual` 是管理员手填的，可能填错，不能当强身份用。
 * @param {string} wecomUserId
 * @param {{ allowManual?: boolean }} [options]
 */
export function findUserIdByWecomUserId(wecomUserId, options = {}) {
  const target = String(wecomUserId || "").trim();
  if (!target) return null;
  const users = readAuthUsers();
  const matches = [];
  for (const [userId, user] of Object.entries(users)) {
    const notify = user?.notify;
    if (String(notify?.wecomUserId || "").trim() !== target) continue;
    const source = String(notify?.wecomUserIdSource || "");
    if (source !== "privilege" && options.allowManual !== true) continue;
    // 历史链接账号自己不干活，真正的身份在它指向的那个账号上
    if (String(user?.linkedToUserId || "").trim()) continue;
    matches.push({ userId, source });
  }
  // 同一个企微 id 落到多个账号是数据问题，不猜——猜错等于把身份判给别人
  if (matches.length !== 1) return null;
  return matches[0];
}
