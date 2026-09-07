// 企业微信按 UTF-8 字节数限长，超一个字节就整条 40058 打回：群机器人 markdown 4096、应用消息 2048。
const WECOM_GROUP_MARKDOWN_MAX_BYTES = 4096;
const WECOM_APP_MARKDOWN_MAX_BYTES = 2048;
// 多段时每段要加 "（i/n）\n" 前缀，预留够宽的余量。
const WECOM_CHUNK_LABEL_RESERVE_BYTES = 24;

function utf8Bytes(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

// 返回在 maxBytes 预算内能容纳的最长前缀长度（按码点切，不切碎字符）。
function takeWithinBytes(text, maxBytes) {
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const size = utf8Bytes(ch);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += ch.length;
  }
  return end;
}

export function chunkMarkdownByBytes(content, maxBytes) {
  if (utf8Bytes(content) <= maxBytes) return [content];
  const budget = Math.max(1, maxBytes - WECOM_CHUNK_LABEL_RESERVE_BYTES);
  const chunks = [];
  let rest = content;
  while (utf8Bytes(rest) > budget) {
    let end = takeWithinBytes(rest, budget);
    if (end <= 0) end = 1;
    // 尽量在换行处断开，但不要为了对齐行边界把这一段切得太短。
    const newline = rest.lastIndexOf("\n", end - 1);
    if (newline > 0 && newline >= Math.floor(end / 2)) end = newline + 1;
    chunks.push(rest.slice(0, end).replace(/\s+$/, ""));
    rest = rest.slice(end).replace(/^\n+/, "");
  }
  if (rest.trim()) chunks.push(rest);
  const total = chunks.length;
  return chunks.map((chunk, index) => `（${index + 1}/${total}）\n${chunk}`);
}

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
  const chunks = chunkMarkdownByBytes(content, WECOM_GROUP_MARKDOWN_MAX_BYTES);
  const responses = [];
  for (const [index, chunk] of chunks.entries()) {
    const action = chunks.length > 1
      ? `send wecom group markdown part ${index + 1}/${chunks.length}`
      : "send wecom group markdown";
    const json = await requestJson(webhookUrl, {
      method: "POST",
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { content: chunk },
      }),
    });
    assertWecomOk(json, action);
    responses.push(json);
  }
  return {
    ok: true,
    message: chunks.length > 1
      ? `企业微信群 Markdown 已分 ${chunks.length} 段发送`
      : "企业微信群 Markdown 已发送",
    parts: chunks.length,
    response: chunks.length > 1 ? responses : responses[0],
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
  const chunks = chunkMarkdownByBytes(content, WECOM_APP_MARKDOWN_MAX_BYTES);
  const responses = [];
  for (const [index, chunk] of chunks.entries()) {
    const action = chunks.length > 1
      ? `send wecom app markdown part ${index + 1}/${chunks.length}`
      : "send wecom app markdown";
    const json = await requestJson(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`, {
      method: "POST",
      body: JSON.stringify({
        touser: toUser,
        msgtype: "markdown",
        agentid: agentId,
        markdown: { content: chunk },
      }),
    });
    assertWecomOk(json, action);
    responses.push(json);
  }
  return {
    ok: true,
    message: chunks.length > 1
      ? `企业微信应用 Markdown 已分 ${chunks.length} 段发送`
      : "企业微信应用 Markdown 已发送",
    parts: chunks.length,
    response: chunks.length > 1 ? responses : responses[0],
  };
}
