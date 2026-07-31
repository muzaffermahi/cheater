# Kitten Desktop King — the full UI update (32nd pass)

**Branch:** `kitten-desktop-king` (from `kitten-hardening`) · **Tests:** 1064 → 1070 green · **Shell:** `-warnaserror` green · **E2E:** silent-installed on the dev machine, booted from the desktop shortcut path, live run captured against the local ornith-35B.

The brief: *"The desktop app is the king. One click, an icon, no black box, no hardcoded 8k, an effort slider that buys real compute (subagents, deeper plans, web search)."* All seven asks shipped.

## What shipped, by commit

| Commit | What |
|---|---|
| `315b547` | **The icon.** Generated from the mascot's own pixel grid (`catPixels.ts`) by a zero-dep `make-icon.mjs` (raw zlib PNG + hand-packed ICO, NN upscales, box-average 16/24px). Wired into the exe (`ApplicationIcon`), the window (avares), all 12 dialogs, and the installer. Committed under `assets/icon/`. |
| `ddd4a5a` | **Live tool + verification events.** `tool.started` (callId + target) before every execution, real `durationMs`, bash streams ≤8 bounded output chunks; the finish gate / ascent verifier / repair loop emit `verification.started/evidence/passed` + `repair.started` (previously zero emitters); `route.selected` records hardness and the router's raw signal reaches the ascent budget (was `{}`). |
| `6c465cb` | **The plan + the runtime reach the screen.** Task-graph bus bridged into durable `step.started/completed` + `plan.updated` snapshots (DAG **and** an advisory outline from the compiled contract); `task.compiled-get` IPC returns the full IR; pushed `runtime.state` (starting/ready/failed-with-stderr/stopped/external, true ctxTokens) + a 15s two-strike watchdog; `run.status` reports `waiting_approval`; renderer contract written down in `docs/engine-events.md`. |
| `a2b0e50` | **Context sanity.** `contextWindowTokens` defaults to `"auto"`: n_ctx sized from VRAM + the model's own GGUF KV geometry on a discrete ladder (8k…128k), passed from **all three** launch sites (two passed `undefined` before — the 8k-vs-16k divergence), one OOM step-down retry, and a post-ready `/props` probe that points the harness budget at the server's actual n_ctx. |
| `f48766e` | **The effort dial (engine).** `effort.ts` profile table — Fast/Balanced/Careful/Think Hard → lane cap, k floor/cap, repair rounds, turn cap, `reasoning_budget`, subagent fan-out, scout width, web access, **hard ceilings 3/10/20/45 min** (the governor was never armed before), context fraction. Migration v6 persists it per conversation; `route.selected` records it. Principle: *effort sets bounds, hardness decides* — easy tasks stay fast even on Careful. Think Hard revives `decomposeCompiledTask` into a real per-piece-verified subagent DAG with unconditional lane fallback. |
| `aa43767` | **Web tools.** `web_search`/`web_fetch` in the loop (open web by default per the user's choice; `webAccess` switches to allowlist/off). SSRF floor that never relaxes, re-checked per redirect hop, including all `::ffff:` v4-mapped literals (Node normalizes them to hex — a naive check misses it). Eval-leakage guard kept. Triple-gated: settings ∧ effort profile (Fast never offers web) ∧ agent permission (subagents deny). |
| `622f88a` | **The shell renders it all.** Runtime status segment (loading/ready·model·ctx/offline/failed with stderr tooltip + one-click Start), live tool cards (spinner + elapsed + streaming preview → ✓/✗ + salient error line, replay-safe fallback), the ActivityPanel (route · k · hardness · effort, plan card with steps + Full-contract dialog, current tool, verification evidence), and the four-segment effort control persisted per conversation. |
| `7720f80` | **One click.** Installer: Desktop + Start Menu shortcuts with the icon, HKCU Add/Remove Programs entry, versioned title, update path, real uninstall (keeps `~/.kitten`), zip-preview error. `-SetupExe` now **mandatory** in the release packager (optionality is how runtime114 shipped installer-less); CI runs the full packager. `Launch Kitten.bat` demoted to `scripts/dev-launch.ps1`. Bug sweep: `--project-root` works end-to-end, second launches foreground via an activation pipe, pending approvals survive conversation switches, Evidence capped, engine restarts use the active workspace. |
| `5492597` | **`--silent` install** sharing one `InstallerCore` with the GUI; used for the scripted E2E. |

## Verified end-to-end on this machine

1. `package-desktop-release.ps1` assembled the bundle; the IPC smoke passed **including the new desktop-king verbs**.
2. `Kitten.Setup.exe --silent` → `%LOCALAPPDATA%\Kitten` + **Kitten.lnk on the Desktop and Start Menu** (icon attached) + HKCU uninstall entry (v0.7.0).
3. The **installed** app boots: engine connects, runtime segment green against the live local llama.cpp.
4. A live run through the installed app shows the whole surface at once: `route: ascent · k=2 · hardness 0 · balanced`, the compiled-contract plan card (`compile · 1 requirement · file: package.json` + Full contract), the elapsed timer, and `ready · ornith-1.0-35b · 8k ctx` — the ctx figure is the server's measured `/props` truth, not the config's wish.

## Round 2 (`18d0102`): user-controlled llama.cpp + no quiet deaths

Driven by two live complaints: the auto launch plan's `--cpu-moe` measured 7 tok/s @ 8k where the user's hand-tuned llama-server did 30 tok/s @ 32k, and a run died silently when the model emitted an oversized `write` tool call that llama.cpp 500'd on (`Failed to parse tool call arguments as JSON … missing closing quote`).

- **Runtime tuning**: `settings.runtimeTuning` (gpuLayers / cpuMoe / flashAttn / kvCacheType / sidecarDevice / extraArgs) — every launch heuristic became an overridable default; extra flags append last and win. Model setup grew a Performance-tuning section with a live `llama-server …` command preview and local-model dropdowns (`model.files`: the configured weights' folders + LM Studio trees). The sidecar defaults to CPU/RAM (`--n-gpu-layers 0`) for real parallelism.
- **No random stops**: the agent loop retries recoverable model errors in-run (transport 5xx + truncated tool calls, 3 attempts with backoff); the truncated case injects "work in smaller pieces" guidance before retrying. Recovery narrates via `run.status.detail`. Terminal failures render as a red card with a plain-language cause + a one-click Retry; a 90s client-side stall watchdog speaks up when a run goes silent.
- **Project-first**: sessions grouped under per-project headers; New task with no project opens the folder picker.

Verified: 1075 engine tests, `-warnaserror` shell, snapshots showing the grouped list and a live "model loading (warming)" runtime state; v0.7.1 silently installed over 0.7.0 (registry version updated, shortcuts intact).

## Honest edges

- The user's `~/.kitten/config.json` still pins `contextWindowTokens: 8192`; auto-sizing engages when that pin is removed (set `"contextWindowTokens": "auto"` or delete the key) **and** the managed runtime launches — an external llama.cpp keeps its own n_ctx, which Kitten now reads and follows instead of guessing.
- Think-Hard's wall-clock ceiling (45 min) is enforced by the governor, but a full think-hard decomposition run wasn't timed in this pass — the decomposition path is covered by a live scripted-runner test (`effort-decompose` in `effort.test.ts`).
- `tool.proposed` and `diff.updated` remain reserved (declared, no emitter) — marked as such at `EVENT_SCHEMA_VERSION`.
- CI (`desktop.yml`) now runs the full release packager; it needs one green run on GitHub to confirm the workflow edits.
