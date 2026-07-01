# Migration

This repository used to contain a standalone Python agent, a Python TUI, a
flag-heavy Python CLI, memory/retrieval experiments, and early Pi bridge
prototypes.

Those paths are now legacy internals. The product path is:

```powershell
cheater
```

The command opens Pi with Cheater customization already loaded.

## Deprecated

- standalone Python agent loop as the user-facing product
- standalone Textual/line Python TUI
- old repair/search/guide/build subcommands as the primary workflow
- manual Pi bridge experiments
- clipboard or prompt-transfer workflows

## Current Shape

- `cheater/pi_launcher.py`: Python compatibility launcher for the existing
  console script
- `cheater-pi/src/index.ts`: npm binary launcher
- `cheater-pi/src/extension.ts`: Pi extension entry point
- `cheater-pi/prompts/cheater.md`: Cheater behavior prompt
- `cheater-pi/skills/`: Cheater skills
- `cheater-pi/themes/cheater.json`: Cheater theme

Old Python modules remain importable for legacy tests and future extraction, but
they are not started by `cheater`.
