# Force localization re-download (design)

## Problem
Re-running「多语言下载」idempotently skips prepare/apply and reuses an already-merged MR. Operators who need the latest Crowdin strings have no UI way to force a fresh download.

## Decision
Add an optional card input `force_rerun` (checkbox, default off) on `localization-download-merge-notify`.

When `force_rerun` is true, the capability intent must require:
1. `prepare-translation-archive --rerun` (confirm flow as Skill requires)
2. Fresh `apply-translations` from the new prepare record
3. Commit / topic MR if there are managed changes; an already-merged historical MR does **not** count as success for this run
4. Send `localization-applied` only after a new merge (or explicit skip reason if no file delta)

Default off keeps current idempotent behavior.

## Non-goals
- No operator-facing `record_id` resume fields
- No automatic force on every retry
- Do not force re-send notification when nothing new merged
