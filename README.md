# 🐱 Kitten

**A reliable, local-first native desktop coding agent for local models — durable conversations,
sidecar orchestration, and an adaptive reliability engine.**

Kitten runs a coding agent against a model you host locally (LM Studio, llama.cpp, or any
OpenAI-compatible endpoint). It edits your repo, runs bounded project checks, verifies its own work
with real execution, isolates risky attempts, and remembers every session. The supported product is a
browser-free native Windows app with a hidden local engine; the release bundle contains no HTML,
WebView, terminal, or TUI surface.

> **Alpha / technical preview.** It works end to end; expect rough edges. Built for *local* models — it
> is honest about the latency and capability that implies, and makes no hosted-agent parity claims.

> The local model is a kitten — fast, sharp claws, writes any single piece of code beautifully, but
> wanders, invents doors that don't exist, and never knows when it's done. Kitten is the handler: it does
> every non-intelligent job deterministically, hands the model one small fully-briefed piece at a time,
> checks each with a real test before trusting it, and only says "done" with receipts.

## Quick start

[**Download the latest Windows release**](https://github.com/muzaffermahi/cheater/releases/latest),
extract the zip, and run `Kitten.Setup.exe`.

The supported user path is the packaged native app: extract the release zip, run `Kitten.Setup.exe`,
and Kitten appears on your **Desktop and Start Menu** with its own icon — double-click it and the app
opens; the engine and (if configured) the local llama.cpp runtime start themselves. The installer and
app never open a terminal or browser, and uninstalling from *Add or remove programs* keeps your
conversations (`~/.kitten`).

To build and install from source (Node 22.5+ and the .NET 8 SDK):

```sh
cd cheater-pi && npm install && npm run build && cd ..
dotnet publish desktop/Kitten.Desktop.csproj -c Release -r win-x64 --self-contained true -o artifacts/kitten-desktop
dotnet publish desktop/Installer/Kitten.Setup.csproj -c Release -r win-x64 --self-contained true -o artifacts/kitten-setup
powershell -ExecutionPolicy Bypass -File cheater-pi/scripts/package-desktop-release.ps1 -Publish ../artifacts/kitten-desktop -Out ../artifacts/kitten-desktop-bundle -NodeExe "$(node -e "console.log(process.execPath)")" -SetupExe ../artifacts/kitten-setup/Kitten.Setup.exe
# then run artifacts/kitten-desktop-bundle/Kitten.Setup.exe
```

Developers iterating on the shell can use `scripts/dev-launch.ps1` (builds if needed, stages the
engine, launches — not the shipped path).

The terminal/web/CLI modules remain maintainer compatibility code and are not part of the native
release payload or supported user workflow.

## How it works

- **Adaptive routing** — questions get an answer-only lane; ordinary edits get the reliable lane at
  `k=1` (check-first + post-edit gates + a finish gate that refuses "done" without execution evidence);
  only genuinely hard/risky/ambiguous/large-build tasks escalate to the **Ascent** engine (best-of-N →
  execution consensus → finished-but-wrong repair). Easy tasks never pay best-of-N latency.
- **Durable everything** — conversations, events, and runs persist to `~/.kitten/kitten.db`; close and
  resume in either UI; a crash marks in-flight runs interrupted rather than lying about them.
- **Runtime recovery** — once a local llama.cpp executable and model paths are configured, Kitten
  remembers them and attempts a bounded automatic restart when the native app opens; a bad path never
  prevents the UI from opening, and the setup dialog remains available for repair.
- **Native onboarding** — Model setup scans common loopback ports for LM Studio, llama.cpp, vLLM, or
  Ollama-compatible endpoints, then recommends tier-compatible advertised models.
- **Direct specialist invocation** — type `@security audit the auth boundary` (or any Agent Library
  role) in the native composer to create a durable bounded child session without opening a dialog.
- **Real safety** — a floor blocks catastrophic / remote-code-execution / secret-exfiltration commands
  in every lane; an approval policy gates destructive ones; `/undo` rolls back a run's own file changes
  (git-backed) while preserving your other work.
- **Useful sidecar workers** — the native Agent library includes bounded explore, architect, security,
  debug, test, release, docs, performance, review, and verify roles. They run as durable child conversations on the
  2B–9B tier, return inspectable evidence, and cannot write files unless a separately-scoped main
  worker is explicitly chosen. Read-only plans select the specialist from the task's intent
  automatically.
- **No telemetry.** Nothing leaves your machine except calls to your configured model endpoint.

## Where the strength (and honesty) is

A capable local model already solves small, well-scoped tasks on its own — there Kitten mostly adds
orchestration overhead, which the adaptive router keeps to `k=1`. Kitten earns its keep on **harder
tasks where the bare model ships plausible-but-subtly-wrong work**, and on **never shipping unverified
work**. The reliability engine and its measurements are documented in
[`KITTEN-ASCENT.md`](./KITTEN-ASCENT.md), [`KITTEN-CODE.md`](./KITTEN-CODE.md), and
[`LOCAL-INFERENCE-PASS.md`](./LOCAL-INFERENCE-PASS.md). **Those battery/real-repo numbers are external,
single-run, and directional** — the only continuously-verified figure is the in-repo test suite.

## Documentation

- [`KITTEN-PRODUCT.md`](./KITTEN-PRODUCT.md) — the product architecture, event model, storage schema, status.
- [`cheater-pi/README.md`](./cheater-pi/README.md) — install, usage, endpoints, troubleshooting.
- [`cheater-pi/SECURITY.md`](./cheater-pi/SECURITY.md) — the local-data + web-security model.
- [`cheater-pi/CONTRIBUTING.md`](./cheater-pi/CONTRIBUTING.md) — development.

## Compatibility

`cheater` is a compatibility alias for the native app launcher. Legacy TUI/web/CLI modules remain
available only for maintainer tests; the canonical supported surface is the native Kitten app.
Internals still read `.cheater/` for compatibility; the canonical data/config home is `~/.kitten`.

## License

MIT — see [`cheater-pi/LICENSE`](./cheater-pi/LICENSE).
