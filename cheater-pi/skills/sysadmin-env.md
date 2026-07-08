# System-admin / environment task

**Family:** `sysadmin-env`

## Procedure

1. Inspect the REAL environment (which tools/versions exist) before assuming — the task's box may differ from yours.
1. Make changes idempotent: re-running the setup must not break it.
1. Prefer the exact config file/path the task names over a plausible nearby one.

## Verification (feeds the execution verifier)

- The configured service/tool BEHAVES as specified when exercised — not merely 'the file was written'.
- Re-running the setup is a no-op.

## Classifier cues

`configure`, `install`, `environment`, `systemd`, `service`, `cron`, `path`, `permission`, `chmod`, `apt`, `setup`, `daemon`, `config`
