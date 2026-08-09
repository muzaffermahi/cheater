# Kitten Desktop

This is the native desktop client. It intentionally has no HTML, WebView, browser window, terminal
dependency, or legacy Pi launcher in the shipped executable/payload. The Avalonia client starts the
hidden `kitten-desktop-engine` process shipped by the product installer and talks to it through a
per-user Windows named pipe.

The repository's CI can build the TypeScript engine on machines without the .NET SDK. Windows desktop CI
must install the .NET 8 SDK, restore this project, publish self-contained x64/arm64 builds, and run the
UI smoke tests against a fixture engine.

The shell passes its process identity to the hidden engine. If the shell is terminated unexpectedly, the
engine notices the missing parent and exits too, preventing orphaned local-model work from continuing in
the background.
The desktop executable is single-instance guarded, so repeated launches do not create competing engine
parents or steal a running session.
If the hidden engine exits or the pipe is interrupted, the native shell marks the session disconnected,
does not start new work, tears down any stale child process, and exposes a one-click Retry engine action.
After a project is open, **New task** creates another durable conversation in that same project without
reopening the folder picker.
The conversation list also has a native search field, so durable sessions remain usable as a project
grows instead of requiring manual scrolling.
The prompt actions use a responsive two-row grid at the app's 900px minimum width, keeping planning,
implementation, execution, and stop controls visible together.

## Packaging

From the repository root, build the hidden local engine first:

```powershell
Push-Location cheater-pi
npm ci
npm run build
Pop-Location
dotnet publish desktop/Kitten.Desktop.csproj -c Release -r win-x64 --self-contained true -o dist/kitten-desktop
```

Place the complete `cheater-pi/dist` tree at `dist/kitten-desktop/engine/dist` and bundle a matching
`node.exe` beside it. The shell also accepts a compiled `kitten-desktop-engine.exe` at that path when
an installer provides one. In both cases the engine starts hidden and communicates only over the
per-user named pipe.

The reproducible bundling step is `npm run package-desktop -- --publish <avalonia-publish> --out
<bundle> --node <node.exe>`. It writes a manifest declaring the engine entrypoint and the explicit
native-only, no-browser fallback policy.

For a release artifact on Windows, publish `desktop/Installer/Kitten.Setup.csproj` and run
`npm run package-desktop-release -- -Publish ..\\artifacts\\kitten-desktop -Out ..\\artifacts\\kitten-desktop-bundle
-NodeExe ..\\artifacts\\node.exe -SetupExe ..\\artifacts\\kitten-setup\\Kitten.Setup.exe`. This validates the
complete payload, writes `release.json`, creates a portable ZIP, and emits a SHA-256 sidecar. The bundle
contains a native GUI `Kitten.Setup.exe` that installs to `%LOCALAPPDATA%\\Kitten` and creates a Start Menu
shortcut. The user does not need Node, a browser, a terminal, or PowerShell.

Settings → Local runtime can import a verified catalog JSON, select main/sidecar entries, and download
them into a user-selected folder with visible progress. The engine also exposes `model.download`,
`workspace.*`, `sidecar.*`, `agent.list`, `task.*`, and conversation/run commands through the versioned
local protocol. Model downloads write a `.part` file, resume with HTTP Range when possible, verify
SHA-256, then install atomically.
Model downloads have a native cancel action; cancellation aborts the engine request and removes no
verified model file (partial data remains resumable as a `.part` file).
The model setup supports a separate sidecar endpoint (`KITTEN_SIDECAR_BASE_URL` or project setting)
so clerical calls never compete with the main model's context or memory budget.
When both tiers share one endpoint, Kitten serializes their requests per endpoint (across all local
project/runtime clients) and still allows cancellation while a request is queued; separate endpoints
remain concurrent.

Settings is a panel inside the window, not a pop-up: the groups sit in a rail on the left (Models,
Local runtime, Performance, Advanced, Behaviour, Runtime & logs) and the selected group's controls open
on the right, over one Save. It is reached from the **Settings** button in the header, from Ctrl+K, and
from the status line; Escape closes it.

The **Local runtime** page asks for one thing: the weights. Kitten finds the `llama-server` binary
itself -- beside the app, among the backends LM Studio has downloaded, and on PATH -- reads the picked
`.gguf` header for its architecture, layer count and trained context, derives the model id from the
file name, and serves it under that id with `--alias`. It starts and stops the managed runtime,
validating both files, building the hardware-aware launch plan, starting the main and optional sidecar
children hidden on separate OpenAI-compatible endpoints, waiting for both `/models` probes, and tearing
the children down with the app. No terminal command or browser window is required. The runtime
executable and model paths are persisted in the project's `.kitten/config.json`.

