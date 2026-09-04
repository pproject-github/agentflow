# Release Online Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove local-machine assumptions from release execution and make production Skill/project resolution explicit, allowlisted, and deployable.

**Architecture:** The server owns release deployment configuration. A release context resolves to one approved product workspace and one or more approved Skill roots; the browser may select an ID but cannot override filesystem paths. Agent execution receives the resolved roots, while runtime state remains separate from the product repository.

**Tech Stack:** Node.js ESM HTTP routes, React/Vite web UI, Node test runner, JSON/environment deployment configuration.

**Spec:** `docs/superpowers/specs/2026-08-31-release-workflow-state-machine-design.md`

## Global Constraints

- Never fall back to `/Users/duanfengyuan/...` in production code.
- Client-provided absolute paths are rejected unless they resolve to a server-approved workspace.
- `repositoryRoot`, `skillRoots`, `recordsRoot`, and `outputsRoot` remain distinct concepts.
- Existing local development behavior is preserved only through explicit test/development configuration.

---

### Task 1: Add server-owned release deployment configuration

**Files:**
- Create: `shared/release-deployment-config.js`
- Test: `test/release-deployment-config.test.mjs`

- [x] **Step 1: Write failing tests** for parsing `AGENTFLOW_RELEASE_PROJECTS_JSON`, rejecting malformed entries, resolving a Likee Android workspace, and returning configured Skill roots without exposing secrets.
- [x] **Step 2: Run the focused test and verify it fails.**
- [x] **Step 3: Implement pure config helpers** `readReleaseDeploymentConfig(env)`, `resolveReleaseWorkspace(config, context, requestedId)`, and `releaseSkillRoots(config, workspaceRoot)`.
- [x] **Step 4: Run the focused test and verify it passes.**

### Task 2: Enforce release workspace and Skill-root resolution in HTTP routes

**Files:**
- Modify: `bin/lib/workspace-routes.mjs`
- Test: `test/release-runtime-api.test.mjs`

- [x] **Step 1: Add failing API tests** for no configured workspace (safe 503), valid `workspaceId`, rejected path traversal/arbitrary `workspacePath` (403), and configured Skill root separate from repository root.
- [x] **Step 2: Run the focused tests and verify they fail.**
- [x] **Step 3: Resolve workspace and Skill roots through the server-owned config; reject client path overrides and remove the hardcoded development fallback.
- [x] **Step 4: Run the focused tests and verify they pass.**

### Task 3: Remove browser development fallback

**Files:**
- Modify: `builtin/web-ui/src/pages/ReleasePage.jsx`
- Test: `test/release-page-contract.test.mjs`

- [x] **Step 1: Add a failing contract test** asserting no `/Users/` fallback exists and an API error is rendered when no release workspace is configured.
- [x] **Step 2: Run the test and verify it fails.**
- [x] **Step 3: Remove the hardcoded object and make the page use the server-provided release workspace or an explicit configuration error.
- [x] **Step 4: Build the web UI and run the contract test.**

### Task 4: Document production Skill lifecycle and runtime boundaries

**Files:**
- Create: `docs/release-online-deployment.md`
- Modify: `.env.example` (if present)

- [x] **Step 1: Document pinned `release-skills` release directories, staging verification, secret injection, worker isolation, and rollback.
- [x] **Step 2: Document that users do not trigger `git pull`; deployment updates Skill roots atomically.
- [x] **Step 3: Document multi-instance requirements and current in-process run-map limitation.

### Task 5: Verify all release paths and report remaining architecture gaps

- [x] **Step 1: Run release unit/API tests, path-safety tests, syntax checks, and `npm run build:web-ui`.
- [x] **Step 2: Inspect OpenCode directory authorization and record whether production pins another backend or requires a follow-up patch.
- [x] **Step 3: Report exact deployment prerequisites and known follow-up items (shared run state, server-authoritative state, notification idempotency).
