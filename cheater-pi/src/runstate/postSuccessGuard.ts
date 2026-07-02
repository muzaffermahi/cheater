// Post-success guard: once evaluator-like success exists, protect what produced it.
//
// The saddest failure mode in agent benchmarks is self-sabotage AFTER success: the model
// passes verification, then "cleans up" by deleting the output file, re-runs a generator
// that overwrites the good artifact, or git-resets the working tree. Once a validation
// passes, the artifacts and files it depended on become protected: destructive or
// regenerating commands over them are blocked, and direct mutations are warned. The guard is
// not stupid - a later FAILING validation over a protected path releases it for a targeted
// repair. But the default, once acceptable output exists, is: preserve it.

import { readRunFile, writeRunFile } from "./runDir.js";

export interface ProtectedArtifact {
  path: string;
  reason: string;
  protectedAt: string;
}

export interface GuardVerdict {
  verdict: "allow" | "warn" | "block";
  message?: string;
  matchedPaths?: string[];
}

const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; label: string; broad: boolean }> = [
  { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, label: "rm -rf", broad: true },
  { re: /\brm\s+/, label: "rm", broad: false },
  { re: /\bRemove-Item\b.*-Recurse/i, label: "Remove-Item -Recurse", broad: true },
  { re: /\bRemove-Item\b/i, label: "Remove-Item", broad: false },
  { re: /\bdel\s+\/[sq]/i, label: "del /s", broad: true },
  { re: /\bgit\s+reset\s+--hard\b/, label: "git reset --hard", broad: true },
  { re: /\bgit\s+checkout\s+(?:--|[\w./-]+\s+--)\s/, label: "git checkout --", broad: false },
  { re: /\bgit\s+clean\b.*-[dfx]/, label: "git clean", broad: true },
  { re: /\bgit\s+stash\b(?!\s+(list|show))/, label: "git stash", broad: true },
  { re: /\brmdir\b/i, label: "rmdir", broad: false },
  { re: /\btruncate\b/, label: "truncate", broad: false }
];

const REGENERATE_RE = /\b(regenerate|generate|rebuild|re-?create|overwrite|init(?:ialize)?)\b/i;
const BROAD_FORMAT_RE = /\b(?:prettier\s+(?:--write|-w)|black\s+\.|gofmt\s+-w|cargo\s+fmt|eslint\s+.*--fix)\b/i;

function normalizePath(path: string): string {
  return (path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

export class PostSuccessGuard {
  private artifacts = new Map<string, ProtectedArtifact>();
  /** Paths released for a targeted repair because a later validation over them failed. */
  private repairable = new Set<string>();

  protect(paths: string[], reason: string): ProtectedArtifact[] {
    const added: ProtectedArtifact[] = [];
    for (const raw of paths) {
      const path = normalizePath(raw);
      if (!path || this.artifacts.has(path)) continue;
      const artifact: ProtectedArtifact = { path, reason: reason.slice(0, 160), protectedAt: new Date().toISOString() };
      this.artifacts.set(path, artifact);
      this.repairable.delete(path);
      added.push(artifact);
    }
    return added;
  }

  isProtected(path: string): boolean {
    const target = normalizePath(path);
    if (this.artifacts.has(target)) return true;
    // Directory protection covers everything under it.
    for (const key of this.artifacts.keys()) {
      if (target.startsWith(key.endsWith("/") ? key : key + "/")) return true;
    }
    return false;
  }

  list(): ProtectedArtifact[] {
    return [...this.artifacts.values()];
  }

  hasProtections(): boolean {
    return this.artifacts.size > 0;
  }

  /** A validation over these paths FAILED: allow targeted fixes until the next protect(). */
  releaseForRepair(paths: string[]): void {
    for (const raw of paths) {
      const path = normalizePath(raw);
      if (this.isProtected(path)) this.repairable.add(path);
    }
  }

  /** Judge a shell command before it runs. */
  assessCommand(command: string): GuardVerdict {
    const cmd = (command ?? "").trim();
    if (!cmd || !this.hasProtections()) return { verdict: "allow" };
    const protectedPaths = [...this.artifacts.keys()];
    const mentioned = protectedPaths.filter((p) => cmd.replace(/\\/g, "/").includes(p) || cmd.includes(p.split("/").pop() ?? p));

    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (!pattern.re.test(cmd)) continue;
      // Broad destructive commands endanger every protected artifact even without naming one.
      const endangered = pattern.broad ? protectedPaths : mentioned;
      const repairSanctioned = endangered.length > 0 && endangered.every((p) => this.repairable.has(p));
      if (endangered.length && !repairSanctioned) {
        return {
          verdict: "block",
          matchedPaths: endangered.slice(0, 5),
          message: `Blocked: "${pattern.label}" would touch protected artifact(s) ${endangered.slice(0, 3).join(", ")}. Evaluator-like success was observed; do not mutate them unless a failing validation requires it.`
        };
      }
    }
    if (mentioned.length && REGENERATE_RE.test(cmd) && !mentioned.every((p) => this.repairable.has(p))) {
      return {
        verdict: "block",
        matchedPaths: mentioned.slice(0, 5),
        message: `Blocked: regenerating over protected artifact(s) ${mentioned.slice(0, 3).join(", ")} would overwrite verified output. Re-run validation first if you believe it is wrong.`
      };
    }
    if (BROAD_FORMAT_RE.test(cmd)) {
      return {
        verdict: "warn",
        message: "Broad formatter over a tree containing protected artifacts - confirm it cannot rewrite verified files."
      };
    }
    return { verdict: "allow" };
  }

  /** Judge a direct file mutation (edit/write/delete) before it happens. */
  assessFileMutation(path: string): GuardVerdict {
    const target = normalizePath(path);
    if (!this.isProtected(target)) return { verdict: "allow" };
    if (this.repairable.has(target)) {
      return { verdict: "warn", message: `${target} is protected but released for repair after a failing validation. Keep the fix targeted.` };
    }
    return {
      verdict: "warn",
      message: `${target} is a protected artifact (a validation passed with it in place). Mutate it only if a failing validation requires it.`
    };
  }

  /** The compact standing warning for digests/capsules once protections exist. */
  warningLine(): string | null {
    if (!this.hasProtections()) return null;
    return `Evaluator-like success was observed. Protected artifacts exist (${this.artifacts.size}). Do not mutate them unless required by a failing validation.`;
  }

  save(runDir: string): void {
    try {
      writeRunFile(
        runDir,
        "guards/protected-artifacts.json",
        JSON.stringify({ artifacts: this.list(), repairable: [...this.repairable] }, null, 2) + "\n"
      );
    } catch {
      // best-effort
    }
  }

  static load(runDir: string): PostSuccessGuard {
    const guard = new PostSuccessGuard();
    const raw = readRunFile(runDir, "guards/protected-artifacts.json");
    if (!raw) return guard;
    try {
      const parsed = JSON.parse(raw) as { artifacts?: ProtectedArtifact[]; repairable?: string[] };
      for (const artifact of parsed.artifacts ?? []) {
        if (artifact?.path) guard.artifacts.set(normalizePath(artifact.path), artifact);
      }
      for (const path of parsed.repairable ?? []) guard.repairable.add(normalizePath(path));
    } catch {
      // corrupt file -> start unprotected rather than blocking everything
    }
    return guard;
  }
}