The **Performance** page is the full llama.cpp control surface, at LM Studio parity: context size, GPU
offload layers, flash attention, KV cache type and whether the cache is offloaded to the GPU, CPU
threads, batch and micro-batch size, model load mode (mmap/mlock), main GPU and tensor split -- and the
mixture-of-experts split, which is the one that matters most on a card too small for the weights.
Rather than the all-or-nothing `--cpu-moe`, Kitten emits `--n-cpu-moe N`: the experts of the first N
layers run on the CPU and the rest stay resident. N is a slider against the model's real layer count,
with a **Use the suggested split** button that computes the fewest layers that make the rest fit.

The model panel is laid out as compact native rows so every setup, health, probe, and bakeoff action
remains reachable in the narrow, scrollable workspace sidebar. It also provides hardware-aware guidance for the
35B/70B/120B/200B main classes and
2B/7–9B sidecar classes, plus bounded responsiveness and quality probes. **Full bakeoff** combines the
isolated coding battery with held-out multi-file project tasks, ranks the configured tiers using both
quality signals, and saves the transparent report locally; it never pretends to be a universal benchmark.
The native **Full bakeoff** first discovers advertised same-tier candidates and compares up to three
main and three sidecar models, falling back to the configured pair when discovery is unavailable. The
native **Stop bakeoff** action cancels the bounded battery and leaves no background model work. Each
request gets up to 90 seconds so slower 35B–200B local models are not rejected by a desktop-only
short timeout.
After review, **Apply bakeoff winners** explicitly selects the top responding candidate per tier in the
project settings; it requires confirmation and never changes files or silently swaps a model. Known
parameter counts are tier-guarded: a 2B candidate cannot be selected as the main model, and a 35B+
candidate cannot be selected as the sidecar without an explicit diagnostic override.
The **Advanced** page shows the exact arguments this machine's `llama-server` would receive, including
any flag the installed build does not advertise and would skip. A hand-edited command can be *pinned*,
and a pinned command REPLACES the generated one rather than being appended to it -- the earlier
behaviour appended it as extra flags, so every argument appeared twice, the duplication compounded on
each save, and no tuning field could win against the stale copy at the end. Transient local-runtime
load responses (HTTP 503/429 and equivalent gateway statuses) are retried
inside the request timeout, so a large model becoming ready does not immediately appear as a failed
task.
The **Coding probe**
button also runs three deterministic pure-function tasks per tier in a VM sandbox, records pass/fail
receipts under the project `.cheater/model-benchmarks` directory, and never executes generated code with
filesystem, process, network, or shell access. These probes are model-selection signals, not claims of
general coding benchmark superiority. **Project probe** also runs two held-out multi-file tasks through
the same in-memory VM sandbox, persists its receipts beside the coding probe, and never writes generated
files to the selected workspace or runs shell/network code.

For orchestration, **Plan with sidecar** runs a read-only explore/review/verify DAG. **Implement bounded
plan** then shows the indexed file scope and requires explicit approval before a main-model worker can
edit those files; a read-only verifier runs afterward. Both planning modes include the same bounded
sidecar orientation packet as a direct submission, with a deterministic indexed fallback offline.
The native Stop action also cancels orientation itself; it does not wait for the plan DAG to exist
before accepting cancellation.

The **Sidecar toolbox** exposes the full clerical catalog directly in the native UI: classification,
contract extraction, file/test ranking, context compression, failure clustering, loop detection, diff
review, evidence auditing, conflict prediction, capsule preparation, model choice, risk estimation,
command suggestions, and error explanation. Every job is JSON-validated and has a deterministic
fallback when the small model is offline or returns unusable output.
The catalog also covers dependency mapping, test-case drafting, secret detection, log triage, commit
drafting, duplicate detection, token estimation, and workspace-tree summaries.
It also provides bounded workflow packs—**Task intake**, **Change review**, **Failure triage**, and
**Release readiness**—that run several validated jobs in sequence, preserve per-step provenance, and
can be cancelled as one operation. A configured sidecar now works on the shared main endpoint too; a
second endpoint remains the preferred setup when the hardware can host both models concurrently.

