function requireValue(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function envValue(env, names) {
  for (const name of names) {
    const value = env?.[name];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function buildWebhookUrl(webhookUrl, webhookKey, env = {}) {
  const explicitUrl = String(webhookUrl || "").trim() || envValue(env, ["WECOM_GROUP_WEBHOOK", "WECOM_BOT_WEBHOOK", "WECHAT_WORK_BOT_WEBHOOK"]);
  if (explicitUrl) return explicitUrl;
  const key = String(webhookKey || "").trim() || envValue(env, ["WECOM_GROUP_WEBHOOK_KEY", "WECOM_BOT_KEY", "WECHAT_WORK_BOT_KEY"]);
  if (!key) throw new Error("webhookUrl or webhookKey is required");
  return `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(key)}`;
}

async function requestJson(url, options = {}) {
  if (typeof fetch !== "function") {
    throw new Error("global fetch is not available in this Node.js runtime");
  }
  const resp = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await resp.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
  return json;
}

function assertWecomOk(json, action) {
  const errcode = Number(json?.errcode ?? 0);
  if (errcode !== 0) {
    throw new Error(`${action} failed: ${json?.errmsg || JSON.stringify(json)}`);
  }
  return json;
}

export async function sendWecomGroupMarkdown(params = {}, env = {}) {
  const content = requireValue(params.markdown ?? params.content, "markdown");
  const webhookUrl = buildWebhookUrl(params.webhookUrl, params.webhookKey, env);
  const json = await requestJson(webhookUrl, {
    method: "POST",
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: { content },
    }),
  });
  assertWecomOk(json, "send wecom group markdown");
  return {
    ok: true,
    message: "企业微信群 Markdown 已发送",
    response: json,
  };
}

export async function getWecomAccessToken(params = {}, env = {}) {
  const corpId = requireValue(params.corpId || envValue(env, ["WECOM_CORP_ID", "WECHAT_WORK_CORP_ID", "WXWORK_CORP_ID"]), "corpId");
  const corpSecret = requireValue(params.corpSecret || envValue(env, ["WECOM_APP_SECRET", "WECOM_CORP_SECRET", "WECHAT_WORK_APP_SECRET", "WXWORK_APP_SECRET"]), "corpSecret");
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
  const json = await requestJson(url, { method: "GET" });
  assertWecomOk(json, "get wecom access_token");
  return requireValue(json.access_token, "access_token");
}

export async function sendWecomAppMarkdown(params = {}, env = {}) {
  const content = requireValue(params.markdown ?? params.content, "markdown");
  const toUser = requireValue(params.toUser || envValue(env, ["WECOM_TO_USER", "WECHAT_WORK_TO_USER", "WXWORK_TO_USER"]), "toUser");
  const agentIdRaw = requireValue(params.agentId || envValue(env, ["WECOM_AGENT_ID", "WECHAT_WORK_AGENT_ID", "WXWORK_AGENT_ID"]), "agentId");
  const agentId = Number(agentIdRaw);
  if (!Number.isFinite(agentId) || agentId <= 0) throw new Error(`Invalid agentId: ${agentIdRaw}`);
  const accessToken = String(params.accessToken || "").trim() || await getWecomAccessToken(params, env);
  const json = await requestJson(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`, {
    method: "POST",
    body: JSON.stringify({
      touser: toUser,
      msgtype: "markdown",
      agentid: agentId,
      markdown: { content },
    }),
  });
  assertWecomOk(json, "send wecom app markdown");
  return {
    ok: true,
    message: "企业微信应用 Markdown 已发送",
    response: json,
  };
}
