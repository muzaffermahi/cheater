// Who owns the repo Cheater is working in? Cheater was built to improve ITSELF (a Pi extension), and
// several planning defaults leaked Cheater-dev assumptions ("Cheater remains a Pi wrapper", the
// filenames src/commands.ts/config.ts) into EVERY plan - which made a "build a web app" goal produce a
// Pi command module. These helpers scope those assumptions to Cheater's own repo, so a user's project
// gets project-generic guidance instead.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** True only when the target repo IS the cheater-pi package itself. */
export function isCheaterOwnRepo(repoRoot: string | undefined): boolean {
  if (!repoRoot) return false;
  try {
    const pkgPath = join(repoRoot, "package.json");
    if (!existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
    return pkg?.name === "@cheater/cheater-pi";
  } catch {
    return false;
  }
}

/**
 * Global plan constraints for a repo. Cheater-dev constraints (Pi wrapper, Pi owns the loop) apply ONLY
 * to Cheater's own repo; any other project gets stack-agnostic guidance so the model builds THAT
 * project's app, not a Pi extension.
 */
export function globalConstraintsFor(repoRoot: string | undefined): string[] {
  if (isCheaterOwnRepo(repoRoot)) {
    return [
      "Cheater remains a Pi wrapper/distribution.",
      "Pi owns TUI, shell, file reading, editing, sessions, and base agent loop.",
      "Each file-change commitlet runs in a fresh worker session.",
      "Rollback is required before editing."
    ];
  }
  return [
    "Match this project's own stack, conventions, and directory structure.",
    "Keep each change scoped to its file; do not add unrelated code or dependencies.",
    "Rollback is required before editing an existing file."
  ];
}
