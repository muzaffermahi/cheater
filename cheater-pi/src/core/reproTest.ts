// A reproduction script for a repo-shaped task, and the screen that decides whether to believe it.
//
// Kitten's verifier has always wanted a red-then-green signal — a check that FAILS before the change
// and PASSES after — because it is the only execution evidence that proves a change did the thing
// asked rather than merely not breaking anything. On a single-function task the prompt's worked
// examples supply it. On a repo-shaped task (an issue, a codebase, "fix this") there was no source
// for it at all: the repo's own suite usually passes on the unfixed code, so `reproduction` sat at
// "n/a" and eligibility collapsed to "did the existing tests still pass" — which every candidate
// satisfies, including the one that changed nothing of consequence.
//
// CodeMonkeys' result is the argument for closing that gap: writing a testing script ALONGSIDE each
// edit took it to 57.4% on SWE-bench Verified with 69.8% coverage, and R2E-Gym/DeepSWE both credit
// agent-generated execution evidence for the ~17-point jump from raw pass@1 to selected Best@1.
//
// The danger is obvious and is the reason this module is mostly a screen rather than a generator: a
// model asked to write a failing test will happily write `assert False`, or a test that passes on
// the broken code, and either one poisons selection. So a generated script is believed only if it
// **fails on the unchanged base**. That single check throws out the vacuous ones (which pass
// everywhere) and the broken ones (which fail everywhere, including after a correct fix — caught
// because then no candidate ever turns it green and it contributes nothing).

import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { KittenLLM } from "./llm.js";
import type { AcceptanceContract } from "../runstate/contract.js";

export interface ReproScript {
  /** Distinctive name, so a stray copy is always identifiable as ours. */
  filename: string;
  source: string;
}

const FILENAME = "kitten_repro_check.py";

/** True when the task looks repo-shaped — an issue against existing code rather than a fresh function. */
export function isRepoShaped(contract: AcceptanceContract, task: string): boolean {
  // A task that names several existing files, or reads like a bug report, is repo-shaped. A task that
  // names one module and gives worked examples is the single-function case the probes already cover.
  if ((contract.files?.length ?? 0) >= 2) return true;
  return /\b(?:issue|bug|traceback|regression|reproduc|stack trace|fails? with|raises?)\b/i.test(task);
}

/**
 * Ask the model for a self-contained reproduction script. Returns null on any failure — an absent
 * signal is "n/a", never a fabricated one.
 */
export async function generateReproScript(llm: KittenLLM, task: string, contract: AcceptanceContract): Promise<ReproScript | null> {
  const files = (contract.files ?? []).slice(0, 12).join(", ");
  const prompt = [
    "You are writing a REPRODUCTION script for a bug report. Its only job is to fail now and pass once the bug is fixed.",
    "",
    `Bug report:\n"""${task.slice(0, 4000)}"""`,
    files ? `\nFiles in play: ${files}` : "",
    "",
    "Write a single self-contained Python script that:",
    "  - imports the project's own code from the current working directory (no network, no pip install);",
    "  - exercises exactly the behaviour the report describes;",
    "  - exits with status 1 and prints what went wrong when the behaviour is still broken;",
    "  - exits with status 0 and prints nothing else when it is correct.",
    "",
    "Do NOT assert something that is already true, and do NOT use `assert False` or an unconditional failure —",
    "a script that cannot pass is worthless. Output ONLY the script, no fences and no commentary.",
  ].filter(Boolean).join("\n");

  try {
    const r = await llm.chat({ messages: [{ role: "user", content: prompt }], maxTokens: 900, temperature: 0, timeoutMs: 120000 });
    if (!r.ok) return null;
    const source = stripFences(r.content);
    if (!looksRunnable(source)) return null;
    return { filename: FILENAME, source };
  } catch {
    return null;
  }
}

