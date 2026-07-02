# Architecture

Cheater is a Pi wrapper/distribution.

- `cheater` launches Pi with Cheater resources preloaded.
- Pi owns the TUI, agent loop, file/code tools, edits, shell execution, context,
  sessions, and slash-command runtime.
- Cheater contributes branding, prompt guidance, skills, slash commands, helper
  tools, theme, config, and launch/doctor behavior.

See [cheater_pi.md](cheater_pi.md).

Durable multi-agent run state (prompt capsules, acceptance contracts, workspace digest,
mutation/validation ledgers, phase control, post-success guard) and the Codex-shaped kernel
layer (typed context fragments, world-state diffs, tool exposure lattice, controlled exec,
hook pipeline, recipe-based CodeMode-lite, fork-none worker spawns, capsule invariants,
session reincarnation, local telemetry): see [RUNSTATE.md](RUNSTATE.md).

Design rule for all of it: the model proposes intent; the harness owns state, permissions,
execution, context shape, and completion truth. New capabilities are hidden runtime
machinery - local workers see FEWER choices, not more tools.
