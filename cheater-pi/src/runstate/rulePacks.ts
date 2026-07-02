// Rule packs and scar-tissue memory: retrieved, never dumped.
//
// Each pack is 5-12 bullets for one task family. A capsule gets AT MOST two packs, selected
// by goal keywords and detected languages - a worker fixing a pytest failure never sees the
// react pack. HARNESS_LESSONS is the long-term scar tissue: general lessons the harness has
// paid for (stale validation, proxy checks, post-success self-sabotage), retrievable by
// context keywords. Failure analyses append to .cheater/harness-evolution.md - general
// lessons only, never task answers or benchmark solutions.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RulePack {
  name: string;
  rules: string[];
}

const PACKS: Array<{ name: string; match: RegExp; rules: string[] }> = [
  {
    name: "python",
    match: /\b(python|pytest|pip|django|flask|fastapi|\.py\b|venv|conda)\b/i,
    rules: [
      "Run the exact failing test first (pytest path::test) before editing.",
      "Bare `import x` and `from x import y` both count - check both when fixing imports.",
      "Prefer editing the module under test, not the test, unless the test is provably wrong.",
      "Virtualenv matters: run commands with the same interpreter the task uses.",
      "Indentation errors from partial edits are the top self-inflicted failure - re-read the edited region.",
      "f-strings cannot contain backslashes in expressions on older Pythons - check the version."
    ]
  },
  {
    name: "node-react",
    match: /\b(react|jsx|tsx|next\.?js|vite|webpack|component|hook|useState|frontend)\b/i,
    rules: [
      "Check package.json scripts before inventing a build command.",
      "Hooks only at component top level; a conditional hook is a runtime error.",
      "Default vs named exports: match the import style the codebase already uses.",
      "State updates are async - do not read state right after setState and expect the new value.",
      "Do not add a dependency for something the project already has a utility for.",
      "ESM vs CJS: match the package.json `type` field; do not mix require and import."
    ]
  },
  {
    name: "typescript",
    match: /\b(typescript|\.ts\b|tsc|type error|ts\d{4})\b/i,
    rules: [
      "Read the first TS error only; later errors usually cascade from it.",
      "Never fix a type error with `any` unless the surrounding code already does.",
      "NodeNext ESM imports need explicit .js extensions on relative paths.",
      "Prefer narrowing (typeof/in/instanceof) over assertion casts.",
      "Check tsconfig strictness flags before assuming a pattern is legal."
    ]
  },
  {
    name: "rust",
    match: /\b(rust|cargo|borrow|lifetime|\.rs\b)\b/i,
    rules: [
      "Run `cargo check` before `cargo test` - it is much faster feedback.",
      "Fix the first compiler error; the rest usually cascade.",
      "Prefer cloning small data over fighting the borrow checker in a small fix.",
      "match must be exhaustive - adding an enum variant breaks every match on it.",
      "Do not edit Cargo.lock by hand."
    ]
  },
  {
    name: "go",
    match: /\b(golang|\bgo\s+(test|build|run|mod)\b|goroutine|\.go\b)\b/i,
    rules: [
      "Run `go build ./...` before `go test ./...` for fast feedback.",
      "Unused imports and variables are compile errors - remove them.",
      "Error returns are checked explicitly; do not swallow err.",
      "Table-driven tests are the convention - extend the table, not a new function.",
      "gofmt formatting is canonical - do not fight it."
    ]
  },
  {
    name: "web-server",
    match: /\b(server|endpoint|api|route|port|http|rest|flask|express|fastapi|listen)\b/i,
    rules: [
      "Validate the EXACT endpoint path from the task, not just `/`.",
      "Bind the exact port the task names; check nothing else is already on it.",
      "Return the exact status codes and content-type the task specifies.",
      "Start the server, curl the endpoint, and read the actual response body before claiming success.",
      "A background server keeps running - track it and stop it when done if the task requires."
    ]
  },
  {
    name: "data-processing",
    match: /\b(csv|json[l]?|parse|dataset|dataframe|columns?|pandas|etl|transform)\b/i,
    rules: [
      "Match the exact column names/order/delimiter the task states - do not normalize them.",
      "Re-open the produced file and inspect the first rows before claiming success.",
      "Handle the empty-input and single-row cases; evaluators love them.",
      "Preserve the exact output filename from the task.",
      "Numeric formatting matters: ints vs floats vs strings are graded differences."
    ]
  },
  {
    name: "cli-tools",
    match: /\b(cli|command[- ]line|argv|argparse|flags?|stdin|stdout|exit code)\b/i,
    rules: [
      "Exit codes are contract: 0 on success, nonzero on the specified failures.",
      "Print to stdout vs stderr exactly as the task states.",
      "Support the exact flag names given - do not rename or alias them.",
      "Test by actually invoking the CLI the way the task will, not by importing functions.",
      "Keep output format byte-exact when the task shows sample output."
    ]
  },
  {
    name: "tests-debugging",
    match: /\b(test failure|failing test|debug|flaky|assert|regression|fix the test)\b/i,
    rules: [
      "Reproduce the failure and read the real error before any edit.",
      "Fix the cause, not the assertion, unless the test contradicts the spec.",
      "After the fix, re-run the SAME command that failed - not a different one.",
      "Never weaken/skip a test to make it pass; that is graded as failure.",
      "One hypothesis per edit; two failed hypotheses means re-read the error slowly."
    ]
  },
  {
    name: "ml-training",
    match: /\b(model training|train\.py|epochs?|dataset|torch|tensorflow|sklearn|checkpoint)\b/i,
    rules: [
      "Respect the exact hyperparameters/seeds the task states - determinism is graded.",
      "Save checkpoints/outputs to the exact paths named.",
      "Small smoke run first (1 epoch / tiny subset) before the full run.",
      "Do not download datasets or weights unless the task allows network access.",
      "Log the metric the task asks for, in the format it asks for."
    ]
  },
  {
    name: "benchmark-contract",
    match: /\b(benchmark|evaluator|grader|will be (checked|graded|tested)|submission|output\.(json|csv|txt))\b/i,
    rules: [
      "The evaluator touches exact artifacts: exact filename, exact path, exact format.",
      "Validate the artifact the way the evaluator will (re-read the file, curl the endpoint).",
      "Produce no extra files or output beyond what is asked.",
      "Once the artifact is correct, STOP - post-success edits are how wins become losses.",
      "If the task shows an example output, match it byte-for-byte where specified."
    ]
  }
];

