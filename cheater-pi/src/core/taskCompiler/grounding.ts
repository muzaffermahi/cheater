// Task Compiler — Stage 3: repository grounding.
//
// This is where a contract stops being generic advice. "Use the existing export service" is worth
// more than a paragraph of best practices, and it costs one manifest read.
//
// THE FILTER IS THE FEATURE: a fact is recorded only if it would CHANGE an implementation decision.
// The repository has thousands of true facts; almost none of them belong in a 16k context on a
// 20 tok/s model. So grounding answers a fixed, small set of questions — what stack is this, how are
// things named, what already exists that should be extended, what runs the tests — and records
// nothing else. Raw search results are never dumped into the contract; the trace keeps the provenance.
//
// Everything here is deterministic filesystem work (bounded reads of manifests and a directory
// listing). The optional WorkspaceIndex adds symbol/file ranking when a client already owns one; its
// absence degrades ranking, never correctness.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceIndex } from "../workspaceIndex.js";
import { normalizePathForPrompt } from "../promptEpoch.js";
import { idFactory, type AffectedSurface, type RepositoryEvidenceRef, type TaskFamily } from "./ir.js";
import type { LiteralExtraction } from "./extract.js";

export interface RepositoryFacts {
  root: string;
  /** Package/build manifests actually present. */
  manifests: string[];
  /** Primary stack, when a manifest establishes one. */
  stack: string | null;
  /** Frameworks/libraries the repository already depends on (bounded, high-signal only). */
  dependencies: string[];
  /** Commands the repository itself provides. */
  testCommand: string | null;
  typecheckCommand: string | null;
  buildCommand: string | null;
  lintCommand: string | null;
  /** Top-level source/test directory conventions. */
  sourceDirs: string[];
  testDirs: string[];
  /** Files the request named that actually exist. */
  existingNamedFiles: string[];
  /** Files the request named that do NOT exist (an absence is evidence too). */
  missingNamedFiles: string[];
  /** Is this an empty/new workspace? Changes what a from-scratch build may assume. */
  empty: boolean;
}

export interface GroundingResult {
  facts: RepositoryFacts;
  evidence: RepositoryEvidenceRef[];
  affectedSurfaces: AffectedSurface[];
  /** Evidence id of the dependency roster, when it was recorded at all. The "do not add a new
   *  dependency" requirement is generated only when this exists, so the requirement can never cite
   *  evidence that was deliberately withheld. */
  dependencyEvidenceId: string | null;
  /** How many bounded repository queries ran (observability; not a score). */
  queries: number;
}

