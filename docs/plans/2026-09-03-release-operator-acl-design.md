# Release Operator ACL Design

**Date:** 2026-09-03  
**Status:** Approved  
**Approach:** Independent operators config + server-enforced write gate (Approach A)

## Goal

Control who can **operate** (write) release workflows per business line × platform, while keeping **read** open to every authenticated AgentFlow user. Chat assistants that invoke free-prompt / release run APIs must pass the same write gate.

## Decisions

| Topic | Decision |
|--------|----------|
| Membership | One user → at most one `businessLine + platform`. Duplicate membership fails config validation. |
| Read | Open. Catalog, state, timeline, inspector, version browsing — no operators check. |
| Write | Locked on every path. Run / preview / stop / pending mutate / free-prompt / assistant-triggered release runs require operators membership for the request’s businessLine×platform. |
| Context | Business line and platform need not be typed by the user; derived from operators when omitted. Version (+ batch) selectable via header switcher and deep link. |
| No membership | User can still browse (read). Write UI disabled; write APIs return 403. |
| Conflicting deep link | If URL forces a businessLine/platform the user is not allowed to write, read still works; write returns 403. |

## Initial operators

```json
{
  "operators": {
    "likee": {
      "android": ["duanfengyuan", "suruijia", "wangfang"],
      "ios": ["liangjiajian", "yangcaimu"]
    },
    "bigolive": { "android": [], "ios": [] },
    "hello": { "android": [], "ios": [] }
  }
}
```

- Usernames are AgentFlow login names (OA pinyin), compared case-insensitively.
- Empty arrays reserve future business lines/platforms without granting write.
- Config lives alongside release deployment config (same JSON file field and/or dedicated env), not inside Skill repos.

## Permission model

```
authenticated user
    │
    ├─ READ  (catalog, state, GET-like) ──► always allow
    │
    └─ WRITE (run, preview, stop, PATCH/DELETE pending,
              assistant → free-prompt-agent / release run)
           │
           ├─ resolve businessLine + platform
           │     (request → else operators membership)
           ├─ user ∈ operators[businessLine][platform] ?
           │     yes → allow
           │     no  → 403 RELEASE_OPERATOR_FORBIDDEN
           └─ never trust UI-only disables
```

## Context resolution

1. If request/URL includes `businessLine` + `platform`, use them (normalized).
2. Else if user has exactly one operators membership, fill from membership.
3. Else leave unset for read; for write, 403 with reason that context/permission is missing.
4. `version` / `batch` always come from URL or header switcher (not from operators).

## UI

- Release page shows timeline for the resolved (or selected) context; read always works.
- Write controls (执行 / 预览 / 取消 / 删除 / 添加阶段 / 保存参数 / 自由 Agent 执行) visible/enabled only when `canWrite`.
- Header: version (+ batch) switcher; businessLine/platform shown as read-only chips when derived.
- Deep links remain supported: `?version=&batch=` (+ optional businessLine/platform).
- Read-only users see a clear banner: 可浏览，无发版操作权限.

## Server surfaces

- Gate all mutating `/api/release/*` handlers that change run state or start agents.
- Expose a small read endpoint or embed in existing session/bootstrap payload:  
  `{ membership, canWrite, businessLine, platform }` so the UI does not hardcode the roster.
- Assistant / free-prompt paths that call the same run APIs inherit the gate automatically; if a separate assistant entry exists, it must call the shared authorization helper (no bypass).

## Non-goals

- Fine-grained per-stage ACLs (e.g. only localization).
- Multi-platform membership for one user (explicitly rejected).
- Hiding other teams’ timelines from readers.

## Testing

- Config validation: duplicate user across platforms fails.
- Write without membership → 403; read without membership → 200.
- Membership user can write only for their businessLine×platform.
- Assistant/free-prompt run uses the same helper.
- UI contract: write actions gated on `canWrite`.
