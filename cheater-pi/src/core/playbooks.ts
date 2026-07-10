// Kitten Ascent A4 — task-family skill playbooks. The senior engineer's checklist taped above the
// desk for "the kinds of jobs that come in." A weak model can't invent the scaffolding for a whole
// task family (how you actually build+smoke a C extension, how you don't corrupt git history), but it
// CAN follow a general procedure. So we give it one — keyed by family, never by task.
//
// Design Law 5: a skill is a task-FAMILY procedure ("build+test a native extension"), never a specific
// benchmark task's solution. lintPlaybooks() asserts that in code (no eval task-ids, no absolute
// benchmark paths). Each playbook carries both the procedure (primes the plan) and the verification
// (feeds Part B's verifier). Classification is the 2B sidecar's job with a deterministic keyword floor.

import type { KittenLLM } from "./llm.js";
import { EvalRegistry, canonicalId } from "./disjointness.js";

export type TaskFamily =
  | "native-extension" | "fix-test-suite" | "git-surgery" | "server-healthcheck"
  | "data-format" | "interpreter-vm" | "crypto-hash" | "sysadmin-env" | "algorithm" | "general";

export interface Playbook {
  family: TaskFamily;
  title: string;
  /** Deterministic procedure — scaffolding a weak model can't invent. General, never task-specific. */
  procedure: string[];
  /** How to verify a solve of this family (feeds Part B's execution verifier). */
  verification: string[];
  /** Keyword cues for the deterministic fallback classifier. */
  cues: string[];
}

