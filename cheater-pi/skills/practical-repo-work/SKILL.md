---
name: cheater-practical-repo-work
description: Focused repo inspection, small diffs, and focused verification for Cheater sessions.
---

# Cheater Practical Repo Work

Use this skill when doing ordinary repository work in Cheater. It only adds
practical habits on top of the one mandatory flow - it never replaces it:

  cheater_reliability_start -> edit only the allowed files -> cheater_commitlet_next
  (repeat) -> cheater_verification_run -> cheater_finish_gate

1. Start with the smallest relevant search or file read.
2. Prefer Pi's native tools for search, reading, and shell execution. For editing an
   existing file, prefer `cheater_line_edit` after reading the exact target lines.
3. Keep diffs small and local to the requested behavior.
4. Do not run your own ad hoc test command as the final word: `cheater_commitlet_next`
   already runs focused verification in code, and `cheater_verification_run` is the
   harness-owned way to collect verification evidence. Call one of those instead of
   self-reporting a test you ran informally.
5. Tests, dependency files, lockfiles, and large edits are higher-risk changes; the diff
   guard blocks most of these automatically, but still avoid touching them unless the
   task explicitly requires it.
6. Do not tell the user the task is done until `cheater_finish_gate` reports ALLOWED, or
   you have explicitly said verification was skipped/blocked and why.
