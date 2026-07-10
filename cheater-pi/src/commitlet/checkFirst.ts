// Check-first: red-then-green becomes law (the #1 measured reliability lever).
//
// The interface/self-test discipline used to be only a PROMPT mandate (contract.buildChecklist)
// - and even as prose it moved the hidden-oracle hard battery from 4/10 to 6/10. This module
// enforces it in code: before a commitlet's implementation is trusted, the harness resolves a
// REAL check for it (by tier), and validates that check with a mutation screen - the same check
// must FAIL against the pre-implementation snapshot (red) and PASS against the implementation
// (green). A check that passes red is garbage (it does not actually exercise the change) and is
// recorded as weak, never as proof.
//
// Four tiers, most-trustworthy first:
//   1. repo tests      - the project's own test command, when it plausibly covers the touched files.
//   2. synthesized     - a small runnable check the worker wrote into the run's checks/ dir.
//   3. behavioral smoke- run the contract's command / assert its output artifact exists and parses.
//   4. static floor    - existing gates only; the commitlet is recorded weaklyVerified and the
//                        finish gate must surface that honestly.
//
// Everything here is deterministic and side-effect-guarded. The live path must keep working if any
// of this throws: evaluateCheckFirst wraps its whole body and degrades to a static-floor result.
// There is no model-facing tool here - the kitten only writes normal code + (optionally) a normal
// test file; the handler decides what the check is and runs it.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, extname } from "node:path";
import type { Commitlet } from "./types.js";
import type { AcceptanceContract } from "../runstate/contract.js";
import type { ProjectCommands } from "../reliability/projectCommands.js";
import { runFocusedVerification, type VerificationResult } from "./verification.js";
import type { ValidationEntry } from "../runstate/validationLedger.js";

/**
 * Internal kill-switch (NOT a user-facing CheaterConfig flag - the design law forbids new config
 * flags). `enabled` gates the whole stage; `redScreen` gates only the destructive snapshot-swap
 * mutation screen (the extra check run against pre-implementation state). Both default on; either
 * can be flipped off in code if a regression is ever traced here.
 */
export const CHECK_FIRST = { enabled: true, redScreen: true };

export type CheckTier = 1 | 2 | 3 | 4;
export type CheckKind = "repo_tests" | "synthesized" | "behavioral_smoke" | "static_floor";

export interface ResolvedCheck {
  tier: CheckTier;
  kind: CheckKind;
  /** Shell commands whose collective exit-0 is the check. Empty for the static floor. */
  commands: string[];
  reason: string;
  /** True only for the static floor (tier 4): existing gates are all the proof there is. */
  weaklyVerified: boolean;
  /** Tier 2 only: where the worker's synthesized check lives. */
  checkDir?: string;
}

export type RedGreenVerdict = "proven" | "garbage" | "green_failed" | "unscreened";

export interface CheckFirstResult {
  ran: boolean;
  tier: CheckTier;
  kind: CheckKind;
  verdict: RedGreenVerdict;
  /** True when the recorded evidence is weak (static floor, or a check that could not be screened
   *  red, or a garbage check that passed pre-implementation). The finish gate WARNs on these. */
  weaklyVerified: boolean;
  commands: string[];
  note: string;
  /** The commands actually proven strong (red-then-green), for the validation ledger. */
  provenCommand?: string;
}

// ---------------------------------------------------------------------------
// Coverage: does the project's test command plausibly exercise the touched files?
// ---------------------------------------------------------------------------

const CODE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|rb|c|cc|cpp|h|hpp|php|swift|kt|scala)$/i;
const TEST_PATH_RE = /(\.test\.|\.spec\.|_test\.|(^|[\\/])test_)|([\\/])(tests?|__tests__|spec)([\\/]|$)/i;
const WALK_SKIP = new Set([".git", "node_modules", ".cheater", ".pisession", "dist", "build", ".next", "out", "coverage", ".vite", "__pycache__", ".venv", "venv", ".pytest_cache", "target"]);

/** The identifying tokens of a commitlet's touched files: basenames without extension, plus any
 *  symbol names from its spec. These are what a covering test file would mention. */