/** Select at most `max` rule packs for a goal (+ optional detected languages). */
export function selectRulePacks(goal: string, languages: string[] = [], max = 2): RulePack[] {
  const probe = `${goal ?? ""} ${languages.join(" ")}`;
  const selected: RulePack[] = [];
  for (const pack of PACKS) {
    if (pack.match.test(probe)) selected.push({ name: pack.name, rules: pack.rules });
    if (selected.length >= max) break;
  }
  return selected;
}

/** Long-term scar tissue: general harness lessons, keyword-retrievable. */
// Prefix stems (no trailing \b): "validated"/"verifying"/"modified" must all match.
const HARNESS_LESSONS: Array<{ match: RegExp; lesson: string }> = [
  { match: /\b(validat|verif|test|check|finish|done|success)/i, lesson: "Validate the exact artifact the evaluator will inspect; passing proxy checks are not enough." },
  { match: /\b(edit|chang|modif|mutat)/i, lesson: "If validation ran before a later mutation, it is stale - re-run it." },
  { match: /\b(success|passed|green|complet)/i, lesson: "Preserve final outputs after evaluator-like success; post-success cleanup is how wins are lost." },
  { match: /\b(worker|spawn|packet|capsule)/i, lesson: "One narrow worker per file cluster; never let a worker inherit the full controller context." },
  { match: /\b(reserve|budget|time|late)/i, lesson: "In reserve phase, do not refactor - run final cheap checks and stop." },
  { match: /\b(loop|repeat|stuck|again)/i, lesson: "The same failing action repeated is a loop, not persistence - change approach or stop and report." }
];

export function recallHarnessLessons(context: string, max = 3): string[] {
  const hits: string[] = [];
  for (const { match, lesson } of HARNESS_LESSONS) {
    if (match.test(context ?? "")) hits.push(lesson);
    if (hits.length >= max) break;
  }
  return hits;
}

export type FailureCauseKind =
  | "model_reasoning"
  | "context_bloat"
  | "tool_failure"
  | "stale_validation"
  | "missing_contract"
  | "bad_worker_scope"
  | "time_loop"
  | "mutation_drift"
  | "unknown";

export interface FailureAnalysis {
  taskId: string;
  symptom: string;
  likelyRootCause: string;
  causeKind: FailureCauseKind;
  proposedHarnessFix: string;
  expectedBenefit: string;
  regressionRisk: string;
  evidence?: string;
}

/**
 * Append a compact failure attribution to the harness-evolution log. General lessons only:
 * callers must not include benchmark task answers or solution content.
 */
export function recordFailureAnalysis(repoRoot: string, analysis: FailureAnalysis): string {
  const file = join(repoRoot, ".cheater", "harness-evolution.md");
  const block = [
    `## ${new Date().toISOString()} - ${analysis.taskId}`,
    `- symptom: ${analysis.symptom.slice(0, 200)}`,
    `- root cause (${analysis.causeKind}): ${analysis.likelyRootCause.slice(0, 240)}`,
    `- proposed harness fix: ${analysis.proposedHarnessFix.slice(0, 240)}`,
    `- expected benefit: ${analysis.expectedBenefit.slice(0, 160)}`,
    `- regression risk: ${analysis.regressionRisk.slice(0, 160)}`,
    ...(analysis.evidence ? [`- evidence: ${analysis.evidence.slice(0, 200)}`] : []),
    ""
  ].join("\n");
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, block + "\n", "utf8");
  return file;
}
