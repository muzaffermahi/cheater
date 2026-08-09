# 30-task Kitten/OpenCode comparison

Validate the committed corpus first:

```powershell
npm run benchmark:compare -- --validate
```

The runner materializes a fresh fixture workspace for every agent/task and runs `verify.mjs` as the
oracle. The runner expects each adapter command to read `KITTEN_BENCH_TASK_ID`,
`KITTEN_BENCH_PROMPT`, and `KITTEN_BENCH_CWD` from its environment. Example wrappers:

```powershell
npm run benchmark:compare -- `
  --root C:\bench\workspace `
  --kitten-command 'kitten run "$env:KITTEN_BENCH_PROMPT" --cwd "$env:KITTEN_BENCH_CWD" --json' `
  --opencode-command 'opencode run --pure --prompt "$env:KITTEN_BENCH_PROMPT"' `
  --out C:\bench\kitten-opencode.json
```

Run both adapters against the same model, endpoint, and task workspaces. The first task is a smoke
task; if either adapter fails it, that adapter's 30 results are `invalid_config`, not quality scores.
This is intentional: a broken provider configuration must never appear as OpenCode 0/30.

Use `--smoke-only` for a cheap adapter check, `--only task-16-tool-arguments` for focused diagnosis,
and `--keep` to preserve workspaces from a run. The default per-task timeout is three minutes and
terminates the complete adapter process tree on Windows.
