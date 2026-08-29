// The second half of a shell failure message: what DOES exist.
//
// "command not found" is the largest single bucket in Terminal-Bench 2's failure taxonomy (~24% of
// ~3,800 errors) and it is worse for smaller models. On its own it is not actionable, so the model
// re-proposes something adjacent and burns the turn. These tests pin the enrichment.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  editDistance, nearestNames, executablesOnPath, missingCommandName, missingPathName,
  shellFailureHint, interactiveStallHint,
} from "../src/core/shellGuard.js";
import { bashTool } from "../src/core/tools.js";

// ── the pieces ──────────────────────────────────────────────────────────────────────────────────

test("editDistance is bounded and gives up early rather than scoring distant words", () => {
  assert.equal(editDistance("docker", "docker"), 0);
  assert.equal(editDistance("dockr", "docker"), 1);
  assert.equal(editDistance("pyton", "python"), 1);
  assert.ok(editDistance("docker", "kubernetes") > 2, "different words are not near-misses");
});

test("nearestNames prefers a prefix match over a raw edit-distance neighbour", () => {
  // `docker-compose` is 8 edits from `docker` and is exactly what was meant; `docket` is 1 edit and
  // is noise. Prefix beats distance.
  const near = nearestNames("docker", ["docker-compose", "docket", "podman", "kubectl"]);
  assert.equal(near[0], "docker-compose");
});

test("nearestNames never suggests the name that was asked for", () => {
  assert.deepEqual(nearestNames("make", ["make"]), []);
});

test("missingCommandName reads the shell's own phrasing, POSIX and Windows", () => {
  assert.equal(missingCommandName("bash: line 1: docker: command not found"), "docker");
  assert.equal(missingCommandName("sh: 1: pyton: not found"), "pyton");
  assert.equal(missingCommandName("'gitt' is not recognized as an internal or external command"), "gitt");
  assert.equal(missingCommandName("make: *** No rule to make target"), null, "an ordinary failure is not a missing command");
});

test("missingPathName extracts the path a failure is complaining about", () => {
  assert.equal(missingPathName("ls: cannot access '/app/tls': No such file or directory"), "/app/tls");
  assert.equal(missingPathName("cat: ./conf/settings.yml: No such file or directory"), "./conf/settings.yml");
  assert.equal(missingPathName("exit 1"), null);
});

test("executablesOnPath strips the Windows extension so names match what a model would type", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-path-"));
  writeFileSync(join(dir, "podman.exe"), "");
  writeFileSync(join(dir, "kubectl"), "");
  const names = executablesOnPath({ PATH: dir, PATHEXT: ".EXE;.CMD" } as NodeJS.ProcessEnv);
  assert.ok(names.includes("podman"), "podman.exe is offered as `podman`");
  assert.ok(names.includes("kubectl"));
});

// ── the hint ────────────────────────────────────────────────────────────────────────────────────

test("a missing command is answered with the similar commands that ARE installed", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-path-"));
  writeFileSync(join(dir, "podman"), "");
  writeFileSync(join(dir, "docker-compose"), "");
  const hint = shellFailureHint("bash: line 1: docker: command not found", dir, { PATH: dir } as NodeJS.ProcessEnv);
  assert.ok(hint, "a hint is produced");
  assert.match(hint!, /docker-compose/);
  assert.match(hint!, /do not retry `docker`/, "the model is told the retry is pointless, not just that it failed");
});

test("a missing command with nothing similar still ends the guessing", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitten-path-empty-"));
  const hint = shellFailureHint("bash: line 1: zzqqx: command not found", dir, { PATH: dir } as NodeJS.ProcessEnv);
  assert.match(hint!, /nothing similar is on PATH/);
});

test("a hallucinated directory is answered with its real sibling", () => {
  // Kitten's own recorded friction: a worker wrote /app/tls where the directory was /app/ssl.
  const root = mkdtempSync(join(tmpdir(), "kitten-app-"));
  mkdirSync(join(root, "ssl"));
  const hint = shellFailureHint(`ls: cannot access '${join(root, "tls").replace(/\\/g, "/")}': No such file or directory`, root, {} as NodeJS.ProcessEnv);
  assert.ok(hint, "a hint is produced");
  assert.match(hint!, /ssl/);
});

test("a missing path with no near-miss lists what the directory actually holds", () => {
  const root = mkdtempSync(join(tmpdir(), "kitten-app2-"));
  mkdirSync(join(root, "certificates"));
  const hint = shellFailureHint(`cat: '${join(root, "zzz.pem").replace(/\\/g, "/")}': No such file or directory`, root, {} as NodeJS.ProcessEnv);
  assert.match(hint!, /certificates/);
});

test("an ordinary failure gets no hint — the guard never invents advice", () => {
  const root = mkdtempSync(join(tmpdir(), "kitten-plain-"));
  assert.equal(shellFailureHint("AssertionError: expected 3 got 4\nexit 1", root, {} as NodeJS.ProcessEnv), null);
});

// ── interactive stalls ──────────────────────────────────────────────────────────────────────────

test("a timeout whose tail is a prompt is named as a prompt, not as slowness", () => {
  assert.match(interactiveStallHint("Installing…\nDo you want to continue? [Y/n] ")!, /yes\/no/);
  assert.match(interactiveStallHint("git: \nPassword for 'https://x@github.com': ")!, /password/i);
  assert.match(interactiveStallHint("line 1\nline 2\n(END)")!, /pager/);
  assert.equal(interactiveStallHint("compiling…\n[ 42%] Building CXX object"), null, "a genuinely slow build is not a prompt");
});

// ── end to end through the real tool ────────────────────────────────────────────────────────────

test("the bash tool appends the hint to a real command-not-found", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-bash-hint-"));
  const res = await bashTool.execute(
    { command: "kitten-definitely-not-a-real-binary-xyz --version" },
    { cwd, filesRead: new Set(), filesWritten: new Set() },
  );
  assert.equal(res.isError, true);
  assert.match(res.output, /hint: `kitten-definitely-not-a-real-binary-xyz`/, "the failure carries its own next step");
});

test("the bash tool leaves a successful command untouched", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kitten-bash-ok-"));
  const res = await bashTool.execute(
    { command: `node -e "console.log('fine')"` },
    { cwd, filesRead: new Set(), filesWritten: new Set() },
  );
  assert.equal(res.isError, false);
  assert.ok(!/hint:/.test(res.output), "no advice where nothing went wrong");
});

// chmod is a no-op on Windows; referenced so the import is not flagged unused on either platform.
void chmodSync;
