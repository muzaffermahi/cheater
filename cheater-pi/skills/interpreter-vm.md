# Implement an interpreter / VM / evaluator

**Family:** `interpreter-vm`

## Procedure

1. Separate the pipeline: tokenize → parse to an AST → evaluate; get each stage right in isolation.
1. Start from the smallest complete language subset that runs ONE example end-to-end, then grow it.
1. Model environment/scope explicitly — most evaluator bugs are scope/closure bugs.

## Verification (feeds the execution verifier)

- Each worked example in the task evaluates to its stated result.
- Specified error cases raise as required.

## Classifier cues

`interpreter`, `evaluator`, `metacircular`, `vm`, `bytecode`, `tokenize`, `parser`, `ast`, `eval`, `scheme`, `lisp`, `compiler`, `opcode`
