// Turning a shell failure into something the model can act on.
//
// Terminal-Bench 2 published a failure taxonomy over ~3,800 errors, and the single largest bucket —
// about a quarter of everything that goes wrong — is "command not found / missing executable". It is
// also strongly size-dependent: a small model reaches for a binary that isn't installed far more
// often than a large one (26.7% for GPT-OSS-120B against 9.2% for Grok 4). Kitten's own recorded
// frictions say the same thing one level down: a worker hallucinated `/app/tls` when the directory
// was `/app/ssl`, then spent its remaining turns arguing with the consequences.
//
// The fix is NOT to pre-check and refuse. A pre-flight existence check has false positives that cost
// real work — `make` installed by the line before it, a binary built into a container during the
// task, a shell function — and the command it would have blocked already fails in milliseconds with
// exit 127. There is nothing to save. What is missing is the SECOND half of the message: *what does
// exist*. `docker: command not found` tells the model nothing it can act on. `docker: not found —
// available and similar: podman, docker-compose` ends the guessing in one turn.
//
// So: run the command, and when it fails for a name, say what the nearby names are. Zero false
// positives by construction — this only ever appends to an error the shell already produced.

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, basename, isAbsolute, join, resolve } from "node:path";

/** How many candidate names a hint may list. More than a few is noise the model will skim past. */
const MAX_SUGGESTIONS = 5;
/** Names further than this (edit distance) are not near-misses, they are different words. */
const MAX_DISTANCE = 2;
/** A directory listing beyond this is not scanned — a hint must never become the expensive part. */
const MAX_SCAN_ENTRIES = 4000;

/** Levenshtein distance, bounded: returns `max + 1` as soon as it is certain the answer exceeds it. */
export function editDistance(a: string, b: string, max = MAX_DISTANCE): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/** Rank candidates by how plausibly they are what `name` meant. Prefix/substring hits count too:
 *  `docker-compose` is nowhere near `docker` by edit distance but is exactly what was meant. */
export function nearestNames(name: string, candidates: Iterable<string>): string[] {
  const target = name.toLowerCase();
  const scored: Array<{ value: string; score: number }> = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const value = raw.trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    const lower = value.toLowerCase();
    if (lower === target) continue; // it exists under this exact name; not a suggestion
    let score: number;
    if (lower.startsWith(target) || target.startsWith(lower)) score = 0.5;
    else if (lower.includes(target)) score = 1.5;
    else {
      const d = editDistance(target, lower);
      if (d > MAX_DISTANCE) continue;
      score = d;
    }
    scored.push({ value, score });
  }
  scored.sort((a, b) => a.score - b.score || a.value.length - b.value.length || a.value.localeCompare(b.value, "en"));
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.value);
}

/** Every executable name on PATH. Bounded and failure-tolerant: an unreadable entry is skipped. */
export function executablesOnPath(env: NodeJS.ProcessEnv = process.env): string[] {
  const sep = process.platform === "win32" ? ";" : ":";
  // Honour an explicitly supplied PATHEXT even when the caller is exercising a
  // Windows environment from another host (for example, in cross-platform CI).
  const pathExt = env.PATHEXT ?? (process.platform === "win32" ? ".COM;.EXE;.BAT;.CMD" : "");
  const exts = pathExt ? pathExt.split(";").map((e) => e.toLowerCase()).filter(Boolean) : [];
  const names: string[] = [];
  let scanned = 0;
  for (const dir of (env.PATH ?? "").split(sep)) {
    const d = dir.trim();
    if (!d) continue;
    let entries: string[];
    try { entries = readdirSync(d); } catch { continue; }
    for (const entry of entries) {
      if (++scanned > MAX_SCAN_ENTRIES) return names;
      if (exts.length) {
        const lower = entry.toLowerCase();
        const ext = exts.find((e) => lower.endsWith(e));
        names.push(ext ? entry.slice(0, entry.length - ext.length) : entry);
      } else {
        names.push(entry);
      }
    }
  }
  return names;
}

