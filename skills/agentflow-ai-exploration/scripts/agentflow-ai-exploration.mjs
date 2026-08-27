#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  authFile,
  clearPending,
  clearProfile,
  savePending,
  saveProfile,
  savedPending,
  savedProfile,
} from "./auth-store.mjs";

const DEFAULT_BASE_URL = "http://ai.mengma.bigo.inner/";

function usage() {
  return `AgentFlow AI Exploration CLI

Usage:
  agentflow-ai-exploration <command> [options]

Commands:
  config
  auth start | complete | status | logout
  list [--flow-id <id>] [--flow-source user]
  get --id <session-id> [--flow-id <id>]
  create [--title <text>] [--goal <text>] [--mode observed|planned]
  plan --goal <text> [--model <key>]
  append --id <session-id> (--file <events.json> | --event <json> | --stdin) [--phase observed|planned]
  finish --id <session-id> [--status completed|failed] [--summary <text>]
  dry-run --id <session-id>
  materialize --id <session-id> [--model <key>] [--approve-side-effects]

Shared options:
  --flow-id <id>          Target a stored Flow Workspace instead of the current Workspace
  --flow-source <source>  user|workspace (default: user)
  --admin-owner-id <id>   Admin review scope
  --archived              Target an archived Flow
  --base-url <url>        Override AGENTFLOW_BASE_URL
  --token <token>         Override saved browser authorization
`;
}

function parseArgv(argv) {
  const output = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      output._.push(item);
      continue;
    }
    const equal = item.indexOf("=");
    let name = item.slice(2);
    let value = true;
    if (equal >= 0) {
      name = item.slice(2, equal);
      value = item.slice(equal + 1);
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      value = argv[index + 1];
      index += 1;
    }
    output[name] = value;
  }
  return output;
}

function option(args, name, fallback = "") {
  const value = args[name];
  return value === undefined || value === null || value === true ? fallback : String(value);
}

function loadDotenvFile(file) {
  if (!file || !fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value.replace(/\\n/g, "\n");
  }
}

function loadEnvironment() {
  for (const candidate of [
    process.env.AGENTFLOW_ENV_FILE,
    path.join(process.cwd(), ".env"),
    path.join(process.cwd(), ".agentflow.env"),
    path.join(os.homedir(), ".agentflow.env"),
  ].filter(Boolean)) loadDotenvFile(path.resolve(candidate));
}

function baseUrl(args) {
  return String(option(args, "base-url") || process.env.AGENTFLOW_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function resolvedAuth(args) {
  const direct = option(args, "token");
  if (direct) return { token: direct, source: "flag", profile: null };
  if (String(process.env.AGENTFLOW_TOKEN || "").trim()) return { token: String(process.env.AGENTFLOW_TOKEN).trim(), source: "AGENTFLOW_TOKEN", profile: null };
  if (String(process.env.AGENTFLOW_SESSION_TOKEN || "").trim()) return { token: String(process.env.AGENTFLOW_SESSION_TOKEN).trim(), source: "AGENTFLOW_SESSION_TOKEN", profile: null };
  const profile = savedProfile(baseUrl(args));
  return profile?.token ? { token: profile.token, source: "saved-auth", profile } : { token: "", source: "", profile: null };
}

function token(args, required = true) {
  const value = String(resolvedAuth(args).token || "").trim();
  if (required && !value) throw new Error("AgentFlow authorization is missing. Run `auth start`, approve the returned URL, then run `auth complete`.");
  return value;
}

async function httpJson(args, pathname, { method = "GET", body, tokenRequired = true } = {}) {
  const authToken = token(args, tokenRequired);
  const url = new URL(pathname, `${baseUrl(args)}/`);
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
    headers.Cookie = `af_session=${encodeURIComponent(authToken)}`;
  }
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { text }; }
  if (!response.ok) {
    const error = new Error(data?.error || data?.message || text || `HTTP ${response.status}`);
    error.status = response.status;
    error.response = data;
    throw error;
  }
  return data;
}

function scope(args) {
  return {
    flowId: option(args, "flow-id"),
    flowSource: option(args, "flow-source", "user") || "user",
    ...(option(args, "admin-owner-id") ? { adminOwnerId: option(args, "admin-owner-id") } : {}),
    ...(args.archived === true ? { archived: true } : {}),
  };
}

function query(input) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(input)) {
    if (value === "" || value === undefined || value === null || value === false) continue;
    params.set(name, value === true ? "1" : String(value));
  }
  const output = params.toString();
  return output ? `?${output}` : "";
}

