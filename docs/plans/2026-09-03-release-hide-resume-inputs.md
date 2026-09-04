# Release UI: remove resume record_id inputs

Operators only trigger the stage; resume IDs are recovered automatically from Skill execution history.

Removed from capability `inputSchema`:
- `localization-download-merge-notify`: prepare_record_id / apply_record_id / resume_record_id
- `merge-release-to-master`: resume_record_id

Inspector also hides the empty「输入参数」section when a node has no operator-facing inputs.
