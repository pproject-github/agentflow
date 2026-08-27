import crypto from "crypto";
import fs from "fs";
import path from "path";

import { getAgentflowDataRoot } from "./paths.mjs";

const CAS_FLOW_COOKIE = "af_cas_flow";
const CAS_FLOW_TTL_MS = 10 * 60 * 1000;
const CAS_REQUEST_TIMEOUT_MS = 8_000;
const MAX_CAS_FLOWS = 512;
const DEFAULT_CAS_BASE_URL = "https://auth.bigo.sg/cas/";

function enabledFlag(value, fallback = false) {
  if (value == null || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function ensureTrailingSlash(value) {
  const text = String(value || "").trim();
  return text.endsWith("/") ? text : `${text}/`;
}

function flowStorePath() {
  return path.join(getAgentflowDataRoot(), "auth", "cas-flows.json");
}

function readFlowStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(flowStorePath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeFlowStore(store) {
  const filePath = flowStorePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(store || {}, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function purgeExpiredFlows(store, now = Date.now()) {
  let changed = false;
  for (const [key, flow] of Object.entries(store || {})) {
    if (Number(flow?.expiresAt) > now) continue;
    delete store[key];
    changed = true;
  }
  return changed;
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function xmlEntityDecode(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlTagText(xml, name) {
  const match = String(xml || "").match(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${name}>`, "i"));
  return match ? xmlEntityDecode(match[1].replace(/<[^>]+>/g, "").trim()) : "";
}

function casEndpoint(baseUrl, endpoint, params = {}) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

export function readCasAuthConfig(publicBaseUrl = "") {
  const enabled = enabledFlag(process.env.AGENTFLOW_CAS_ENABLED, false);
  let baseUrl = "";
  try {
    const parsed = new URL(ensureTrailingSlash(process.env.AGENTFLOW_CAS_BASE_URL || DEFAULT_CAS_BASE_URL));
    if (["http:", "https:"].includes(parsed.protocol)) baseUrl = parsed.toString();
  } catch {
    baseUrl = "";
  }
  const normalizedPublicBase = String(publicBaseUrl || "").replace(/\/+$/, "");
  const serviceUrl = String(process.env.AGENTFLOW_CAS_SERVICE_URL || "").trim()
    || (normalizedPublicBase ? `${normalizedPublicBase}/api/auth/cas/callback` : "");
  return {
    enabled,
    baseUrl,
    serviceUrl,
    legacyPasswordLoginEnabled: enabledFlag(process.env.AGENTFLOW_LEGACY_PASSWORD_LOGIN, !enabled),
  };
}

export function sanitizeCasReturnTo(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 2048) return "/projects";
  try {
    const url = new URL(raw, "https://agentflow.invalid");
    if (url.origin !== "https://agentflow.invalid") return "/projects";
    if (!url.pathname.startsWith("/") || url.pathname.startsWith("/api/auth/cas")) return "/projects";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/projects";
  }
}

export function beginCasLogin({ publicBaseUrl, returnTo = "/projects", secure = false } = {}) {
  const config = readCasAuthConfig(publicBaseUrl);
  if (!config.enabled) return { ok: false, status: 404, error: "CAS login is not enabled" };
  if (!config.baseUrl) return { ok: false, status: 503, error: "AGENTFLOW_CAS_BASE_URL is invalid" };
  if (!config.serviceUrl) return { ok: false, status: 503, error: "AGENTFLOW_CAS_SERVICE_URL or public base URL is required" };
  const now = Date.now();
  const token = crypto.randomBytes(32).toString("base64url");
  const store = readFlowStore();
  purgeExpiredFlows(store, now);
  store[tokenHash(token)] = {
    returnTo: sanitizeCasReturnTo(returnTo),
    createdAt: now,
    expiresAt: now + CAS_FLOW_TTL_MS,
  };
  const active = Object.entries(store).sort((left, right) => Number(left[1]?.createdAt || 0) - Number(right[1]?.createdAt || 0));
  while (active.length > MAX_CAS_FLOWS) {
    const [oldestKey] = active.shift();
    delete store[oldestKey];
  }
  writeFlowStore(store);
  return {
    ok: true,
    loginUrl: casEndpoint(config.baseUrl, "login", { service: config.serviceUrl }),
    cookie: buildCasFlowCookie(token, { secure }),
  };
}

export function consumeCasLoginFlow(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const store = readFlowStore();
  const now = Date.now();
  purgeExpiredFlows(store, now);
  const key = tokenHash(raw);
  const flow = store[key];
  delete store[key];
  writeFlowStore(store);
  if (!flow || Number(flow.expiresAt) <= now) return null;
  return { ...flow, returnTo: sanitizeCasReturnTo(flow.returnTo) };
}

export async function validateCasTicket(ticket, publicBaseUrl = "") {
  const config = readCasAuthConfig(publicBaseUrl);
  const rawTicket = String(ticket || "").trim();
  if (!config.enabled || !config.serviceUrl || rawTicket.length < 3 || rawTicket.length > 2048 || !/^[\x21-\x7e]+$/.test(rawTicket)) return null;
  if (!config.baseUrl) throw new Error("AGENTFLOW_CAS_BASE_URL is invalid");
  const response = await fetch(casEndpoint(config.baseUrl, "p3/serviceValidate", {
    service: config.serviceUrl,
    ticket: rawTicket,
  }), {
    method: "GET",
    headers: { Accept: "application/xml, text/xml" },
    signal: AbortSignal.timeout(CAS_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`CAS ticket validation failed with HTTP ${response.status}`);
  const xml = await response.text();
  if (!/<(?:[A-Za-z0-9_-]+:)?authenticationSuccess(?:\s|>)/i.test(xml)) return null;
  const username = xmlTagText(xml, "user").trim().toLowerCase();
  if (!username) return null;
  const attributes = {};
  const attributesBlock = xml.match(/<(?:[A-Za-z0-9_-]+:)?attributes(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?attributes>/i)?.[1] || "";
  const attributePattern = /<(?:[A-Za-z0-9_-]+:)?([A-Za-z0-9_-]+)(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?\1>/g;
  let match;
  while ((match = attributePattern.exec(attributesBlock))) {
    const key = String(match[1] || "").trim();
    const value = xmlEntityDecode(String(match[2] || "").replace(/<[^>]+>/g, "").trim());
    if (key && value && !Object.prototype.hasOwnProperty.call(attributes, key)) attributes[key] = value;
  }
  return { username, attributes };
}

export function getCasFlowTokenFromRequest(req) {
  const cookieHeader = String(req?.headers?.cookie || "");
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.split("=");
    if (rawName?.trim() !== CAS_FLOW_COOKIE) continue;
    try { return decodeURIComponent(rawValue.join("=").trim()); } catch { return rawValue.join("=").trim(); }
  }
  return "";
}

export function buildCasFlowCookie(token, { secure = false, maxAge = Math.floor(CAS_FLOW_TTL_MS / 1000) } = {}) {
  return [
    `${CAS_FLOW_COOKIE}=${encodeURIComponent(String(token || ""))}`,
    "Path=/api/auth/cas",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    `Max-Age=${Math.max(0, Number(maxAge) || 0)}`,
  ].filter(Boolean).join("; ");
}

export function buildClearCasFlowCookie({ secure = false } = {}) {
  return buildCasFlowCookie("", { secure, maxAge: 0 });
}

export function createCasLogoutUrl(publicBaseUrl = "") {
  const config = readCasAuthConfig(publicBaseUrl);
  if (!config.baseUrl) return `${String(publicBaseUrl || "").replace(/\/+$/, "")}/projects?authError=logged_out`;
  return casEndpoint(config.baseUrl, "logout", { service: `${String(publicBaseUrl || "").replace(/\/+$/, "")}/projects?authError=logged_out` });
}
