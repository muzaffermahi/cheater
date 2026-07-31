// Generalized from-scratch build support. Cheater was built to EDIT its own repo; it had no way to
// CREATE a new app and fell back to its own filenames (src/commands.ts) + its own constraints, so a
// "build a web app" goal produced a Pi CLI. This module adds a STACK-AGNOSTIC create path: detect a
// from-scratch build, and let the MODEL propose the file structure from its own knowledge of whatever
// stack the goal names. There is deliberately NO per-framework template here - Cheater never decides
// "this is React, use these files"; it only provides the create-mode machinery.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractJsonObject } from "../sidecar/schemas.js";

// The dependency/manifest file of common ecosystems. Its presence means the project already exists.
export const ECOSYSTEM_MANIFESTS = [
  "package.json", "pyproject.toml", "requirements.txt", "Pipfile", "setup.py",
  "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts",
  "Gemfile", "composer.json", "deno.json", "mix.exs", "pubspec.yaml", "CMakeLists.txt"
];

export function repoHasManifest(repoRoot: string): boolean {
  const hasAt = (dir: string): boolean =>
    ECOSYSTEM_MANIFESTS.some((manifest) => { try { return existsSync(join(dir, manifest)); } catch { return false; } });
  if (hasAt(repoRoot)) return true;
  // A manifest in an immediate subdirectory (a monorepo: frontend/package.json, server/pyproject.toml)
  // also means the project already exists — don't scaffold over it. Bounded to one level; an empty repo
  // has no such subdir, so the genuine from-scratch (empty-dir) path is unaffected.
  try {
    for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (hasAt(join(repoRoot, entry.name))) return true;
    }
  } catch { /* unreadable → treat as no manifest */ }
  return false;
}

export function isManifestPath(path: string): boolean {
  return ECOSYSTEM_MANIFESTS.includes(path.split("/").pop() ?? "");
}

/** The install/dependency-fetch command for a given manifest — so a stack-agnostic scaffold does not
 *  hardcode `npm install` for a Python/Go/Rust/etc. build (the exact Flask+React case). */
export function installCommandForManifest(manifestPath: string): string {
  switch ((manifestPath.split("/").pop() ?? "").toLowerCase()) {
    case "package.json": return "npm install";
    case "requirements.txt": return "pip install -r requirements.txt";
    case "pipfile": return "pipenv install";
    case "pyproject.toml":
    case "setup.py": return "pip install -e .";
    case "cargo.toml": return "cargo build";
    case "go.mod": return "go mod download";
    case "gemfile": return "bundle install";
    case "composer.json": return "composer install";
    case "pom.xml": return "mvn install";
    case "build.gradle":
    case "build.gradle.kts": return "gradle build";
    case "mix.exs": return "mix deps.get";
    case "pubspec.yaml": return "flutter pub get";
    case "deno.json": return "deno cache";
    case "cmakelists.txt": return "cmake -B build && cmake --build build";
    default: return "the project's documented install step";
  }
}

const CREATE_INTENT = /\b(from scratch|create|build|make|scaffold|bootstrap|generate|new)\b/i;
const APP_NOUN = /\b(app|application|project|web ?app|webapp|website|site|spa|dashboard|tool|game|service|api|cli|library|package|extension|command center)\b/i;
// A named tech stack/framework. A goal that pairs one of these with an app noun is unmistakably a
// build request even with NO create verb ("Vite + React + TypeScript todo app with X components") -
// terse goals from a small model routinely drop the verb, which would otherwise misroute answer_only.
const STACK_NOUN = /\b(react|vite|vue|svelte|next\.?js|nuxt|angular|typescript|tsx|tailwind|express|fastapi|django|flask|remix|astro|solid(?:js)?|expo|electron|preact|redux|node(?:js)?|webpack|rollup)\b/i;
// An interrogative goal is a QUESTION ("what is the best way to structure a react app?"), never a build,
// so the verb-less stack+app path must not fire on it.
const QUESTION_LEAD = /^\s*(what|how|why|when|where|which|who|whose|should|is|are|am|can|could|would|will|does|do|did|explain|tell me|describe|help me understand|compare)\b/i;
// An EDIT/FIX intent means the goal is about an EXISTING app ("fix the flask routing in my app"), so the
// verb-less stack+app path must not treat it as a from-scratch build.
const EDIT_INTENT = /\b(fix|debug|repair|refactor|rename|modif\w+|migrat\w+|improve|optimi[sz]e|adjust|tweak|patch|resolve|update|chang\w+)\b/i;

