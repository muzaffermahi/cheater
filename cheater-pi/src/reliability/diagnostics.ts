import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";

export interface SyntaxDiagnostic {
  ok: boolean;
  message: string;
}

// Fast, per-file syntax checks only. SWE-agent found rejecting malformed edits before
// accepting them was one of the largest single wins; small models introduce syntax errors
// constantly but fix them near-perfectly when told immediately, in-band, on the edit result.
// Deliberately cheap: no repo-wide tsc (which would block the extension host on every edit).
export function checkFileSyntax(cwd: string, relPath: string): SyntaxDiagnostic | null {
  const abs = isAbsolute(relPath) ? relPath : join(cwd, relPath);
  const ext = extname(relPath).toLowerCase();
  try {
    if (ext === ".json") {
      JSON.parse(readFileSync(abs, "utf8"));
      return { ok: true, message: "" };
    }
    if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
      const r = spawnSync(process.execPath, ["--check", abs], { encoding: "utf8", timeout: 8000, windowsHide: true });
      return r.status === 0 ? { ok: true, message: "" } : { ok: false, message: firstLines(r.stderr || r.stdout, 6) };
    }
    if (ext === ".py") {
      const py = process.platform === "win32" ? "python" : "python3";
      const src = `import py_compile,sys\ntry:\n py_compile.compile(${JSON.stringify(abs)}, doraise=True)\nexcept Exception as e:\n sys.stderr.write(str(e)); sys.exit(1)`;
      const r = spawnSync(py, ["-c", src], { encoding: "utf8", timeout: 8000, windowsHide: true });
      if (r.error) return null; // python not available - do not block
      return r.status === 0 ? { ok: true, message: "" } : { ok: false, message: firstLines(r.stderr || r.stdout, 6) };
    }
    // .ts/.tsx and others: skipped here (a full type-check is too slow for a per-edit hook;
    // the commitlet's focused verification covers them).
    return null;
  } catch (err) {
    return { ok: false, message: (err as Error).message.slice(0, 300) };
  }
}

function firstLines(text: string, n: number): string {
  return (text ?? "").split(/\r?\n/).filter(Boolean).slice(0, n).join("\n").slice(0, 500);
}
