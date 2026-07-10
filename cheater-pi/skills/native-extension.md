# Build & smoke a native/compiled extension

**Family:** `native-extension`

## Procedure

1. Identify the build system (setup.py / pyproject / Makefile / CMake) and the toolchain (gcc/clang, dev headers) before building.
1. Build as an explicit step and read the FULL compiler/linker error, not just the last line — the root cause is usually higher up.
1. A build that COMPILES is not done: import the module in a fresh process and call one symbol — linking is only proven by a successful import.
1. Common linker failures: a missing -l<lib>, an undefined symbol (wrong extern "C" / name mangling), or an ABI/version mismatch.

## Verification (feeds the execution verifier)

- Importing the built module in a clean interpreter and calling one entry point exits 0.
- The build artifact (.so/.pyd/.dll) exists and loads.

## Classifier cues

`cython`, `c extension`, `compile`, `gcc`, `clang`, `linker`, `.so`, `pyd`, `cffi`, `native`, `build ext`, `setup.py build`
