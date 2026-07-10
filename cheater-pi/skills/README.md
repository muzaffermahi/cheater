# Kitten Ascent — task-family skill playbooks

General procedures keyed by task family (Design Law 5: family procedures, never per-task solutions).
Canonical source is `src/core/playbooks.ts`; these `.md` files mirror it for reading/editing.
`lintPlaybooks()` asserts none of these contain a benchmark task-id or task-specific path.

| Family | Playbook |
|---|---|
| `native-extension` | Build & smoke a native/compiled extension |
| `fix-test-suite` | Fix a failing test suite |
| `git-surgery` | Git history surgery (recover / rewrite / bisect) |
| `server-healthcheck` | Stand up a server with a healthcheck |
| `data-format` | Parse / transform a data format |
| `interpreter-vm` | Implement an interpreter / VM / evaluator |
| `crypto-hash` | Crypto / hash / security task |
| `sysadmin-env` | System-admin / environment task |
| `algorithm` | Self-contained algorithm / function |
| `general` | General task |
