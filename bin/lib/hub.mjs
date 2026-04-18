/**
 * AgentFlow Hub — Supabase client, token persistence, and shared helpers.
 */
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { log } from "./log.mjs";
import { t } from "./i18n.mjs";

const HUB_URL = "https://hvgnpjuiumxtymksqgki.supabase.co";
const HUB_ANON_KEY = "sb_publishable_DIiFQno26UCIsN24Xpiotw_MxIwWCb8";

function hubConfigPath() {
  return path.join(os.homedir(), ".agentflow", "hub.json");
}

function readHubConfig() {
  try {
    return JSON.parse(fs.readFileSync(hubConfigPath(), "utf8"));
  } catch {
    return null;
  }
}

function writeHubConfig(config) {
  const dir = path.dirname(hubConfigPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(hubConfigPath(), JSON.stringify(config, null, 2));
}

/**
 * Create a Supabase-like REST client (no dependency needed).
 * Uses fetch() against PostgREST and Storage endpoints.
 */
function supabaseHeaders(accessToken) {
  const headers = {
    apikey: HUB_ANON_KEY,
    "Content-Type": "application/json",
  };
  if (accessToken) {
    headers.Authorization = "Bearer " + accessToken;
  } else {
    headers.Authorization = "Bearer " + HUB_ANON_KEY;
  }
  return headers;
}

// ──── Public REST helpers ────

export async function queryFlows({ sort = "popular", search = "", limit = 50 } = {}) {
  const order = sort === "trending" ? "created_at.desc" : "downloads.desc";
  let url = `${HUB_URL}/rest/v1/flows?select=*,profiles!flows_author_id_fkey(username)&published=eq.true&order=${order}&limit=${limit}`;
  if (search) {
    url += `&title=ilike.*${encodeURIComponent(search)}*`;
  }
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error("Hub query failed: " + res.status);
  return res.json();
}

export async function queryFlowBySlug(slug) {
  const baseSelect = `select=*,profiles!flows_author_id_fkey(username)`;
  const bySlug = `${HUB_URL}/rest/v1/flows?${baseSelect}&slug=eq.${encodeURIComponent(slug)}&limit=1`;
  const slugRes = await fetch(bySlug, { headers: supabaseHeaders() });
  if (!slugRes.ok) throw new Error("Hub query failed: " + slugRes.status);
  const slugData = await slugRes.json();
  if (slugData[0]) return slugData[0];

  // Fallback: exact title match (case-insensitive) among published flows.
  // If multiple share the same title, pick the most downloaded.
  const titleEsc = encodeURIComponent(slug.replace(/[,%*()]/g, ""));
  const byTitle = `${HUB_URL}/rest/v1/flows?${baseSelect}&published=eq.true&title=ilike.${titleEsc}&order=downloads.desc&limit=1`;
  const titleRes = await fetch(byTitle, { headers: supabaseHeaders() });
  if (!titleRes.ok) throw new Error("Hub query failed: " + titleRes.status);
  const titleData = await titleRes.json();
  return titleData[0] || null;
}

export async function downloadFlowFile(yamlKey) {
  const url = `${HUB_URL}/storage/v1/object/public/flows/${encodeURIComponent(yamlKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Download failed: " + res.status);
  return Buffer.from(await res.arrayBuffer());
}

export async function incrementDownload(slug) {
  const url = `${HUB_URL}/rest/v1/rpc/increment_download`;
  await fetch(url, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({ flow_slug: slug }),
  }).catch(() => {});
}

// ──── Auth (login) ────

export async function getStoredSession() {
  const config = readHubConfig();
  if (!config?.access_token) return null;
  // Try refresh if expired
  if (config.expires_at && Date.now() / 1000 > config.expires_at - 60) {
    const refreshed = await refreshSession(config.refresh_token);
    if (refreshed) return refreshed;
    return null;
  }
  return config;
}

async function refreshSession(refreshToken) {
  if (!refreshToken) return null;
  const url = `${HUB_URL}/auth/v1/token?grant_type=refresh_token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { apikey: HUB_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const config = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    user_id: data.user?.id,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  };
  writeHubConfig(config);
  return config;
}

/**
 * Login via OAuth: opens browser → captures token via localhost callback.
 */
export async function loginWithBrowser(provider = "github") {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectTo = `http://127.0.0.1:${port}/callback`;

      // The callback page needs to extract hash fragment and send to server
      server.on("request", (req, res) => {
        if (req.url === "/callback" || req.url?.startsWith("/callback?")) {
          // Supabase returns tokens in hash fragment (#access_token=...)
          // Serve a page that extracts hash and POSTs it
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<!DOCTYPE html><html><body>
<script>
const h = window.location.hash.substring(1);
if (h) {
  fetch('/token', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(Object.fromEntries(new URLSearchParams(h))) })
    .then(() => { document.body.innerHTML = '<h2>Login successful! You can close this tab.</h2>'; });
} else {
  document.body.innerHTML = '<h2>Login failed. No token received.</h2>';
}
</script>
<p>Processing login...</p></body></html>`);
          return;
        }

        if (req.url === "/token" && req.method === "POST") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            res.writeHead(200);
            res.end("ok");
            server.close();
            try {
              const data = JSON.parse(body);
              if (!data.access_token) {
                reject(new Error("No access_token in response"));
                return;
              }
              const config = {
                access_token: data.access_token,
                refresh_token: data.refresh_token || null,
                user_id: null,
                expires_at: data.expires_in
                  ? Math.floor(Date.now() / 1000) + parseInt(data.expires_in, 10)
                  : null,
              };
              writeHubConfig(config);
              resolve(config);
            } catch (e) {
              reject(e);
            }
          });
          return;
        }

        res.writeHead(404);
        res.end("Not found");
      });

      // Open browser to Supabase OAuth
      const authUrl =
        `${HUB_URL}/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(redirectTo)}`;

      log.info("Opening browser for " + provider + " login...");
      openBrowser(authUrl);

      // Timeout after 120 seconds
      setTimeout(() => {
        server.close();
        reject(new Error("Login timed out (120s). Try again."));
      }, 120_000);
    });
  });
}

function openBrowser(url) {
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

// ──── Upload (publish) ────

export async function uploadToStorage(accessToken, fileKey, buffer, contentType) {
  const url = `${HUB_URL}/storage/v1/object/flows/${fileKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: HUB_ANON_KEY,
      Authorization: "Bearer " + accessToken,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Storage upload failed: " + res.status + " " + text);
  }
  return res.json();
}

export async function insertFlow(accessToken, flowData) {
  const url = `${HUB_URL}/rest/v1/flows`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...supabaseHeaders(accessToken), Prefer: "return=representation" },
    body: JSON.stringify(flowData),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Insert failed: " + res.status + " " + text);
  }
  return res.json();
}

export async function getUserProfile(accessToken) {
  const url = `${HUB_URL}/auth/v1/user`;
  const res = await fetch(url, {
    headers: { apikey: HUB_ANON_KEY, Authorization: "Bearer " + accessToken },
  });
  if (!res.ok) return null;
  return res.json();
}

export { HUB_URL };
