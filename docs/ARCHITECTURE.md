# Architecture

Cheater is a Pi wrapper/distribution.

- `cheater` launches Pi with Cheater resources preloaded.
- Pi owns the TUI, agent loop, file/code tools, edits, shell execution, context,
  sessions, and slash-command runtime.
- Cheater contributes branding, prompt guidance, skills, slash commands, helper
  tools, theme, config, and launch/doctor behavior.

See [cheater_pi.md](cheater_pi.md).