/** Strip a ```python fence if the model added one despite being asked not to. */
export function stripFences(text: string): string {
  const fenced = /```(?:python|py)?\s*\n([\s\S]*?)```/.exec(text ?? "");
  return (fenced ? fenced[1] : (text ?? "")).trim();
}

/** Cheap sanity screen: is this plausibly a runnable script that can BOTH pass and fail? */
export function looksRunnable(source: string): boolean {
  const s = (source ?? "").trim();
  if (s.length < 40 || s.length > 20000) return false;
  // A script with no import touches no project code and therefore reproduces nothing.
  if (!/^\s*(?:import|from)\s+\w/m.test(s)) return false;
  // An unconditional failure passes nowhere, so it can never go green and is pure noise in selection.
  // Anchored at column 0 on purpose: an INDENTED `raise SystemExit(1)` is the body of an `if`, which
  // is exactly what a correct reproduction looks like. Allowing leading whitespace here rejected every
  // well-formed script and kept only the ones that failed silently.
  if (/^(?:assert\s+False|raise\s+(?:AssertionError|SystemExit\(1\))|sys\.exit\(1\))\s*$/m.test(s)) return false;
  return true;
}

/**
 * Run the script against a workspace WITHOUT writing anything into it.
 *
 * The obvious implementation — drop the script into the workspace and run it there — is wrong for the
 * base: the base is the user's actual project directory, and a verifier that scatters scratch files
 * through someone's repo has done real damage for a signal. So the script lives in a temp directory
 * and the workspace is put on the import path instead. (Python's `sys.path[0]` is the SCRIPT's
 * directory, not the cwd, which is exactly why PYTHONPATH has to be set explicitly here.)
 */
export function runReproScript(workspace: string, script: ReproScript, timeoutMs = 120000): { ran: boolean; passed: boolean; output: string } {
  let scriptPath: string;
  try {
    scriptPath = join(scratchDir(), script.filename);
    writeFileSync(scriptPath, script.source);
  } catch {
    return { ran: false, passed: false, output: "could not write the reproduction script" };
  }
  try {
    const r = spawnSync("python", [scriptPath], {
      cwd: workspace,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONPATH: [workspace, process.env.PYTHONPATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":"),
        // Importing project code writes __pycache__ next to it. That is still writing into the user's
        // repo, and it is the kind of "harmless" side effect that shows up as an unexplained untracked
        // directory in someone's `git status` hours later.
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });
    // A script that could not even start (no interpreter, import error at module load) is not evidence
    // of anything; it must read as "did not run", not as "the bug is present".
    const output = ((r.stdout ?? "") + "\n" + (r.stderr ?? "")).slice(-3000);
    if (r.error) return { ran: false, passed: false, output: String(r.error.message ?? r.error) };
    if (r.status === null) return { ran: false, passed: false, output: `no exit status (timed out after ${timeoutMs}ms?)\n${output}` };
    return { ran: true, passed: r.status === 0, output };
  } catch (e) {
    return { ran: false, passed: false, output: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The screen that makes a generated script trustworthy: it must RUN on the unchanged base and it must
 * FAIL there. A script that passes on the broken code is testing something else; a script that cannot
 * run is testing nothing. Either way it is discarded rather than used as evidence.
 *
 * Nothing is written into `baseWorkspace`; see runReproScript.
 */
export function screenReproScript(baseWorkspace: string, script: ReproScript, timeoutMs = 120000): { usable: boolean; reason: string } {
  const r = runReproScript(baseWorkspace, script, timeoutMs);
  if (!r.ran) return { usable: false, reason: `reproduction script did not run on the base: ${r.output.slice(0, 160)}` };
  if (r.passed) return { usable: false, reason: "reproduction script PASSES on the unchanged base — it does not reproduce the reported bug" };
  return { usable: true, reason: "reproduction script is red on the base (a real red-then-green screen)" };
}

/** A scratch copy of a workspace's path for screening, so the screen never writes into a real tree. */
export function scratchDir(prefix = "kitten-repro-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
