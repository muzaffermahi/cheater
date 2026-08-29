import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AgentDefinition {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  model: "main" | "sidecar" | string;
  temperature?: number;
  steps?: number;
  permission?: {
    edit?: "allow" | "ask" | "deny";
    bash?: "allow" | "ask" | "deny";
    task?: "allow" | "ask" | "deny";
    /** Web tool access. Unset defaults by mode: subagents deny (bounded workers stay bounded),
     *  primary agents allow (still gated by settings.webAccess + the effort profile). */
    web?: "allow" | "ask" | "deny";
  };
  allowSpawn?: boolean;
  hidden?: boolean;
  systemPrompt: string;
  source: "built-in" | "user" | "project";
}

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: "explore",
    description: "Read-only codebase exploration; finds files, symbols, call sites",
    mode: "subagent",
    model: "sidecar",
    temperature: 0.1,
    steps: 8,
    permission: { edit: "deny", bash: "ask", task: "deny" },
    allowSpawn: false,
    hidden: false,
    source: "built-in",
    systemPrompt: "You are Kitten's explore agent. Answer with exact file:line references. You have read-only access to the codebase. Find files, symbols, and call sites. Do not modify any files.",
  },
  {
    name: "review",
    description: "Advisory diff reviewer",
    mode: "subagent",
    model: "sidecar",
    temperature: 0.2,
    steps: 4,
    permission: { edit: "deny", bash: "deny", task: "deny" },
    allowSpawn: false,
    hidden: false,
    source: "built-in",
    systemPrompt: "You are Kitten's review agent. Review diffs for correctness, style issues, and potential bugs. Provide concise feedback.",
  },
  {
    name: "verify",
    description: "Runs the project's tests/build and reports execution evidence",
    mode: "subagent",
    model: "sidecar",
    temperature: 0.0,
    steps: 6,
    permission: { edit: "deny", bash: "allow", task: "deny" },
    allowSpawn: false,
    hidden: false,
    source: "built-in",
    systemPrompt: "You are Kitten's verify agent. Run the project's tests and build commands. Report execution evidence only — not what you think, but what actually happened.",
  },
  {
    name: "architect",
    description: "Maps boundaries and proposes a smallest-safe implementation plan",
    mode: "subagent",
    model: "sidecar",
    temperature: 0.1,
    steps: 8,
    permission: { edit: "deny", bash: "deny", task: "deny" },
    allowSpawn: false,
    hidden: false,
    source: "built-in",
    systemPrompt: "You are Kitten's architect agent. Read the repository and return a bounded implementation plan: exact files and symbols, data-flow boundaries, invariants, risks, and the narrowest verification commands. Do not edit files or invent APIs you did not find.",
  },
  {
    name: "security",
    description: "Audits trust boundaries, secrets, permissions, and dependency risk",
    mode: "subagent",
    model: "sidecar",
    temperature: 0.0,
    steps: 8,
    permission: { edit: "deny", bash: "deny", task: "deny" },
    allowSpawn: false,
    hidden: false,
    source: "built-in",
    systemPrompt: "You are Kitten's security agent. Perform a read-only audit of trust boundaries, input validation, authentication/authorization, secret handling, unsafe commands, and dependency exposure. Cite exact file:line evidence, distinguish confirmed findings from hypotheses, and do not edit files.",
  },
  {
    name: "debug",
    description: "Reproduces failures and narrows the fault domain with evidence",
    mode: "subagent",
    model: "sidecar",
    temperature: 0.0,
    steps: 10,
    permission: { edit: "deny", bash: "allow", task: "deny" },
    allowSpawn: false,
    hidden: false,
    source: "built-in",
    systemPrompt: "You are Kitten's debug agent. Read the relevant code, reproduce the reported failure with the narrowest safe local command, capture the actual output, and narrow the fault domain. Do not modify files; report a deterministic next step.",
  },
  {
    name: "test",
    description: "Finds coverage gaps and runs focused, non-mutating verification",
    mode: "subagent",
    model: "sidecar",
    temperature: 0.0,
    steps: 8,
    permission: { edit: "deny", bash: "allow", task: "deny" },
    allowSpawn: false,
    hidden: false,
    source: "built-in",
    systemPrompt: "You are Kitten's test agent. Inspect existing test conventions, identify the smallest missing cases for the task, and run focused non-mutating tests or type checks. Report commands, exit status, and output evidence; never edit files.",
  },
  {
    name: "release",
    description: "Checks release readiness, packaging, migrations, and operational risk",
    mode: "subagent",
    model: "sidecar",
    temperature: 0.0,
    steps: 8,
    permission: { edit: "deny", bash: "allow", task: "deny" },
    allowSpawn: false,
    hidden: false,
    source: "built-in",
    systemPrompt: "You are Kitten's release agent. Audit the diff and release metadata for packaging, migrations, compatibility, versioning, rollback, and verification gaps. Run only safe local checks. Return a go/no-go checklist with exact evidence and do not edit files.",
  },
  {
    name: "docs",
    description: "Audits documentation, examples, API contracts, and user-facing clarity",
    mode: "subagent",
    model: "sidecar",
    temperature: 0.1,
    steps: 8,
    permission: { edit: "deny", bash: "deny", task: "deny" },
    allowSpawn: false,
    hidden: false,
    source: "built-in",
    systemPrompt: "You are Kitten's documentation agent. Read the repository's existing documentation conventions and inspect the requested surface for missing, stale, or misleading guidance, examples, API contracts, and migration notes. Cite exact files and propose bounded edits, but never modify files.",
  },
  {
    name: "performance",
    description: "Finds latency, memory, throughput, and local-inference bottlenecks",
    mode: "subagent",
    model: "sidecar",
    temperature: 0.0,
    steps: 8,
    permission: { edit: "deny", bash: "allow", task: "deny" },
    allowSpawn: false,
    hidden: false,
    source: "built-in",
    systemPrompt: "You are Kitten's performance agent. Inspect the relevant code and local runtime configuration for latency, memory, throughput, context, and concurrency risks. Run only bounded non-mutating measurements available in the repository, report numbers and methodology, and do not edit files.",
  },
  {
    name: "general",
    description: "Full tools, narrowed by session policy",
    mode: "all",
    model: "main",
    steps: 20,
    permission: { edit: "ask", bash: "ask", task: "ask" },
    allowSpawn: true,
    hidden: false,
    source: "built-in",
    systemPrompt: "You are Kitten, a precise coding assistant. Help the user with their task.",
  },
  {
    name: "title",
    description: "Session naming (hidden system agent)",
    mode: "subagent",
    model: "sidecar",
    temperature: 0.0,
    steps: 1,
    permission: { edit: "deny", bash: "deny", task: "deny" },
    allowSpawn: false,
    hidden: true,
    source: "built-in",
    systemPrompt: "Generate a short title (max 6 words) for this coding conversation based on the first user message.",
  },
  {
    name: "compact",
    description: "Context compaction (hidden system agent)",
    mode: "subagent",
    model: "sidecar",
    temperature: 0.0,
    steps: 1,
    permission: { edit: "deny", bash: "deny", task: "deny" },
    allowSpawn: false,
    hidden: true,
    source: "built-in",
    systemPrompt: "Summarize the given conversation turns into a concise digest, preserving key decisions, file changes, and verification results.",
  },
];

