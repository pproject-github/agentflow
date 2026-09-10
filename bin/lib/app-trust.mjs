/**
 * 应用间互信：Ed25519 签名，双方只交换公钥。
 *
 * 为什么不是"互发私钥"：私钥一旦发给对方就不再是私钥——泄露时分不清是谁漏的，也没法
 * 证明某个请求确实出自对方。各自持有自己的私钥、只把公钥给对方，任何一边被拖库，
 * 攻击者都伪造不了另一边的签名。
 *
 * 每个请求签的是**规范化串**，不是只签 body：
 *
 *   agentflow-app-v1 \n <METHOD> \n <path> \n <sha256(body) 十六进制> \n <timestamp> \n <nonce>
 *
 * 方法和路径进签名，防止把一个合法请求原样重放到别的接口；body 摘要进签名，防止篡改；
 * 时间戳 + nonce 防重放。签名本身泄露只损失一次请求，而裸密钥泄露等于永久失守——
 * 这就是不用 Bearer 明文密钥的原因。
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import { getAgentflowDataRoot } from "./paths.mjs";

const TRUST_FILENAME = "app-trust.json";
const SIGNATURE_PREFIX = "agentflow-app-v1";
/** 允许的时钟偏移。两端同机，5 分钟已经很宽松 */
export const APP_TRUST_MAX_SKEW_MS = 5 * 60 * 1000;
/** nonce 记忆窗口必须大于时钟偏移窗口，否则过期的 nonce 会被重新接受 */
const NONCE_TTL_MS = APP_TRUST_MAX_SKEW_MS * 2;
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;

/** 进程内 nonce 记忆。多进程部署要换成共享存储，否则重放只在单进程内被拦住 */
const seenNonces = new Map();

function trustPath() {
  return path.join(getAgentflowDataRoot(), "admin", TRUST_FILENAME);
}

function readTrustFile() {
  const filePath = trustPath();
  try {
    if (!fs.existsSync(filePath)) return { version: 1, self: null, peers: {} };
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return {
      version: 1,
      self: parsed?.self && typeof parsed.self === "object" ? parsed.self : null,
      peers: parsed?.peers && typeof parsed.peers === "object" && !Array.isArray(parsed.peers) ? parsed.peers : {},
    };
  } catch {
    return { version: 1, self: null, peers: {} };
  }
}

function writeTrustFile(next) {
  const filePath = trustPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, filePath);
}

/** 本机身份：没有就地生成一对，私钥只落在 0600 的文件里，不进环境变量、不进接口响应 */
export function ensureSelfKeyPair() {
  const file = readTrustFile();
  if (file.self?.privateKey && file.self?.publicKey) return file.self;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const self = { publicKey, privateKey, createdAt: new Date().toISOString() };
  writeTrustFile({ ...file, self });
  return self;
}

/** 给对方的东西只有这个 */
export function selfPublicKey() {
  return ensureSelfKeyPair().publicKey;
}

export function listAppTrustPeers() {
  const file = readTrustFile();
  return Object.entries(file.peers).map(([appId, peer]) => ({
    appId,
    name: String(peer?.name || appId),
    scopes: Array.isArray(peer?.scopes) ? peer.scopes.map(String) : [],
    requirePrivilegeBinding: peer?.requirePrivilegeBinding !== false,
    sessionTtlMs: Number(peer?.sessionTtlMs) || DEFAULT_SESSION_TTL_MS,
    publicKeyFingerprint: fingerprint(peer?.publicKey || ""),
    createdAt: String(peer?.createdAt || ""),
    updatedAt: String(peer?.updatedAt || ""),
  }));
}