export function touchedCheckTokens(commitlet: Pick<Commitlet, "allowedFiles" | "expectedFilesTouched" | "spec">): string[] {
  const files = [...(commitlet.allowedFiles ?? []), ...(commitlet.expectedFilesTouched ?? [])]
    .filter((file) => file && !file.startsWith("(") && !file.endsWith("/") && CODE_EXT.test(file));
  const tokens = new Set<string>();
  for (const file of files) {
    const base = basename(file).replace(CODE_EXT, "");
    if (base.length >= 3) tokens.add(base.toLowerCase());
  }
  // Symbol names named in the commitlet spec (acceptance criteria / must-hold) are strong coverage
  // signals too, but only clear identifiers (avoid English words shorter than 4 chars).
  const specText = [
    ...(commitlet.spec?.acceptanceCriteria ?? []),
    ...(commitlet.spec?.behaviorMustHold ?? [])
  ].join(" ");
  for (const m of specText.matchAll(/`([A-Za-z_][A-Za-z0-9_]{3,})`/g)) tokens.add(m[1].toLowerCase());
  return [...tokens];
}

function walkFiles(root: string, predicate: (rel: string) => boolean, cap = 4000): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || out.length >= cap) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= cap) return;
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) walk(join(dir, entry.name), depth + 1);
      } else {
        const rel = join(dir, entry.name).slice(root.length + 1).replace(/\\/g, "/");
        if (predicate(rel)) out.push(rel);
      }
    }
  };
  walk(root, 0);
  return out;
}

/**
 * True when a test file in the repo plausibly covers the touched files: a test filename contains a
 * touched basename, OR a test file's content references a touched basename/symbol. Bounded: scans
 * test-file names always, and reads content for a small number of test files only.
 */