const MANIFESTS: ReadonlyArray<[string, string]> = [
  ["package.json", "node"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["Cargo.toml", "rust"],
  ["go.mod", "go"],
  ["pom.xml", "java"],
  ["build.gradle", "java"],
  ["Gemfile", "ruby"],
  ["composer.json", "php"],
];

/** Dependencies worth naming in a contract: they fix an implementation choice. A contract that lists
 *  every transitive dependency has told the model nothing while spending hundreds of tokens. */
const SIGNIFICANT_DEPS = new Set([
  "react", "vue", "svelte", "@angular/core", "next", "nuxt", "express", "fastify", "koa", "hono",
  "flask", "django", "fastapi", "starlette", "sqlalchemy", "pydantic", "pytest",
  "typescript", "vitest", "jest", "mocha", "tailwindcss", "prisma", "drizzle-orm",
  "better-sqlite3", "pg", "mysql2", "mongoose", "redis", "axios", "zod",
]);

const SOURCE_DIR_NAMES = ["src", "lib", "app", "packages", "source"];
const TEST_DIR_NAMES = ["test", "tests", "spec", "__tests__"];

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function topLevelDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isEmptyWorkspace(root: string): boolean {
  try {
    const entries = readdirSync(root).filter((name) => !name.startsWith("."));
    return entries.length === 0;
  } catch {
    return false;
  }
}

function fileExists(root: string, relative: string): boolean {
  try {
    const target = join(root, relative);
    return existsSync(target) && statSync(target).isFile();
  } catch {
    return false;
  }
}

/** Collect the bounded set of repository facts. Reads manifests and one directory listing — nothing
 *  that scales with repository size. */
export function collectRepositoryFacts(root: string, literals: LiteralExtraction): { facts: RepositoryFacts; queries: number } {
  let queries = 0;
  const manifests: string[] = [];
  let stack: string | null = null;
  for (const [name, language] of MANIFESTS) {
    queries++;
    if (!fileExists(root, name)) continue;
    manifests.push(name);
    stack ??= language;
  }

  const dependencies: string[] = [];
  let testCommand: string | null = null;
  let typecheckCommand: string | null = null;
  let buildCommand: string | null = null;
  let lintCommand: string | null = null;

  if (manifests.includes("package.json")) {
    queries++;
    const pkg = readJson(join(root, "package.json"));
    const scripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
    const named = (key: string): string | null => (typeof scripts[key] === "string" && String(scripts[key]).trim() ? `npm run ${key}` : null);
    testCommand = typeof scripts.test === "string" && String(scripts.test).trim() ? "npm test" : null;
    typecheckCommand = named("typecheck") ?? named("type-check") ?? named("tsc");
    buildCommand = named("build");
    lintCommand = named("lint");
    for (const field of ["dependencies", "devDependencies"]) {
      const deps = (pkg?.[field] ?? {}) as Record<string, unknown>;
      for (const name of Object.keys(deps)) if (SIGNIFICANT_DEPS.has(name)) dependencies.push(name);
    }
  }
  if (!testCommand && (manifests.includes("pyproject.toml") || manifests.includes("requirements.txt"))) {
    queries++;
    const hasPytest = manifests.some((m) => {
      try { return readFileSync(join(root, m), "utf8").toLowerCase().includes("pytest"); } catch { return false; }
    });
    if (hasPytest) { testCommand = "python -m pytest"; dependencies.push("pytest"); }
  }
  if (!testCommand && manifests.includes("Cargo.toml")) testCommand = "cargo test";
  if (!testCommand && manifests.includes("go.mod")) testCommand = "go test ./...";

  queries++;
  const dirs = topLevelDirs(root);
  const sourceDirs = dirs.filter((name) => SOURCE_DIR_NAMES.includes(name));
  const testDirs = dirs.filter((name) => TEST_DIR_NAMES.includes(name));

  const named = [...new Set([...literals.contract.files, ...literals.contract.outputPaths])].slice(0, 12);
  const existingNamedFiles: string[] = [];
  const missingNamedFiles: string[] = [];
  for (const relative of named) {
    queries++;
    (fileExists(root, relative) ? existingNamedFiles : missingNamedFiles).push(relative);
  }

  return {
    facts: {
      root,
      manifests,
      stack,
      dependencies: [...new Set(dependencies)].slice(0, 8),
      testCommand,
      typecheckCommand,
      buildCommand,
      lintCommand,
      sourceDirs,
      testDirs,
      existingNamedFiles,
      missingNamedFiles,
      empty: isEmptyWorkspace(root),
    },
    queries,
  };
}

/**
 * Turn facts into EVIDENCE, keeping only what changes an implementation decision for THIS family.
 * The gate is per-fact and explicit — this is the function that prevents prompt bloat at the source,
 * rather than trimming it back out during rendering.
 */
export function groundTask(
  root: string,
  literals: LiteralExtraction,
  family: TaskFamily,
  index?: WorkspaceIndex,
): GroundingResult {
  const { facts, queries: factQueries } = collectRepositoryFacts(root, literals);
  let queries = factQueries;
  const nextEvidenceId = idFactory("ev");
  const nextSurfaceId = idFactory("sf");
  const evidence: RepositoryEvidenceRef[] = [];
  const affectedSurfaces: AffectedSurface[] = [];

  const record = (kind: RepositoryEvidenceRef["kind"], detail: string, path?: string): RepositoryEvidenceRef => {
    const ref: RepositoryEvidenceRef = { id: nextEvidenceId(), kind, detail, ...(path ? { path: normalizePathForPrompt(path) } : {}) };
    evidence.push(ref);
    return ref;
  };

  // Stack + dependencies: they decide what the implementation may even use. Recorded for every family
  // that writes code; an investigation does not need them to answer a question.
  const mutates = family !== "repository_investigation";
  if (mutates && facts.stack && facts.manifests.length) {
    record("manifest", `Project stack is ${facts.stack} (${facts.manifests.join(", ")}).`, facts.manifests[0]);
  }
  // The dependency roster is withheld for a bounded edit to a file the user named, and this is a
  // MEASURED decision, not a stylistic one. Live A/B on ornith-1.0-35b, same task
  // ("make slugify lowercase and hyphenate, in src/slug.js"): with the roster present the model
  // imported zod and wrapped the function in schema validation nobody asked for; with the compiler
  // off it produced the correct one-line change. Rewording from "reuse the existing zod setup" to a
  // prohibition did NOT fix it — merely NAMING an available dependency is enough to invite its use.
  //
  // Which is the grounding filter working as specified: evidence earns its place only by changing an
  // implementation decision. When the user has already pointed at the file to edit, the dependency
  // list changes nothing — and demonstrably makes the outcome worse.
  const boundedEdit = facts.existingNamedFiles.length > 0;
  let dependencyEvidenceId: string | null = null;
  if (mutates && facts.dependencies.length && !boundedEdit) {
    // Stated as a FACT, not a directive: "reuse these" reads to a small model as "use these".
    dependencyEvidenceId = record("manifest", `Dependencies already available: ${facts.dependencies.join(", ")}.`, facts.manifests[0]).id;
  }

  // Directory conventions only matter when something NEW is being created; for an edit to an existing
  // file the path is already known and the convention adds nothing.
  const creatingSomething = family === "new_application" || family === "test_creation" || family === "feature_implementation";
  if (creatingSomething && facts.sourceDirs.length) {
    record("convention", `Source lives under ${facts.sourceDirs.map((d) => `${d}/`).join(", ")}.`);
  }
  if ((creatingSomething || family === "bug_fix") && facts.testDirs.length) {
    record("convention", `Tests live under ${facts.testDirs.map((d) => `${d}/`).join(", ")}.`);
  }

  // Commands: the verification compiler consumes these, and the model needs to know a check exists.
  if (facts.testCommand) record("command", `Repository test command: ${facts.testCommand}`);
  if (facts.typecheckCommand) record("command", `Repository typecheck command: ${facts.typecheckCommand}`);

  // A named file that EXISTS fixes the edit target; a named file that is MISSING is exactly the fact
  // that stops the model inventing an edit to a file that was never there.
  for (const path of facts.existingNamedFiles) {
    const ref = record("file", `${path} exists — modify it rather than creating a parallel file.`, path);
    affectedSurfaces.push({ id: nextSurfaceId(), path, reason: "named by the request and present in the repository", evidenceRefs: [ref.id] });
  }
  for (const path of facts.missingNamedFiles) {
    record("absence", `${path} does not exist in this repository.`, path);
  }

  if (facts.empty && family === "new_application") {
    record("absence", "Workspace is empty — no existing conventions constrain the layout.");
  }

  // Optional index ranking: candidate files for a change whose target the user did NOT name. Bounded
  // hard, and only when we have nothing better — an unnamed target is the case ranking exists for.
  if (index && !facts.existingNamedFiles.length && (family === "bug_fix" || family === "refactor" || family === "performance_optimization")) {
    queries++;
    const hits = index.search(literals.statedOutcome || literals.rawRequest, 4);
    for (const hit of hits.slice(0, 3)) {
      const ref = record("index", `${hit.path} matches the request${hit.symbols.length ? ` (defines ${hit.symbols.slice(0, 3).join(", ")})` : ""}.`, hit.path);
      affectedSurfaces.push({ id: nextSurfaceId(), path: normalizePathForPrompt(hit.path), reason: "ranked candidate for the described behavior", evidenceRefs: [ref.id] });
    }
  }

  return { facts, evidence, affectedSurfaces, queries, dependencyEvidenceId };
}
