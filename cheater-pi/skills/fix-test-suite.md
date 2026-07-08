# Fix a failing test suite

**Family:** `fix-test-suite`

## Procedure

1. Run the suite FIRST and capture the exact failing test names and assertion diffs before editing anything.
1. Fix the cause in the SOURCE, not the test — unless the task states the test encodes the wrong expectation.
1. Iterate on the failing tests alone for speed, then run the WHOLE suite to catch regressions you introduced.

## Verification (feeds the execution verifier)

- The whole suite passes, not just the one target test.
- No previously-passing test now fails (regression guard).

## Classifier cues

`failing test`, `test suite`, `pytest`, `unittest`, `make test`, `tests pass`, `fix the test`, `assertion`