export function testCommandCoversFiles(cwd: string, tokens: string[]): boolean {
  if (!tokens.length) return false;
  const testFiles = walkFiles(cwd, (rel) => TEST_PATH_RE.test(rel), 800);
  if (!testFiles.length) return false;
  const lowerTokens = tokens.map((t) => t.toLowerCase());
  // Name match: a test file named for a touched module (test_foo.py, foo.test.ts).
  for (const file of testFiles) {
    const name = basename(file).toLowerCase();
    if (lowerTokens.some((t) => name.includes(t))) return true;
  }
  // Content match: bounded read of the first N test files, looking for a touched token.
  for (const file of testFiles.slice(0, 60)) {
    let text = "";
    try {
      text = readFileSync(join(cwd, file), "utf8").toLowerCase();
    } catch {
      continue;
    }
    if (lowerTokens.some((t) => text.includes(t))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Repo language + synthesized-check discovery
// ---------------------------------------------------------------------------

export type RepoLanguage = "node" | "python" | "other";

export function repoLanguage(cwd: string): RepoLanguage {
  if (existsSync(join(cwd, "package.json"))) return "node";
  if (
    existsSync(join(cwd, "pyproject.toml")) ||
    existsSync(join(cwd, "pytest.ini")) ||
    existsSync(join(cwd, "requirements.txt")) ||
    existsSync(join(cwd, "setup.cfg")) ||
    existsSync(join(cwd, "manage.py"))
  ) {
    return "python";
  }
  return "other";
}

/** Where a worker is asked to drop a synthesized micro-check for this commitlet. */
export function synthesizedCheckDir(runDir: string, commitletId: string): string {
  return join(runDir, "checks", commitletId.replace(/[^A-Za-z0-9._-]+/g, "-"));
}

/**
 * Discover a runnable command for a synthesized check the worker left in `dir`. Picks by file
 * type (pytest/plain python, node --test, plain node, bash script). Returns [] when the dir has no
 * recognizable check, so the caller falls through to the next tier.
 */
export function discoverSynthesizedCheck(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile());
  } catch {
    return [];
  }
  const commands: string[] = [];
  for (const name of names) {
    const abs = join(dir, name).replace(/\\/g, "/");
    const ext = extname(name).toLowerCase();
    if (ext === ".py") {
      commands.push(/(^test_|_test\.py$|^test)/i.test(name) ? `python -m pytest -q "${abs}"` : `python "${abs}"`);
    } else if (ext === ".mjs" || ext === ".cjs" || ext === ".js") {
      commands.push(/\.test\./i.test(name) ? `node --test "${abs}"` : `node "${abs}"`);
    } else if (ext === ".sh") {
      commands.push(`bash "${abs}"`);
    }
  }
  return commands;
}

// ---------------------------------------------------------------------------
// Behavioral smoke from the acceptance contract
// ---------------------------------------------------------------------------

/**
 * A behavioral smoke asserts end-state, never stdout text: run the contract's named command(s) and
 * require exit 0, and assert each named output artifact exists (and parses, for JSON). Endpoints are
 * intentionally excluded here - they need a running service, which the full verification runner owns.
 */
export function behavioralSmokeCommands(contract: Pick<AcceptanceContract, "commands" | "outputPaths"> | null, runDir?: string, commitletId?: string): string[] {
  if (!contract) return [];
  const commands: string[] = [];
  for (const cmd of (contract.commands ?? []).slice(0, 2)) {
    if (cmd && cmd.trim()) commands.push(cmd.trim());
  }
  // Output-artifact existence/parse checks run via a tiny node script (node is always present in the
  // harness runtime, so this is portable across win/linux without shell-quoting the data path).
  if (runDir && commitletId) {
    const outputs = (contract.outputPaths ?? []).slice(0, 3).filter(Boolean);
    outputs.forEach((path, i) => {
      const scriptDir = synthesizedCheckDir(runDir, commitletId);
      const scriptPath = join(scriptDir, `artifact_${i}.js`).replace(/\\/g, "/");
      try {
        mkdirSync(scriptDir, { recursive: true });
        writeFileSync(scriptPath, artifactCheckScript(path), "utf8");
        commands.push(`node "${scriptPath}"`);
      } catch {
        // best-effort: if we cannot write the probe, just skip this artifact check
      }
    });
  }
  return commands;
}

/** A self-contained node probe: the artifact must exist, be non-empty, and parse if it is JSON. */
function artifactCheckScript(artifactPath: string): string {
  const safe = JSON.stringify(artifactPath);
  return [
    "const fs = require('node:fs');",
    `const p = ${safe};`,
    "if (!fs.existsSync(p)) { console.error('missing artifact: ' + p); process.exit(1); }",
    "const s = fs.readFileSync(p, 'utf8');",
    "if (!s.trim()) { console.error('empty artifact: ' + p); process.exit(1); }",
    "if (/\\.jsonl?$/.test(p)) { try { p.endsWith('.jsonl') ? s.split(/\\r?\\n/).filter(Boolean).forEach(l => JSON.parse(l)) : JSON.parse(s); } catch (e) { console.error('artifact does not parse as JSON: ' + e.message); process.exit(1); } }",
    "process.exit(0);"
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

export interface ResolveCheckInput {
  cwd: string;
  runDir?: string;
  commitlet: Commitlet;
  contract: AcceptanceContract | null;
  projectCommands: Pick<ProjectCommands, "testCommand" | "focusedTestCommand">;
  /** Tier 2/3 synthesis is allowed only for hard/multi-commitlet work; the easy lane gets 1 or 4. */
  synthesisAllowed: boolean;
}

/**
 * Resolve the check for a commitlet by tier. Tier 1 (repo tests that cover the change) is always
 * preferred. Tiers 2 and 3 are gated by `synthesisAllowed` (never burn easy-task turns on synthesis).
 * Tier 4 (static floor) is the honest fallback.
 */
export function resolveCheck(input: ResolveCheckInput): ResolvedCheck {
  const { cwd, runDir, commitlet, contract, projectCommands, synthesisAllowed } = input;
  const tokens = touchedCheckTokens(commitlet);
  const repoTest = projectCommands.focusedTestCommand ?? projectCommands.testCommand ?? null;

  // Tier 1: the project's own tests, when they plausibly cover the touched files. The command shown
  // is the commitlet's own focused-verification command when it has one (that is what actually runs
  // via runFocusedVerification), falling back to the detected repo test command for display.
  if (repoTest && testCommandCoversFiles(cwd, tokens)) {
    const focusedCmd = commitlet.focusedVerification?.find((step) => step.command)?.command;
    return { tier: 1, kind: "repo_tests", commands: [focusedCmd ?? repoTest], reason: `repo test command covers ${tokens.slice(0, 3).join(", ") || "the change"}`, weaklyVerified: false };
  }

  if (synthesisAllowed) {
    // Tier 2: a synthesized micro-check the worker wrote into the run's checks dir.
    if (runDir) {
      const checkDir = synthesizedCheckDir(runDir, commitlet.id);
      const synthesized = discoverSynthesizedCheck(checkDir);
      if (synthesized.length) {
        return { tier: 2, kind: "synthesized", commands: synthesized, reason: `worker-synthesized check (${synthesized.length} command(s))`, weaklyVerified: false, checkDir };
      }
    }
    // Tier 3: behavioral smoke from the contract's commands / output artifacts.
    const smoke = behavioralSmokeCommands(contract, runDir, commitlet.id);
    if (smoke.length) {
      return { tier: 3, kind: "behavioral_smoke", commands: smoke, reason: `behavioral smoke from contract (${smoke.length} probe(s))`, weaklyVerified: false };
    }
  }

  // Tier 4: static floor - only the existing gates proved anything.
  return { tier: 4, kind: "static_floor", commands: [], reason: "no repo test coverage, synthesized check, or contract smoke available", weaklyVerified: true };
}

// ---------------------------------------------------------------------------
// Running checks + the red-then-green mutation screen
// ---------------------------------------------------------------------------

/** Run a list of shell commands as one check: all must exit 0. Structured like a VerificationResult. */
export function runCommandsAsCheck(cwd: string, commands: string[], timeoutMs = 120000): VerificationResult {
  if (!commands.length) return { passed: true, commandsRun: [], failures: [], summary: "no check commands" };
  const failures: string[] = [];
  const commandsRun: string[] = [];
  for (const command of commands) {
    commandsRun.push(command);
    let exitCode = 1;
    try {
      const result = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: timeoutMs, windowsHide: true });
      exitCode = typeof result.status === "number" ? result.status : 1;
      if (exitCode !== 0) failures.push(`${command} -> exit ${exitCode}: ${((result.stderr || result.stdout) ?? "").split(/\r?\n/).filter(Boolean).slice(-3).join(" | ").slice(0, 300)}`);
    } catch (err) {
      failures.push(`${command} -> ${(err as Error).message}`);
    }
  }
  return {
    passed: failures.length === 0,
    commandsRun,
    failures,
    summary: failures.length ? `check failed: ${failures.join("; ").slice(0, 400)}` : `check passed: ${commandsRun.join("; ")}`
  };
}

/** Pure classification of a red/green pair. `red === null` means the screen could not be run. */
export function classifyRedGreen(red: { passed: boolean } | null, green: { passed: boolean }): RedGreenVerdict {
  if (!green.passed) return "green_failed";
  if (!red) return "unscreened";
  return red.passed ? "garbage" : "proven";
}

export interface ScreenResult {
  screened: boolean;
  verdict: RedGreenVerdict;
  green: VerificationResult;
  red?: VerificationResult;
}

/**
 * The mutation screen. Green (current, implemented) must pass; then the commitlet's files are
 * temporarily reverted to their pre-implementation rollback snapshot and the SAME check is run
 * again - it must FAIL (red) for the check to be trusted. A check that passes red does not exercise
 * the change and is garbage. The implemented bytes are ALWAYS restored in a finally, so an
 * interruption cannot lose the worker's edits (and the rollback snapshot remains on disk regardless).
 */
export function runRedGreenScreen(cwd: string, commitlet: Commitlet, runCheck: () => VerificationResult, precomputedGreen?: VerificationResult): ScreenResult {
  // When the grade already ran this exact check green (tier 1 == focused verification), reuse it so
  // the screen costs only the one extra red run - the "free" mutation screen the spec promises.
  const green = precomputedGreen && precomputedGreen.passed ? precomputedGreen : runCheck();
  if (!green.passed) return { screened: false, verdict: "green_failed", green };
  const point = commitlet.rollbackPoint;
  if (!point?.snapshotDir || !existsSync(point.snapshotDir)) return { screened: false, verdict: "unscreened", green };

  const rel = commitlet.allowedFiles.filter((file) => file && !file.startsWith("(") && !file.endsWith("/"));
  const savedGreen = new Map<string, Buffer | null>();
  const existedBefore = new Set((point.existedFiles ?? []).map((p) => p.replace(/\\/g, "/")));
  try {
    // 1. Save the implemented (green) bytes so we can put them back.
    for (const r of rel) {
      const abs = join(cwd, r);
      savedGreen.set(r, existsSync(abs) ? readFileSync(abs) : null);
    }
    // 2. Restore the pre-implementation (red) state from the snapshot.
    for (const r of rel) {
      const snap = join(point.snapshotDir, r);
      const abs = join(cwd, r);
      if (existsSync(snap)) {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, readFileSync(snap));
      } else if (!existedBefore.has(r.replace(/\\/g, "/")) && existsSync(abs)) {
        // Created during the commitlet, not pre-existing -> remove to reach the true prior state.
        rmSync(abs, { force: true });
      }
    }
    // 3. Run the check against the red state.
    const red = runCheck();
    return { screened: true, verdict: classifyRedGreen(red, green), green, red };
  } finally {
    // 4. ALWAYS restore the implemented bytes.
    for (const [r, buf] of savedGreen) {
      const abs = join(cwd, r);
      try {
        if (buf === null) {
          if (existsSync(abs)) rmSync(abs, { force: true });
        } else {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, buf);
        }
      } catch {
        // best-effort restore; the rollback snapshot is still on disk as a last resort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Clean-state rule: reset self-test debris before the finish-gate checks
// ---------------------------------------------------------------------------

// Data files a running app writes (never source). These are always safe to treat as transient.
const ALWAYS_TRANSIENT_EXT = /\.(db|sqlite|sqlite3|log|tmp|temp|pid|bak|swp)$/i;
// Structured-data files that are transient ONLY when their name / directory reads as data output
// (so config manifests like package.json are never touched).
const DATA_EXT = /\.(json|jsonl|ndjson|csv|tsv)$/i;
const DATA_NAME_HINT = /(^|[-_.])(data|output|out|result|results|dump|export|store|db|log|logs|tmp|temp|snapshot|cache|scratch|expenses?|contacts?|todos?|records?)([-_.]|$)/i;
const DATA_DIR_HINT = /(^|[\\/])(data|tmp|temp|output|outputs|cache|scratch|logs|var)([\\/]|$)/i;
const NEVER_TRANSIENT = new Set([
  "package.json", "package-lock.json", "tsconfig.json", "jsconfig.json", "composer.json",
  "manifest.json", "app.json", "config.json", "settings.json", "pyproject.toml"
]);

/** Does this repo-relative path look like a runtime data file (not source, not config)? */
export function isTransientDataFile(rel: string): boolean {
  const norm = (rel ?? "").replace(/\\/g, "/");
  if (!norm) return false;
  const base = basename(norm).toLowerCase();
  if (NEVER_TRANSIENT.has(base)) return false;
  if (base.startsWith(".")) return false; // dotfiles are config, never transient
  if (ALWAYS_TRANSIENT_EXT.test(norm)) return true;
  if (DATA_EXT.test(norm) && (DATA_NAME_HINT.test(base) || DATA_DIR_HINT.test(norm))) return true;
  return false;
}

/** The run-created files that are transient debris and are NOT contract deliverables. */
export function transientDebris(createdFiles: string[], deliverables: string[]): string[] {
  const keep = new Set(deliverables.map((p) => (p ?? "").replace(/\\/g, "/").replace(/^\.\//, "")));
  const out: string[] = [];
  for (const file of createdFiles) {
    const norm = (file ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!norm || keep.has(norm)) continue;
    if (isTransientDataFile(norm)) out.push(norm);
  }
  return [...new Set(out)];
}

export interface ResetResult {
  removed: string[];
  keptDeliverables: string[];
  mode: "delete" | "aside";
}

/**
 * Reset self-test debris before final checks run: files the run created that look like runtime data
 * output and are not contract deliverables. Defaults to moving files aside (into
 * .cheater/transient-aside/) rather than deleting, so nothing is ever destroyed. Deliverables named
 * in the contract are always spared.
 */
export function resetTransientState(cwd: string, createdFiles: string[], deliverables: string[], opts: { mode?: "delete" | "aside" } = {}): ResetResult {
  const mode = opts.mode ?? "aside";
  const debris = transientDebris(createdFiles, deliverables);
  const removed: string[] = [];
  const asideRoot = join(cwd, ".cheater", "transient-aside");
  for (const rel of debris) {
    const abs = join(cwd, rel);
    if (!existsSync(abs)) continue;
    try {
      if (mode === "delete") {
        rmSync(abs, { force: true });
      } else {
        const dest = join(asideRoot, rel);
        mkdirSync(dirname(dest), { recursive: true });
        renameSync(abs, dest);
      }
      removed.push(rel);
    } catch {
      // best-effort; a file we cannot move is left in place (harmless)
    }
  }
  return { removed, keptDeliverables: deliverables.filter(Boolean), mode };
}

// ---------------------------------------------------------------------------
// Orchestrator: resolve + screen, fully guarded. Recording is the caller's job.
// ---------------------------------------------------------------------------

export interface EvaluateCheckFirstOpts {
  contract: AcceptanceContract | null;
  projectCommands: Pick<ProjectCommands, "testCommand" | "focusedTestCommand">;
  runDir?: string;
  /** Hard/multi-commitlet work unlocks tier 2/3 + the red screen; easy lane stays lean (1 or 4). */
  synthesisAllowed: boolean;
  /** The grade's already-computed focused-verification result; reused as the tier-1 green so the
   *  mutation screen adds only one red run, not a redundant green one. */
  precomputedGreen?: VerificationResult;
}

/**
 * Resolve the check for a commitlet and, when allowed, run the red-then-green mutation screen.
 * Returns a compact structured result; the caller records it into the validation/completion
 * ledgers. Wrapped end-to-end: any throw degrades to a safe static-floor result so the live grade
 * path is never broken by check-first.
 */
export function evaluateCheckFirst(cwd: string, commitlet: Commitlet, opts: EvaluateCheckFirstOpts): CheckFirstResult {
  if (!CHECK_FIRST.enabled) {
    return { ran: false, tier: 4, kind: "static_floor", verdict: "unscreened", weaklyVerified: true, commands: [], note: "check-first disabled" };
  }
  try {
    const resolved = resolveCheck({ cwd, runDir: opts.runDir, commitlet, contract: opts.contract, projectCommands: opts.projectCommands, synthesisAllowed: opts.synthesisAllowed });
    if (resolved.tier === 4 || !resolved.commands.length) {
      return { ran: false, tier: 4, kind: "static_floor", verdict: "unscreened", weaklyVerified: true, commands: [], note: resolved.reason };
    }
    const runCheck = (): VerificationResult =>
      resolved.tier === 1 ? runFocusedVerification(cwd, commitlet) : runCommandsAsCheck(cwd, resolved.commands);
    // The precomputed green only applies to tier 1 (same command as the grade's focused verification).
    const green0 = resolved.tier === 1 ? opts.precomputedGreen : undefined;

    // Red screen only on the hard/multi-commitlet lane (it costs an extra full check run); on the easy
    // lane we still record the green pass, just without the mutation screen.
    if (CHECK_FIRST.redScreen && opts.synthesisAllowed) {
      const screen = runRedGreenScreen(cwd, commitlet, runCheck, green0);
      const weak = screen.verdict !== "proven";
      return {
        ran: true,
        tier: resolved.tier,
        kind: resolved.kind,
        verdict: screen.verdict,
        weaklyVerified: weak,
        commands: resolved.commands,
        provenCommand: screen.verdict === "proven" ? resolved.commands[0] : undefined,
        note: redGreenNote(resolved, screen.verdict)
      };
    }

    // Easy lane: green only (no mutation screen). A green pass is real evidence but not red-proven, so
    // it is recorded weak for tier 3 smokes; a tier-1 repo test that covers the files is trusted.
    const green = green0 && green0.passed ? green0 : runCheck();
    const verdict: RedGreenVerdict = green.passed ? "unscreened" : "green_failed";
    return {
      ran: true,
      tier: resolved.tier,
      kind: resolved.kind,
      verdict,
      weaklyVerified: resolved.tier !== 1 || !green.passed,
      commands: resolved.commands,
      provenCommand: resolved.tier === 1 && green.passed ? resolved.commands[0] : undefined,
      note: green.passed ? `${resolved.kind}: green pass (no red screen on easy lane)` : `${resolved.kind}: green FAILED - ${green.summary.slice(0, 160)}`
    };
  } catch (err) {
    return { ran: false, tier: 4, kind: "static_floor", verdict: "unscreened", weaklyVerified: true, commands: [], note: `check-first degraded: ${(err as Error).message}` };
  }
}

function redGreenNote(resolved: ResolvedCheck, verdict: RedGreenVerdict): string {
  switch (verdict) {
    case "proven": return `${resolved.kind} (tier ${resolved.tier}): red-then-green PROVEN - the check fails without the change and passes with it`;
    case "garbage": return `${resolved.kind} (tier ${resolved.tier}): check passes even WITHOUT the change (garbage) - recorded weak`;
    case "green_failed": return `${resolved.kind} (tier ${resolved.tier}): the check FAILS on the implementation`;
    case "unscreened": return `${resolved.kind} (tier ${resolved.tier}): could not run the red screen (no rollback snapshot) - recorded weak`;
  }
}

// ---------------------------------------------------------------------------
// Evidence table: map each contract checklist item to the ledger entries that prove it
// ---------------------------------------------------------------------------

export type EvidenceStatus = "verified" | "weak" | "unverified";

export interface EvidenceRow {
  item: string;
  status: EvidenceStatus;
  evidence: string;
}

const BACKTICK_RE = /`([^`]{2,60})`/g;
const PATH_RE = /[\w./-]+\.(?:json|jsonl|csv|tsv|txt|md|py|ts|tsx|js|jsx|html|css|sql|db|sqlite)/gi;
const ENDPOINT_RE_2 = /\/[A-Za-z0-9_\-./{}]+/g;
const IDENT_RE = /\b([A-Za-z_][A-Za-z0-9_]{3,})\b/g;

/** Extract the identifying tokens of a checklist item (paths, backtick spans, endpoints, code
 *  symbols). Symbols are recognized as code (not English) when they carry an internal capital
 *  (camelCase / PascalCase mid-word), an underscore (snake_case), or are ALLCAPS - so sentence
 *  words like "Confirm" or "format" are not mistaken for identifiers. */
export function checklistItemTokens(item: string): string[] {
  const text = item ?? "";
  const tokens = new Set<string>();
  const add = (raw: string): void => {
    const tok = raw.trim().toLowerCase();
    if (tok.length >= 3) tokens.add(tok);
  };
  for (const m of text.matchAll(BACKTICK_RE)) add(m[1]);
  for (const m of text.matchAll(PATH_RE)) add(m[0]);
  for (const m of text.matchAll(ENDPOINT_RE_2)) add(m[0]);
  for (const m of text.matchAll(IDENT_RE)) {
    const w = m[1];
    if (/[a-z][A-Z]|[A-Z][a-z].*[A-Z]|_/.test(w) || /^[A-Z]{2,}$/.test(w)) add(w);
  }
  return [...tokens];
}

/**
 * Build the finish-gate evidence table: one row per contract checklist item, mapped to the
 * validation ledger entries that prove it. A fresh passing validation sharing a token = verified;
 * a weak (unscreened/static) validation = weak; nothing matching = unverified. This is descriptive
 * (the product's face) - it does not by itself change the allow/block decision.
 */
export function buildEvidenceTable(checklist: string[], validations: ValidationEntry[]): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  for (const item of (checklist ?? []).slice(0, 8)) {
    const tokens = checklistItemTokens(item);
    let best: { status: EvidenceStatus; evidence: string } | null = null;
    for (const entry of validations) {
      const probe = `${entry.command ?? ""} ${entry.name} ${entry.validates.join(" ")}`.toLowerCase();
      const matches = tokens.some((t) => probe.includes(t));
      if (!matches) continue;
      const isCheckFirst = /check_first/.test(entry.name);
      // A check-first entry is weak when it records the weak marker or was left "unknown" (ran but not
      // red-proven). A stale pass is weak too - the files changed after it ran.
      const weak = (isCheckFirst && (/\bweak\b|unscreened|garbage|static/.test(entry.outputSummary ?? "") || entry.status === "unknown"));
      const status: EvidenceStatus =
        entry.status === "pass" && !entry.stale && !weak ? "verified"
        : (entry.status === "pass" && (entry.stale || weak)) || weak ? "weak"
        : "unverified";
      const evidence = `${entry.name}${entry.command ? ` (${entry.command.slice(0, 40)})` : ""} -> ${entry.status}${entry.stale ? " STALE" : ""}`;
      // Prefer the strongest evidence found for this item.
      if (!best || rank(status) > rank(best.status)) best = { status, evidence };
    }
    rows.push(best ? { item, status: best.status, evidence: best.evidence } : { item, status: "unverified", evidence: "no validation recorded" });
  }
  return rows;
}

function rank(status: EvidenceStatus): number {
  return status === "verified" ? 2 : status === "weak" ? 1 : 0;
}

/** Compact human-readable render of the evidence table for the finish report. */
export function renderEvidenceTable(rows: EvidenceRow[]): string[] {
  if (!rows.length) return [];
  const mark = (s: EvidenceStatus): string => (s === "verified" ? "[verified]" : s === "weak" ? "[weak]" : "[unverified]");
  return ["Contract evidence table:", ...rows.map((row) => `  ${mark(row.status)} ${row.item.slice(0, 90)}  <- ${row.evidence}`)];
}
