# Force localization re-download Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let operators force a fresh Crowdin pull + apply + MR on the localization download card.

**Architecture:** Capability input `force_rerun` flows into the lean playbook intent; Agent/Skill perform `--rerun`. UI renders a checkbox.

**Tech Stack:** shared/release-workflow-config.js, release-runtime-executor.mjs, ReleaseWorkflowPanel / ReleaseNodeInspector, node tests

---

### Task 1: Failing tests for force intent + config input

**Files:**
- Modify: `test/release-runtime-executor.test.mjs`
- Modify: `test/release-workflow-config.test.mjs`

**Step 1:** Assert download playbook with `force_rerun=true` mentions `--rerun` / 禁止复用已 merged MR; default playbook does not.
**Step 2:** Assert capability inputs include `force_rerun`.
**Step 3:** Run tests — expect fail.

### Task 2: Config + playbook

**Files:**
- Modify: `shared/release-workflow-config.js`
- Modify: `bin/lib/release-runtime-executor.mjs`

**Step 1:** Add checkbox input to `localization-download-merge-notify`.
**Step 2:** Branch playbook when force flag truthy.
**Step 3:** Pass tests.

### Task 3: Checkbox rendering

**Files:**
- Modify: `builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx`
- Modify: `builtin/web-ui/src/components/ReleaseNodeInspector.jsx`
- Modify: contract tests if needed
- Rebuild: `builtin/web-ui` dist

**Step 1:** Render `type: "checkbox"` / `bool` as checkbox bound to true/false strings or booleans consistently with execution inputs.
**Step 2:** Build + restart UI.