export function getAgent(name: string, projectRoot = process.cwd()): AgentDefinition | undefined {
  return listAgents(true, projectRoot).find((a) => a.name === name);
}

export function listAgents(includeHidden = false, projectRoot = process.cwd()): AgentDefinition[] {
  // Project agents override user agents, which override built-ins, while preserving a stable
  // built-in-first ordering for the native agent library and task planner.
  const byName = new Map<string, AgentDefinition>();
  for (const agent of [...BUILTIN_AGENTS, ...loadUserAgents(projectRoot)]) byName.set(agent.name, agent);
  const agents = [...byName.values()];
  return includeHidden ? agents : agents.filter((a) => !a.hidden);
}

function parseAgentFrontmatter(filePath: string, source: "user" | "project"): AgentDefinition | null {
  try {
    const text = readFileSync(filePath, "utf-8");
    const match = text.match(/^---\s*\n([\s\S]*?)\n---\n?/);
    if (!match) return null;
    const raw: Record<string, unknown> = {};
    for (const line of match[1].split("\n")) {
      const sep = line.indexOf(":");
      if (sep === -1) continue;
      const key = line.slice(0, sep).trim();
      const val = line.slice(sep + 1).trim();
      if (!key) continue;
      raw[key] = val;
    }
    const name = String(raw.name ?? "");
    if (!name) return null;
    const mode = raw.mode as string;
    if (mode !== "primary" && mode !== "subagent" && mode !== "all") return null;
    const model = String(raw.model ?? "main");
    const permissionRaw = raw.permission as string | undefined;
    let permission: AgentDefinition["permission"] = {};
    if (permissionRaw) {
      for (const part of permissionRaw.split(",")) {
        const [k, v] = part.split("=").map((s) => s.trim());
        if (k === "edit" || k === "bash" || k === "task") {
          if (v === "allow" || v === "ask" || v === "deny") {
            permission[k] = v;
          }
        }
      }
    }
    return {
      name,
      description: String(raw.description ?? ""),
      mode: mode as "primary" | "subagent" | "all",
      model,
      temperature: raw.temperature !== undefined ? Number(raw.temperature) : undefined,
      steps: raw.steps !== undefined ? Number(raw.steps) : undefined,
      permission: Object.keys(permission).length ? permission : undefined,
      allowSpawn: raw.allowSpawn === "true",
      hidden: raw.hidden === "true",
      systemPrompt: text.slice((match.index ?? 0) + match[0].length).trim(),
      source,
    };
  } catch {
    console.warn(`[agents] skipping unparseable agent file: ${filePath}`);
    return null;
  }
}

export function loadUserAgents(projectRoot = process.cwd()): AgentDefinition[] {
  const results: AgentDefinition[] = [];
  const dirs = [
    { path: join(homedir(), ".kitten", "agents"), source: "user" as const },
    { path: join(projectRoot, ".kitten", "agents"), source: "project" as const },
  ];
  for (const { path, source } of dirs) {
    if (!existsSync(path)) continue;
    try {
      const files = readdirSync(path).filter((f) => f.endsWith(".md"));
      for (const f of files) {
        const agent = parseAgentFrontmatter(join(path, f), source);
        if (agent) results.push(agent);
      }
    } catch {
      console.warn(`[agents] could not read directory: ${path}`);
    }
  }
  return results;
}
