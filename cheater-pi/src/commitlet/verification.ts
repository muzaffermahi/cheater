import { spawnSync } from "node:child_process";
import { compressFailureOutput } from "../reliability/failureCompressor.js";
import type { Commitlet, VerificationStep } from "./types.js";

export interface VerificationResult {
  passed: boolean;
  commandsRun: string[];
  failures: string[];
  summary: string;
}

export function runFocusedVerification(cwd: string, commitlet: Commitlet, timeoutMs = 120000): VerificationResult {
  const commands = commitlet.focusedVerification.filter((step) => step.command).map((step) => step as VerificationStep & { command: string });
  if (!commands.length) {
    return {
      passed: true,
      commandsRun: [],
      failures: [],
      summary: "No command-backed focused verification; manual review required."
    };
  }
  const failures: string[] = [];
  const commandsRun: string[] = [];
  for (const step of commands) {
    commandsRun.push(step.command);
    const result = spawnSync(step.command, {
      cwd,
      shell: true,
      encoding: "utf8",
      timeout: step.timeoutSeconds ? step.timeoutSeconds * 1000 : timeoutMs,
      windowsHide: true
    });
    const exitCode = typeof result.status === "number" ? result.status : 1;
    if (exitCode !== 0) {
      // Structured failure card (expected/got, top stack file, next-action) instead of a
      // blunt tail truncation, so the repair prompt is a localization answer not noise.
      // Evidence injection deliberately does NOT happen here: this function also scores
      // every resampling candidate, and the Cheat Layer (buildCheatSheet in gradeCommitlet)
      // owns retrieval exactly once per graded failure instead of once per attempt.
      failures.push(compressFailureOutput(step.command, result.stdout ?? "", result.stderr ?? "", exitCode));
      if (step.required) break;
    }
  }
  return {
    passed: failures.length === 0,
    commandsRun,
    failures,
    summary: failures.length ? `Focused verification failed: ${failures.join("; ")}` : `Focused verification passed: ${commandsRun.join("; ")}`
  };
}

export function compressFailure(text: string, maxChars = 600): string {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const important = lines.filter((line) => /\b(error|fail|failed|assert|exception|traceback|TS\d+)\b/i.test(line));
  const selected = (important.length ? important : lines).slice(0, 8).join("\n");
  return (selected || "no output").slice(0, maxChars);
}