export const PLAYBOOKS: Playbook[] = [
  {
    family: "native-extension",
    title: "Build & smoke a native/compiled extension",
    procedure: [
      "Identify the build system (setup.py / pyproject / Makefile / CMake) and the toolchain (gcc/clang, dev headers) before building.",
      "Build as an explicit step and read the FULL compiler/linker error, not just the last line — the root cause is usually higher up.",
      "A build that COMPILES is not done: import the module in a fresh process and call one symbol — linking is only proven by a successful import.",
      "Common linker failures: a missing -l<lib>, an undefined symbol (wrong extern \"C\" / name mangling), or an ABI/version mismatch."
    ],
    verification: [
      "Importing the built module in a clean interpreter and calling one entry point exits 0.",
      "The build artifact (.so/.pyd/.dll) exists and loads."
    ],
    cues: ["cython", "c extension", "compile", "gcc", "clang", "linker", ".so", "pyd", "cffi", "native", "build ext", "setup.py build"]
  },
  {
    family: "fix-test-suite",
    title: "Fix a failing test suite",
    procedure: [
      "Run the suite FIRST and capture the exact failing test names and assertion diffs before editing anything.",
      "Fix the cause in the SOURCE, not the test — unless the task states the test encodes the wrong expectation.",
      "Iterate on the failing tests alone for speed, then run the WHOLE suite to catch regressions you introduced."
    ],
    verification: [
      "The whole suite passes, not just the one target test.",
      "No previously-passing test now fails (regression guard)."
    ],
    cues: ["failing test", "test suite", "pytest", "unittest", "make test", "tests pass", "fix the test", "assertion"]
  },
  {
    family: "git-surgery",
    title: "Git history surgery (recover / rewrite / bisect)",
    procedure: [
      "Never operate on a guess: `git log --oneline --all`, `git reflog`, and `git status` first to see the real state.",
      "Recover lost commits via reflog or `git fsck --lost-found`; rewrite with rebase/filter; locate a regression with bisect.",
      "Do NOT touch the harness's own .cheater/ files — they are working state, not the repo's history."
    ],
    verification: [
      "The target commit/branch/state exists with the exact sha or message; `git log` shows it.",
      "The working tree is in the required clean/dirty state."
    ],
    cues: ["git", "commit", "reflog", "rebase", "bisect", "recover", "history", "branch", "cherry-pick", "sanitize", "repository"]
  },
  {
    family: "server-healthcheck",
    title: "Stand up a server with a healthcheck",
    procedure: [
      "Bind the EXACT host/port the task names; start the server in the background; POLL until it is ready (never sleep-and-hope).",
      "Hit the EXACT endpoint path with curl and assert both the status code and the body shape.",
      "Redirect stderr to a file so a startup crash is diagnosable instead of silent."
    ],
    verification: [
      "curl to the exact endpoint returns the expected status and body.",
      "The process is actually listening on the exact port."
    ],
    cues: ["server", "endpoint", "http", "curl", "port", "listen", "healthcheck", "flask", "nginx", "route", "serve", "webserver", "api"]
  },
  {
    family: "data-format",
    title: "Parse / transform a data format",
    procedure: [
      "Pin the exact input and output formats (delimiters, encoding, headers, key names, ordering) from the task before coding.",
      "Handle the edge rows (empty, quoted delimiters, unicode, trailing newline) — that is where format tasks fail.",
      "Round-trip: parse then re-emit and diff against the spec; do not eyeball the output."
    ],
    verification: [
      "The output matches the required format EXACTLY (columns/keys/order/encoding).",
      "A parse→emit round-trip is stable."
    ],
    cues: ["csv", "tsv", "json", "jsonl", "yaml", "xml", "parse", "serialize", "transform", "format", "encode", "decode", "columns", "delimiter"]
  },
  {
    family: "interpreter-vm",
    title: "Implement an interpreter / VM / evaluator",
    procedure: [
      "Separate the pipeline: tokenize → parse to an AST → evaluate; get each stage right in isolation.",
      "Start from the smallest complete language subset that runs ONE example end-to-end, then grow it.",
      "Model environment/scope explicitly — most evaluator bugs are scope/closure bugs."
    ],
    verification: [
      "Each worked example in the task evaluates to its stated result.",
      "Specified error cases raise as required."
    ],
    cues: ["interpreter", "evaluator", "metacircular", "vm", "bytecode", "tokenize", "parser", "ast", "eval", "scheme", "lisp", "compiler", "opcode"]
  },
  {
    family: "crypto-hash",
    title: "Crypto / hash / security task",
    procedure: [
      "Use the standard library's proven primitives; never hand-roll a cipher or hash.",
      "Match the EXACT algorithm, mode, and encoding (hex vs base64), and the byte order the task names.",
      "For a crack/search, bound the search space and verify each candidate against the real check before claiming it."
    ],
    verification: [
      "The produced digest/plaintext/signature validates against the task's exact check.",
      "The encoding and length match the specification."
    ],
    cues: ["hash", "sha", "md5", "hmac", "encrypt", "decrypt", "cipher", "crack", "password", "7z", "aes", "rsa", "signature", "digest", "checksum"]
  },
  {
    family: "sysadmin-env",
    title: "System-admin / environment task",
    procedure: [
      "Inspect the REAL environment (which tools/versions exist) before assuming — the task's box may differ from yours.",
      "Make changes idempotent: re-running the setup must not break it.",
      "Prefer the exact config file/path the task names over a plausible nearby one."
    ],
    verification: [
      "The configured service/tool BEHAVES as specified when exercised — not merely 'the file was written'.",
      "Re-running the setup is a no-op."
    ],
    cues: ["configure", "install", "environment", "systemd", "service", "cron", "path", "permission", "chmod", "apt", "setup", "daemon", "config"]
  },
  {
    family: "algorithm",
    title: "Self-contained algorithm / function",
    procedure: [
      "Nail the exact signature and return type first; derive the expected outputs BY HAND from the worked examples.",
      "Turn every rule and boundary into an assertion, run them, and fix each mismatch before finishing."
    ],
    verification: [
      "Every case derived from the task passes.",
      "Edge cases (empty / single / boundary / ordering) are covered."
    ],
    cues: ["function", "algorithm", "compute", "return", "given", "implement", "eigenvalue", "search", "sort", "graph", "dynamic programming"]
  },
  {
    family: "general",
    title: "General task",
    procedure: [
      "Extract the literal acceptance targets; make the smallest correct change to hit them.",
      "Run the change once before finishing — don't finish on assumption."
    ],
    verification: [
      "The change runs and satisfies every named target."
    ],
    cues: []
  }
];

