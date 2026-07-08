# Git history surgery (recover / rewrite / bisect)

**Family:** `git-surgery`

## Procedure

1. Never operate on a guess: `git log --oneline --all`, `git reflog`, and `git status` first to see the real state.
1. Recover lost commits via reflog or `git fsck --lost-found`; rewrite with rebase/filter; locate a regression with bisect.
1. Do NOT touch the harness's own .cheater/ files — they are working state, not the repo's history.

## Verification (feeds the execution verifier)

- The target commit/branch/state exists with the exact sha or message; `git log` shows it.
- The working tree is in the required clean/dirty state.

## Classifier cues

`git`, `commit`, `reflog`, `rebase`, `bisect`, `recover`, `history`, `branch`, `cherry-pick`, `sanitize`, `repository`