function required(args, name) {
  const value = option(args, name);
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

function readJsonInput(args) {
  let source = "";
  if (option(args, "file")) source = fs.readFileSync(path.resolve(option(args, "file")), "utf8");
  else if (option(args, "event")) source = option(args, "event");
  else if (args.stdin === true) source = fs.readFileSync(0, "utf8");
  else throw new Error("append requires --file <events.json>, --event <json>, or --stdin.");
  let parsed;
  try { parsed = JSON.parse(source); } catch (error) { throw new Error(`Invalid Trace JSON: ${error.message}`); }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.events)) return parsed.events;
  if (parsed && typeof parsed === "object") return [parsed];
  throw new Error("Trace JSON must be an event object, an event array, or an object with events[].");
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runAuth(action, args) {
  const target = baseUrl(args);
  if (action === "start" || action === "login") {
    const result = await httpJson(args, "/api/auth/cli/device", {
      method: "POST",
      tokenRequired: false,
      body: { clientName: "AgentFlow AI Exploration" },
    });
    const pending = savePending(target, result);
    print({ status: "authorization_required", baseUrl: target, requestId: pending.requestId, userCode: pending.userCode, verificationUrl: pending.verificationUrl, expiresAt: pending.expiresAt });
    return;
  }
  if (action === "complete") {
    const pending = savedPending(target);
    if (!pending?.deviceCode) throw new Error("No pending authorization. Run `auth start` first.");
    let result;
    try {
      result = await httpJson(args, "/api/auth/cli/token", { method: "POST", tokenRequired: false, body: { deviceCode: pending.deviceCode } });
    } catch (error) {
      if (["access_denied", "expired_token", "invalid_grant"].includes(String(error?.response?.code || ""))) clearPending(target);
      throw error;
    }
    if (result?.code === "authorization_pending") {
      print({ status: "authorization_pending", baseUrl: target, verificationUrl: pending.verificationUrl, expiresAt: pending.expiresAt });
      process.exitCode = 2;
      return;
    }
    if (!result?.token) throw new Error("Authorization exchange did not return a token.");
    const saved = saveProfile(target, result);
    print({ status: "authenticated", baseUrl: target, user: result.user || null, scopes: result.scopes || [], expiresAt: result.expiresAt || 0, credentialFile: saved.file });
    return;
  }
  if (action === "status") {
    const auth = resolvedAuth(args);
    if (!auth.token) {
      print({ authenticated: false, baseUrl: target, credentialFile: authFile() });
      return;
    }
    const me = await httpJson(args, "/api/auth/me", { tokenRequired: false });
    print({ authenticated: Boolean(me?.authenticated), baseUrl: target, tokenSource: auth.source, user: me?.user || null, credentialFile: auth.source === "saved-auth" ? authFile() : "" });
    return;
  }
  if (action === "logout") {
    const auth = resolvedAuth(args);
    let revoked = false;
    if (auth.token) {
      try { revoked = Boolean((await httpJson(args, "/api/auth/cli/revoke", { method: "POST", body: {} }))?.ok); } catch {}
    }
    print({ authenticated: false, baseUrl: target, revoked, localCleared: clearProfile(target), tokenSource: auth.source });
    return;
  }
  throw new Error("Unknown auth action. Use start, complete, status, or logout.");
}

async function main() {
  loadEnvironment();
  const args = parseArgv(process.argv.slice(2));
  const command = String(args._[0] || "help").toLowerCase();
  if (["help", "--help", "-h"].includes(command)) {
    process.stdout.write(usage());
    return;
  }
  if (command === "auth") {
    await runAuth(String(args._[1] || "status").toLowerCase(), args);
    return;
  }
  if (command === "config") {
    const auth = resolvedAuth(args);
    print({ baseUrl: baseUrl(args), hasToken: Boolean(auth.token), tokenSource: auth.source, credentialFile: auth.source === "saved-auth" ? authFile() : "" });
    return;
  }
  if (command === "list") {
    print(await httpJson(args, `/api/workspace/explorations${query(scope(args))}`));
    return;
  }
  if (command === "get") {
    print(await httpJson(args, `/api/workspace/exploration${query({ ...scope(args), id: required(args, "id") })}`));
    return;
  }
  if (command === "create") {
    print(await httpJson(args, "/api/workspace/exploration", {
      method: "POST",
      body: {
        ...scope(args),
        title: option(args, "title") || option(args, "goal") || "External Agent run",
        goal: option(args, "goal"),
        mode: option(args, "mode", "observed") || "observed",
        status: option(args, "status", "running") || "running",
        source: { provider: option(args, "provider", "external") || "external", agent: option(args, "agent", "Codex / Agent SDK") || "Codex / Agent SDK" },
      },
    }));
    return;
  }
  if (command === "plan") {
    print(await httpJson(args, "/api/workspace/exploration/plan", {
      method: "POST",
      body: { ...scope(args), goal: required(args, "goal"), model: option(args, "model") },
    }));
    return;
  }
  if (command === "append") {
    print(await httpJson(args, "/api/workspace/exploration/events", {
      method: "POST",
      body: { ...scope(args), id: required(args, "id"), phase: option(args, "phase", "observed") || "observed", events: readJsonInput(args) },
    }));
    return;
  }
  if (command === "finish") {
    print(await httpJson(args, "/api/workspace/exploration/events", {
      method: "POST",
      body: { ...scope(args), id: required(args, "id"), events: [], status: option(args, "status", "completed") || "completed", summary: option(args, "summary") },
    }));
    return;
  }
  if (command === "dry-run") {
    print(await httpJson(args, "/api/workspace/exploration/dry-run", { method: "POST", body: { ...scope(args), id: required(args, "id") } }));
    return;
  }
  if (command === "materialize") {
    print(await httpJson(args, "/api/workspace/exploration/materialize", {
      method: "POST",
      body: { ...scope(args), id: required(args, "id"), model: option(args, "model"), approveSideEffects: args["approve-side-effects"] === true },
    }));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error?.message || String(error), status: error?.status || 0, response: error?.response || null }, null, 2)}\n`);
  process.exitCode = 1;
});
