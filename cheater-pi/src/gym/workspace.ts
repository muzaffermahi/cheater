import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { GymGeneratedTask, GymTask } from "./types.js";

export interface WorkspaceOptions {
  rootDir: string;
  tempRoot?: string;
  keep?: boolean;
}

export interface WorkspaceResult {
  path: string;
  taskId: string;
  createdAt: string;
  source: "fixture" | "generated";
  cleanup: () => void;
}

export function createWorkspace(task: GymTask, options: WorkspaceOptions): WorkspaceResult {
  const tempRoot = options.tempRoot ?? join(options.rootDir, ".cheater", "gym", "runs");
  const baseParent = tempRoot === ":tmp:" ? tmpdir() : tempRoot;
  if (tempRoot !== ":tmp:" && !existsSync(tempRoot)) {
    mkdirSync(tempRoot, { recursive: true });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const workspace = mkdtempSync(join(baseParent, `gym-${task.id}-${stamp}-`));
  const createdAt = new Date().toISOString();

  if (task.runMode === "fixture") {
    const source = join(options.rootDir, ".cheater", "gym", "tasks", task.id, task.fixturePath ?? "repo");
    if (!existsSync(source)) {
      rmSync(workspace, { recursive: true, force: true });
      throw new Error(`fixture repo not found for ${task.id}: ${source}`);
    }
    cpSync(source, workspace, { recursive: true });
  } else {
    const generated = task.generated as GymGeneratedTask | undefined;
    if (!generated) {
      rmSync(workspace, { recursive: true, force: true });
      throw new Error(`generated block missing for ${task.id}`);
    }
    for (const [rel, content] of Object.entries(generated.files)) {
      const dest = join(workspace, rel);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, content, "utf8");
    }
    if (generated.setupCommand) {
      // Setup commands are recorded for later execution by the runner, not run here.
      writeFileSync(join(workspace, ".cheater-gym-setup.sh"), generated.setupCommand + "\n", "utf8");
    }
  }

  return {
    path: workspace,
    taskId: task.id,
    createdAt,
    source: task.runMode === "fixture" ? "fixture" : "generated",
    cleanup: () => {
      if (!options.keep) {
        try { rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  };
}

export function listFilePaths(workspace: string): string[] {
  const out: string[] = [];
  const stack: string[] = [workspace];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

export function pathInsideWorkspace(workspace: string, file: string): string {
  if (file.startsWith(workspace)) return file;
  if (file.startsWith(sep) || /^[a-zA-Z]:[\\/]/.test(file)) {
    return file;
  }
  return join(workspace, file);
}

export function normalizeRelativePath(workspace: string, file: string): string {
  const inside = pathInsideWorkspace(workspace, file);
  if (inside.startsWith(workspace)) {
    const rel = inside.slice(workspace.length);
    return rel.replace(/^[\\/]/, "").split(sep).join("/");
  }
  return file.split(sep).join("/");
}

export function readWorkspaceFile(workspace: string, relPath: string): string | undefined {
  const full = join(workspace, relPath);
  if (!existsSync(full)) return undefined;
  try {
    return readFileSync(full, "utf8");
  } catch {
    return undefined;
  }
}
