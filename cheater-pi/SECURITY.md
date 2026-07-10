# Security & local data

Kitten is a local-first tool. This note describes what it does with your data and its safety model, and
is appropriate for an alpha technical preview.

## Where your data lives

- Conversations, events, and run history are stored **locally** in a single SQLite database at
  `~/.kitten/kitten.db` (override with `KITTEN_HOME`). Nothing is sent anywhere except to the model
  endpoint you configure.
- **No telemetry.** Kitten does not phone home.
- **No secrets in stored state or browser state.** API keys are never persisted to the store or sent to
  the web UI. Kitten redacts known secret patterns from captured command output where practical.

## The web UI (`kitten web`)

- Binds to **127.0.0.1** only — not your LAN or the internet.
- Every state-changing API call requires a **per-launch secret token** (sent as `x-kitten-token`, or a
  `?token=` query for the event stream). The token is embedded only in the page Kitten serves; a
  cross-origin site cannot read it and therefore cannot drive the agent.
- Request `Origin`, when present, must be the loopback origin.
- Model output is rendered with escaping (no raw HTML injection), so a malicious model response cannot
  execute script in the page.

## Running commands & editing files

- Kitten edits real files and runs real shell commands. It enforces a **safety floor** that hard-blocks
  catastrophic (`rm -rf /`, fork bombs, disk overwrite), remote-code-execution (`curl … | sh`), and
  secret-exfiltration commands in every lane.
- Merely-destructive commands (force push, recursive delete, destructive SQL, network egress) go through
  an **approval policy**: interactive clients prompt you; unattended `kitten run` defaults to denying
  them unless you pass `--dangerous`.
- Filesystem tools are meant to operate inside the project root. Treat `--dangerous` and any run in a
  directory you don't control with the same caution you would any coding agent.

## `/undo`

`/undo` (and `kitten undo`) roll back only the files a run changed, using a git snapshot taken before
the run; your pre-existing uncommitted work in other files is left untouched. Undo requires a git repo.

## Reporting a vulnerability

Please open a GitHub issue describing the problem. Given the alpha status, avoid including exploit
details for anything that could harm other users until it is addressed.