The native **Workspace explorer** refreshes the local index, searches files/symbols/imports, and renders
bounded context for inspection before a run. The index is persisted privately at
`.cheater/workspace-index.json`, so reopening a project is immediately useful while an explicit refresh
always re-reads the filesystem. It never opens a terminal or sends the whole repository to a model.
Every native submission also receives a bounded automatic sidecar orientation packet (task class,
candidate files, and explicit requirements) before the main model starts; it falls back to the local
index immediately when the sidecar is unavailable, so an offline setup never feels blocked waiting for
a small model. When no dedicated sidecar endpoint is configured, the scheduler serializes sidecar and
main calls on the shared endpoint rather than silently disabling the configured sidecar. With a
dedicated sidecar endpoint it can fan out up to three bounded clerical jobs while keeping main-model
work isolated. Foreground
orientation is one structured `orient_task` pass (classification, bounded files, and requirements),
so a real local sidecar gets one model-load latency instead of three serial probes.
New conversations are titled automatically from the first request using the sidecar when available,
with the same deterministic bounded title floor offline. Renaming is persisted and replayed as a
normal conversation event, so the app stays organized without manual setup.
The model panel also exposes a cached capability probe (grammar/tool-call support, logprobs, prompt
cache, context size, and thinking) so a local llama.cpp endpoint is configured from observed behavior,
not optimistic defaults. Starting a managed runtime immediately switches the live client to its new
endpoint, and project-local model settings are used when a project conversation is created.
Model validation is explicit and can actively ping catalog entries, distinguishing an advertised-but-
unloaded model from one that is actually reachable or invalid/offline, so setup failures have a useful
next action. **Model health** extends this into a bounded local candidate scan: it reports latency and
conservative 35B+ main / 2B-9B sidecar tier fit, then offers explicit native buttons to select a responding
candidate. No model is silently swapped, and unknown model names stay unknown rather than being treated
as a safe downgrade.
Once a conversation grows beyond the bounded history window, the sidecar also prepares a compact
history digest before the main turn; offline it uses the same deterministic line-preserving floor.
Failed runs receive a separate advisory failure card (signature, likely cause, severity, and salient
error lines) from the sidecar; it never upgrades, downgrades, or replaces the execution receipt.
After a file-changing run, the sidecar also performs an advisory postflight over the bounded diff:
credential-pattern detection, review warnings, evidence notes, risk level/reasons, and generated
edge-case checklists appear in the native Evidence pane.
The packet is persisted as a conversation event and reappears after reconnect/restart. This is advisory
only and never silently upgrades or downgrades the durable run grade. It also suggests bounded tests and
verification commands from the indexed project tree, so the next safe check is visible immediately.
The **Run suggested checks** button executes those allow-listed checks inside the app with hidden,
non-shell processes, capped output, timeouts, and persisted pass/fail receipts; arbitrary commands are
rejected before they can spawn. A paired **Stop checks** action terminates the process tree and records
cancellation separately from failure.

The native **Review changes** dialog provides a read-only Git status, branch, bounded tracked diff, and
small previews of untracked files. Git is called as a hidden, timeout-bounded subprocess; output is capped
before it reaches the UI or a model, so reviewing work never requires a terminal.

The native **Task board** shows the persisted subagent DAG, node states, reports, and evidence. Active plans
can be cancelled from the board; child conversations remain durable and selectable after reconnecting.
Independent sidecar scouts fan out when safe, while ready main-model workers are serialized to protect the
local GPU/context budget; dependency edges still determine the exact handoff order.
If a plan is cancelled or interrupted, **Resume incomplete plan** requeues only unfinished nodes and keeps
completed reports/evidence intact.
Dependent nodes receive bounded reports and evidence from completed dependencies as explicit handoffs, so
review/verify workers see what exploration actually found without inheriting the parent's entire transcript.
Sidecar toolbox jobs have the same explicit cancellation path and reject cancelled work rather than silently
substituting a deterministic answer.

The **Agent library** exposes built-in, user, and project-local agent definitions in the app, including
model tier, step budget, permissions, and child-spawn policy. It can create a bounded project agent
directly from the native dialog, and can run a selected subagent immediately against the active
conversation. The child conversation, lineage, cancellation ID, transcript, and receipts remain durable.
Project definitions override user definitions, which override built-ins, without requiring a config edit
or terminal.

Run completion is rendered as a durable outcome card in the native activity pane and transcript: verified/
checked/unverified grade, summary, wall time, token usage, line deltas, and changed-file count survive
conversation reloads.

**Export conversation** writes the same durable transcript, tool calls, verification receipts, subagent
results, and run grades to a user-selected Markdown file directly from the native app.

**Export diagnostics** writes a redacted support bundle through a native save picker. It records the
detected local engine, model/runtime settings, config warnings, and recent run receipts without
exposing API keys, URL credentials, or query-string tokens, and without requiring a terminal.

If the engine or app closes during a run, the conversation marks it interrupted. Reopening that
conversation enables **Resume interrupted run**, which submits a bounded continuation using the persisted
context and keeps the old run terminal rather than pretending it completed.
