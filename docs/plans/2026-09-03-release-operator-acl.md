# Release Operator ACL Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enforce release write ACL per business line × platform while keeping all release reads open; derive context from the operator roster when omitted; support version switching in UI and deep links.

**Architecture:** Extend release deployment config with an `operators` map. Shared helpers resolve membership and authorize writes. All mutating `/api/release/*` routes call the helper. UI loads `canWrite` + membership from the server and hides write controls; version/batch switcher updates the URL without retyping businessLine/platform.

**Tech Stack:** Node.js ESM (`shared/release-deployment-config.js`, `bin/lib/workspace-routes.mjs`), React release page/panel, Node test runner.

**Spec:** `docs/plans/2026-09-03-release-operator-acl-design.md`

---

### Task 1: Operators config parse + validation

**Files:**
- Modify: `shared/release-deployment-config.js`
- Create/Modify: `test/release-deployment-config.test.mjs`

**Step 1: Write failing tests**

Assert:
- Parses `operators.likee.android/ios` usernames (case-insensitive normalize).
- `resolveReleaseOperatorMembership(username, config)` returns `{ businessLine, platform }` or `null`.
- Duplicate username across two platforms → validation error.
- Empty reserved business lines are allowed.
- `canWriteRelease(username, { businessLine, platform }, config)` true/false.

**Step 2: Run tests — expect fail**

```bash
node --test test/release-deployment-config.test.mjs --test-name-pattern='operator'
```

**Step 3: Implement parse/validate/resolve helpers**

- Read `operators` from the same JSON as projects (`AGENTFLOW_RELEASE_PROJECTS_JSON` / `_FILE`).
- Normalize keys and usernames to lowercase.
- Export `getReleaseOperators`, `validateReleaseOperators`, `resolveReleaseOperatorMembership`, `assertReleaseWriteAccess` (or `canWriteRelease`).
- Default Likee roster in **dev+test mode only** if operators omitted (mirror projects local default); production requires explicit config (empty operators ⇒ nobody can write).

**Step 4: Run tests — expect pass**

**Step 5: Commit** (only if user asked)

---

### Task 2: Server write gate on release APIs

**Files:**
- Modify: `bin/lib/workspace-routes.mjs` (release handlers)
- Modify: `test/release-runtime-api.test.mjs` (or new `test/release-operator-acl.test.mjs`)

**Step 1: Write failing API tests**

- Authenticated non-operator: GET state/catalog → 200; POST run/preview → 403 `RELEASE_OPERATOR_FORBIDDEN`.
- Operator for likee/android: run allowed for android; 403 for ios.
- Missing businessLine/platform on write: fill from membership then authorize; no membership → 403.
- stop / pending PATCH / DELETE also gated.

**Step 2: Run — expect fail**

**Step 3: Implement shared gate in routes**

Before mutating handlers:
1. Resolve context (payload/query → membership fallback).
2. `canWriteRelease(authUser.username, context)`.
3. On failure: `json(res, 403, { error, code: "RELEASE_OPERATOR_FORBIDDEN" })`.

Do **not** gate catalog/state GET.

**Step 4: Run — expect pass**

**Step 5: Commit** (if asked)

---

### Task 3: Bootstrap payload for UI (`canWrite` + membership)

**Files:**
- Modify: `bin/lib/workspace-routes.mjs` (workspaces or release state/catalog response)
- Modify: matching API test

**Step 1: Failing test** — release state or `/api/workspaces` (or dedicated `/api/release/access`) includes:

```json
{
  "releaseAccess": {
    "username": "duanfengyuan",
    "membership": { "businessLine": "likee", "platform": "android" },
    "canWrite": true
  }
}
```

Non-member: `membership: null`, `canWrite: false` (for a given context) or compute `canWrite` against resolved context.

**Step 2: Implement minimal field on existing release state GET** (avoid new round-trip if possible):

`state.releaseAccess` or top-level `releaseAccess` beside `state`.

**Step 3: Tests pass**

---

### Task 4: Context derivation + version switcher on Release page

**Files:**
- Modify: `builtin/web-ui/src/pages/ReleasePage.jsx`
- Modify: `builtin/web-ui/src/lib/releaseWorkflowModel.js` (resolve helpers if needed)
- Modify: `builtin/web-ui/src/index.css` (minimal switcher styles)
- Modify: `test/release-page-contract.test.mjs`

**Step 1: Failing contract tests**

- Page derives businessLine/platform from `releaseAccess.membership` when URL omits them.
- Version/batch inputs or controls update `window` search params without clearing membership-derived fields.
- Banner when `!canWrite`.

**Step 2: Implement**

- On load: merge URL + membership → `navigationContext`.
- Header control: version text/select + optional batch; changing it navigates to same path with updated query.
- Show read-only chips for businessLine/platform.

**Step 3: Tests pass**

---

### Task 5: Panel write gating + assistant/free-prompt path

**Files:**
- Modify: `builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx`
- Modify: `builtin/web-ui/src/components/ReleaseNodeInspector.jsx`
- Modify: `test/release-workflow-panel-contract.test.mjs`
- Modify: assistant/release run entry if separate (search `free-prompt` / release run from composer)

**Step 1: Failing contracts**

- When `canWrite === false`: no 执行/预览/删除/添加/保存; inspector run/preview disabled.
- Execute path still sends context; 403 surfaces as message.
- Any assistant entry that POSTs `/api/release/nodes/run` documents shared gate (contract or unit).

**Step 2: Implement UI gates**; ensure free-prompt uses same executeNode/API (no bypass).

**Step 3: Tests pass**

---

### Task 6: Docs + deployment sample

**Files:**
- Modify: `docs/release-online-deployment.md`
- Optionally seed operators in local/dev sample JSON if one exists

**Step 1:** Document `operators` field, 403 code, read-open/write-locked behavior.

**Step 2:** Add Likee android/ios usernames from the design as the production example.

---

### Task 7: Verification

**Step 1:** Run focused suite:

```bash
node --test \
  test/release-deployment-config.test.mjs \
  test/release-operator-acl.test.mjs \
  test/release-runtime-api.test.mjs \
  test/release-page-contract.test.mjs \
  test/release-workflow-panel-contract.test.mjs
```

**Step 2:** Manual smoke (dev): login as allowed user → run node; login as other → browse OK, run 403 / buttons hidden.

---

## Out of scope

- Multi-platform membership
- Per-stage ACL
- Hiding timelines from readers