const BY_FAMILY = new Map<TaskFamily, Playbook>(PLAYBOOKS.map((p) => [p.family, p]));

export function playbookFor(family: TaskFamily): Playbook {
  return BY_FAMILY.get(family) ?? BY_FAMILY.get("general")!;
}

const FAMILY_ENUM = PLAYBOOKS.map((p) => p.family);

const CLASSIFY_SCHEMA = {
  name: "task_family",
  schema: { type: "object", properties: { family: { type: "string", enum: FAMILY_ENUM } }, required: ["family"] }
} as const;

/** Deterministic keyword-cue classifier — the floor when the sidecar is slow/absent. */
export function classifyByKeyword(task: string): TaskFamily {
  const t = (task || "").toLowerCase();
  let best: TaskFamily = "general", bestScore = 0;
  for (const pb of PLAYBOOKS) {
    if (pb.family === "general") continue;
    let score = 0;
    for (const cue of pb.cues) if (t.includes(cue)) score++;
    if (score > bestScore) { bestScore = score; best = pb.family; }
  }
  return best;
}

/**
 * Classify the task into ONE family. The 2B sidecar decides (json_schema, clean on qwen-2b), with the
 * keyword classifier as the deterministic floor. Never throws.
 */
export async function classifyFamily(llm: KittenLLM, task: string): Promise<{ family: TaskFamily; source: "sidecar" | "keyword" }> {
  const floor = classifyByKeyword(task);
  try {
    const r = await llm.sidecar({
      messages: [{
        role: "user",
        content: `Classify this coding task into exactly one family: ${FAMILY_ENUM.join(", ")}.\n\nTask:\n"""${(task || "").slice(0, 700)}"""\n\nReturn {"family": "..."}.`
      }],
      jsonSchema: CLASSIFY_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
      maxTokens: 60,
      timeoutMs: 30000
    });
    if (r.ok && r.content.trim()) {
      const fam = (JSON.parse(r.content) as { family?: string }).family;
      if (fam && FAMILY_ENUM.includes(fam as TaskFamily)) return { family: fam as TaskFamily, source: "sidecar" };
    }
  } catch { /* fall through to the keyword floor */ }
  return { family: floor, source: "keyword" };
}

/** Render a playbook's procedure into a plan primer for the generator (bounded). */
export function primeFromPlaybook(pb: Playbook): string {
  return `Playbook for this kind of task (${pb.title}) — follow the procedure, it's the standard way:\n` +
    pb.procedure.map((s) => `- ${s}`).join("\n");
}

/** The verification hints for a family — handed to Part B's verifier as extra behavioral checks. */
export function verificationHintsFromPlaybook(pb: Playbook): string[] {
  return pb.verification;
}

/**
 * Law-5 lint: assert no playbook contains a benchmark task-id or an absolute benchmark path. Returns
 * the list of violations (empty = clean). A test asserts it is empty, so a leak fails the build.
 */
export function lintPlaybooks(registry: EvalRegistry): string[] {
  const violations: string[] = [];
  const evalIds = registry.allIds();
  for (const pb of PLAYBOOKS) {
    const text = [pb.title, ...pb.procedure, ...pb.verification, ...pb.cues].join(" ");
    // Any token that canonicalises to a registered eval id is a leak.
    for (const token of text.split(/\s+/)) {
      if (evalIds.has(canonicalId(token)) && canonicalId(token).length >= 6) violations.push(`${pb.family}: token "${token}" is an eval task id`);
    }
    // Absolute benchmark-shaped paths (/app/tests/..., /tmp/task...) don't belong in a general playbook.
    const pathHit = text.match(/\/(?:app|tmp|task|tests?)\/[A-Za-z0-9_./-]+/);
    if (pathHit) violations.push(`${pb.family}: contains a task-specific path "${pathHit[0]}"`);
  }
  return violations;
}