/**
 * A from-scratch build: no ecosystem manifest present AND the goal reads as "create a new app/project".
 * Also true (verb-less) when the goal names BOTH a stack and an app noun in an empty repo and is NOT a
 * question, because a terse goal often drops the "create" verb yet clearly means "build this app".
 */
export function isFromScratchBuild(repoRoot: string, goal: string): boolean {
  if (repoHasManifest(repoRoot)) return false;
  if (CREATE_INTENT.test(goal) && APP_NOUN.test(goal)) return true;
  if (!QUESTION_LEAD.test(goal) && !goal.includes("?") && !EDIT_INTENT.test(goal) && STACK_NOUN.test(goal) && APP_NOUN.test(goal)) return true;
  return false;
}

export interface ScaffoldFile { path: string; purpose: string; }

/** Validate + normalize a model-proposed path: a safe relative FILE path, never absolute/traversal/dir. */
function normalizeScaffoldPath(value: unknown): string {
  if (typeof value !== "string") return "";
  const path = value.trim().replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!path || path.startsWith("/") || path.includes("..") || path.endsWith("/") || /[<>|:*?"]/.test(path)) return "";
  return path;
}

/**
 * The MODEL proposes the ordered file list for a from-scratch build (manifest first). No per-framework
 * template lives in Cheater - the model uses its own knowledge of the stack the goal names. `planFn`
 * is injected (a bounded main-model completion in prod, a stub in tests). Returns [] on any failure or
 * off-shape output so the caller falls back to a single broad-scope scaffold commitlet. Cheater only
 * validates the SHAPE (real relative paths, a manifest is present, sane count) - never the contents.
 */
export async function proposeScaffoldFiles(goal: string, planFn: (prompt: string) => Promise<string>, maxFiles = 24): Promise<ScaffoldFile[]> {
  const prompt = [
    'Plan a NEW project from scratch. Output ONLY this JSON: {"files":[{"path":"rel/path","purpose":"one line"}]}',
    "Rules: the dependency/manifest file (package.json / pyproject.toml / Cargo.toml / go.mod / ... whichever fits the stack) MUST be first.",
    "Then config/build files, then the entry point, then the feature files, then one test or validation file.",
    `Use REAL relative paths for the stack the goal implies. Do NOT include file contents. At most ${maxFiles} files.`,
    "",
    `Goal: ${(goal ?? "").slice(0, 1500)}`
  ].join("\n");
  let text = "";
  try { text = await planFn(prompt); } catch { return []; }
  const obj = extractJsonObject(text, 12000);
  const raw = Array.isArray((obj as { files?: unknown })?.files) ? ((obj as { files: unknown[] }).files) : [];
  const seen = new Set<string>();
  const files: ScaffoldFile[] = [];
  for (const entry of raw) {
    const path = normalizeScaffoldPath((entry as { path?: unknown })?.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const purpose = typeof (entry as { purpose?: unknown })?.purpose === "string" ? (entry as { purpose: string }).purpose : "";
    files.push({ path, purpose: purpose.replace(/\s+/g, " ").trim().slice(0, 160) });
    if (files.length >= maxFiles) break;
  }
  // A valid scaffold MUST include a manifest; otherwise the caller degrades to a single broad commitlet.
  if (!files.some((file) => isManifestPath(file.path))) return [];
  // Manifest(s) first (so install works before later files verify); keep the model's order otherwise.
  return [...files.filter((file) => isManifestPath(file.path)), ...files.filter((file) => !isManifestPath(file.path))];
}