/** The executable name a "command not found" message is complaining about, or null. */
export function missingCommandName(output: string): string | null {
  // POSIX shells: `bash: line 1: foo: command not found` / `sh: 1: foo: not found`
  const posix = /(?:^|\n)[^\n]*?:\s*(?:line \d+:\s*)?([A-Za-z0-9_.+-]+):\s*(?:command\s+)?not found/i.exec(output);
  if (posix) return posix[1];
  // cmd.exe / PowerShell: `'foo' is not recognized as an internal or external command`
  const win = /['"]?([A-Za-z0-9_.+-]+)['"]?\s+is not recognized as (?:an internal|the name)/i.exec(output);
  if (win) return win[1];
  return null;
}

/** The path a "No such file or directory" message is complaining about, or null. */
export function missingPathName(output: string): string | null {
  const m = /(?:^|\n)[^\n]*?(?:cannot (?:access|open|stat|find)|No such file or directory)[^\n]*/i.exec(output);
  if (!m) return null;
  // The path is normally the quoted or colon-delimited token on that line.
  const line = m[0];
  const quoted = /['"`]([^'"`\n]{2,200})['"`]/.exec(line);
  if (quoted) return quoted[1];
  const bare = /([~./][^\s:'"]{1,200})/.exec(line);
  return bare ? bare[1] : null;
}

/** Sibling entries of a path that do not exist — i.e. what the author might have meant instead. */
function siblingsOf(path: string, cwd: string): { dir: string; entries: string[] } | null {
  const abs = isAbsolute(path) ? path : resolve(cwd, path.replace(/^~[\\/]/, ""));
  let dir = dirname(abs);
  // Walk up to the first directory that actually exists — if `/app/tls/certs/x.pem` was wrong at the
  // `tls` level, listing `/app` is what shows `ssl`.
  for (let i = 0; i < 4; i++) {
    if (existsSync(dir)) break;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  try {
    if (!statSync(dir).isDirectory()) return null;
    return { dir, entries: readdirSync(dir).slice(0, 200) };
  } catch { return null; }
}

/**
 * A hint to append to a failed shell command, or null when there is nothing useful to add.
 *
 * `cwd` is the project root; `env` is injectable so the PATH scan is testable without touching the
 * machine's real one.
 */
export function shellFailureHint(output: string, cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const missingCommand = missingCommandName(output);
  if (missingCommand) {
    const near = nearestNames(missingCommand, executablesOnPath(env));
    return near.length
      ? `hint: \`${missingCommand}\` is not installed here. Similar commands that ARE available: ${near.join(", ")}. Use one of those, or install it first — do not retry \`${missingCommand}\`.`
      : `hint: \`${missingCommand}\` is not installed here and nothing similar is on PATH. Install it, or solve the task with what the environment already has — do not retry \`${missingCommand}\`.`;
  }

  const missingPath = missingPathName(output);
  if (missingPath) {
    const siblings = siblingsOf(missingPath, cwd);
    if (!siblings) return null;
    const near = nearestNames(basename(missingPath), siblings.entries);
    if (near.length) {
      const shown = near.map((n) => join(siblings.dir, n).replace(/\\/g, "/"));
      return `hint: \`${missingPath}\` does not exist. Nearby in ${siblings.dir.replace(/\\/g, "/")}: ${shown.join(", ")}. Check the real name before retrying.`;
    }
    // No near-miss: listing what IS there still beats guessing again.
    const listing = siblings.entries.slice(0, MAX_SUGGESTIONS).join(", ");
    return listing
      ? `hint: \`${missingPath}\` does not exist. ${siblings.dir.replace(/\\/g, "/")} contains: ${listing}${siblings.entries.length > MAX_SUGGESTIONS ? ", …" : ""}. List the directory before assuming a path.`
      : null;
  }

  return null;
}

// ── Interactive stalls ──────────────────────────────────────────────────────────────────────────
// The bash tool closes stdin, so a program that reads standard input hits EOF and exits at once.
// That is not universal: some tools reopen the controlling terminal (`ssh`, `sudo`, `apt` without a
// noninteractive frontend, `git` asking for credentials), and those sit there until the timeout with
// their prompt as the last thing they printed. A timeout that says only "timed out after 120s" makes
// this look like slowness. Naming it turns two more wasted minutes into one corrected flag.

const PROMPT_TAIL = [
  { re: /\[y\/n\]\s*$|\(y\/n\)\s*$|\[Y\/n\]\s*$|\[y\/N\]\s*$/i, hint: "it is waiting for a yes/no answer — pass the tool's non-interactive flag (e.g. `-y`, `--yes`, `--force`)" },
  { re: /pass(?:word|phrase)[^\n]{0,40}:\s*$/i, hint: "it is waiting for a password — use a key, a token in the environment, or a non-interactive auth flag" },
  { re: /(?:username|login)[^\n]{0,20}:\s*$/i, hint: "it is waiting for a username — supply credentials non-interactively" },
  { re: /\(END\)\s*$|^:\s*$|--More--\s*$/m, hint: "output is in a pager — add `| cat` or set PAGER=cat" },
  { re: /press\s+(?:any\s+key|enter|return)[^\n]{0,30}$/i, hint: "it is waiting for a keypress — run it non-interactively" },
  { re: /continue\?\s*$|proceed\?\s*$|are you sure[^\n]{0,20}$/i, hint: "it is waiting for a confirmation — pass the tool's assume-yes flag" },
];

/**
 * Whether a timed-out command was actually blocked on a prompt, and what to do about it. Reads only
 * the tail: a prompt is by definition the last thing written before the silence.
 */
export function interactiveStallHint(output: string): string | null {
  const tail = output.slice(-400).replace(/\s+$/, (m) => (m.includes("\n") ? "\n" : " "));
  for (const { re, hint } of PROMPT_TAIL) {
    if (re.test(tail)) return `hint: this did not hang because it was slow — ${hint}. Standard input is closed for tool commands, so an interactive prompt can never be answered.`;
  }
  return null;
}