function fingerprint(publicKeyPem) {
  const text = String(publicKeyPem || "").trim();
  if (!text) return "";
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * 登记对方的公钥。
 * @param {{ appId: string, name?: string, publicKey: string, scopes?: string[],
 *           requirePrivilegeBinding?: boolean, sessionTtlMs?: number }} input
 */
export function upsertAppTrustPeer(input = {}) {
  const appId = String(input.appId || "").trim();
  const publicKey = String(input.publicKey || "").trim();
  if (!appId || !/^[a-zA-Z0-9._-]{1,64}$/.test(appId)) return { ok: false, error: "appId 不合法" };
  if (!publicKey.includes("BEGIN PUBLIC KEY")) return { ok: false, error: "publicKey 必须是 SPKI PEM 公钥" };
  try {
    crypto.createPublicKey(publicKey);
  } catch (error) {
    return { ok: false, error: `公钥解析失败：${(error && error.message) || String(error)}` };
  }
  const file = readTrustFile();
  const previous = file.peers[appId] || {};
  const now = new Date().toISOString();
  file.peers[appId] = {
    ...previous,
    name: String(input.name || previous.name || appId),
    publicKey,
    scopes: Array.isArray(input.scopes) ? input.scopes.map(String).filter(Boolean) : (previous.scopes || []),
    requirePrivilegeBinding: input.requirePrivilegeBinding === undefined
      ? previous.requirePrivilegeBinding !== false
      : input.requirePrivilegeBinding !== false,
    sessionTtlMs: Number(input.sessionTtlMs) || Number(previous.sessionTtlMs) || DEFAULT_SESSION_TTL_MS,
    createdAt: String(previous.createdAt || now),
    updatedAt: now,
  };
  writeTrustFile(file);
  return { ok: true, peer: listAppTrustPeers().find((peer) => peer.appId === appId) };
}

export function removeAppTrustPeer(appId) {
  const id = String(appId || "").trim();
  const file = readTrustFile();
  if (!file.peers[id]) return { ok: false, error: "应用不存在" };
  delete file.peers[id];
  writeTrustFile(file);
  return { ok: true, appId: id };
}

export function appTrustCanonicalString({ method, requestPath, body = "", timestamp, nonce }) {
  const digest = crypto.createHash("sha256").update(String(body ?? ""), "utf-8").digest("hex");
  return [
    SIGNATURE_PREFIX,
    String(method || "").toUpperCase(),
    String(requestPath || ""),
    digest,
    String(timestamp || ""),
    String(nonce || ""),
  ].join("\n");
}

/** 我们主动调对方时用：用自己的私钥签，附在请求头上 */
export function signAppRequest({ method, requestPath, body = "", appId }) {
  const self = ensureSelfKeyPair();
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString("hex");
  const canonical = appTrustCanonicalString({ method, requestPath, body, timestamp, nonce });
  const signature = crypto.sign(null, Buffer.from(canonical, "utf-8"), crypto.createPrivateKey(self.privateKey));
  return {
    "x-agentflow-app": String(appId || ""),
    "x-agentflow-timestamp": timestamp,
    "x-agentflow-nonce": nonce,
    "x-agentflow-signature": signature.toString("base64"),
  };
}

function rememberNonce(appId, nonce, now) {
  for (const [key, seenAt] of seenNonces) {
    if (now - seenAt > NONCE_TTL_MS) seenNonces.delete(key);
  }
  const key = `${appId}:${nonce}`;
  if (seenNonces.has(key)) return false;
  seenNonces.set(key, now);
  return true;
}

/**
 * 校验对方的签名请求。
 *
 * 失败一律只回一句「应用签名校验失败」——不要把"应用不存在 / 时钟偏了 / 签名不对"
 * 的区别告诉调用方，那是免费的探测信道。具体原因留在返回值里给日志用。
 */
export function verifyAppRequest({ method, requestPath, body = "", headers = {}, now = Date.now() }) {
  const header = (name) => String(headers[name] || headers[name.toLowerCase()] || "").trim();
  const appId = header("x-agentflow-app");
  const timestamp = header("x-agentflow-timestamp");
  const nonce = header("x-agentflow-nonce");
  const signature = header("x-agentflow-signature");
  if (!appId || !timestamp || !nonce || !signature) return { ok: false, reason: "missing_headers" };
  if (!/^[a-f0-9]{16,64}$/i.test(nonce)) return { ok: false, reason: "bad_nonce" };

  const peer = readTrustFile().peers[appId];
  if (!peer?.publicKey) return { ok: false, reason: "unknown_app" };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > APP_TRUST_MAX_SKEW_MS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const canonical = appTrustCanonicalString({ method, requestPath, body, timestamp, nonce });
  let verified = false;
  try {
    verified = crypto.verify(
      null,
      Buffer.from(canonical, "utf-8"),
      crypto.createPublicKey(peer.publicKey),
      Buffer.from(signature, "base64"),
    );
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: "bad_signature" };

  // nonce 放在验签之后记：否则未通过验签的请求也能污染 nonce 表，变成一条拒绝服务路径
  if (!rememberNonce(appId, nonce, now)) return { ok: false, reason: "replayed_nonce" };

  return {
    ok: true,
    appId,
    peer: {
      appId,
      name: String(peer.name || appId),
      scopes: Array.isArray(peer.scopes) ? peer.scopes.map(String) : [],
      requirePrivilegeBinding: peer.requirePrivilegeBinding !== false,
      sessionTtlMs: Number(peer.sessionTtlMs) || DEFAULT_SESSION_TTL_MS,
    },
  };
}
