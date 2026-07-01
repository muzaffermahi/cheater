import type { AutopilotInput, RiskLevel, TaskKind } from "./types.js";

export interface AutopilotClassification {
  taskKind: TaskKind;
  confidence: number;
  needsRepro: boolean;
  risk: RiskLevel;
  reason: string;
  complexitySignals: string[];
}

interface Rule {
  kind: TaskKind;
  patterns: RegExp[];
  confidence: number;
  needsRepro: boolean;
  risk: RiskLevel;
  reason: string;
}

const RULES: Rule[] = [
  {
    kind: "explanation_only",
    patterns: [
      /^\s*(explain|describe|what does|how does|why does|walk me through|tell me about)\b/i,
      /^\s*(what is|what's|where is|where are|show me|summarize)\b/i
    ],
    confidence: 0.85,
    needsRepro: false,
    risk: "low",
    reason: "User asked for explanation or orientation, not code changes."
  },
  {
    kind: "test_failure",
    patterns: [/\b(test|tests|pytest|jest|mocha|vitest|node --test|ci)\b.*\b(fail|failing|failed|broken)\b/i, /\bFAILED\b|AssertionError|expected .* received|TS\d{4}/i],
    confidence: 0.85,
    needsRepro: true,
    risk: "medium",
    reason: "Request contains a failing test or CI signal."
  },
  {
    kind: "bug_fix",
    patterns: [/\b(fix|debug|repair|broken|bug|crash|exception|traceback|stack trace|wrong|incorrect|not working)\b/i],
    confidence: 0.78,
    needsRepro: true,
    risk: "medium",
    reason: "Request asks to correct broken behavior."
  },
  {
    kind: "refactor",
    patterns: [/\b(refactor|restructure|reorganize|deduplicate|extract|rename|simplify|clean up|cleanup|architecture)\b/i],
    confidence: 0.82,
    needsRepro: false,
    risk: "medium",
    reason: "Request is a refactor or architecture change."
  },
  {
    kind: "migration",
    patterns: [/\b(migrate|migration|schema|upgrade|port from|convert from|move .* to)\b/i],
    confidence: 0.82,
    needsRepro: false,
    risk: "high",
    reason: "Request looks like a migration or broad compatibility change."
  },
  {
    kind: "tooling",
    patterns: [/\b(cli|command|slash command|tool|tooling|doctor|launcher|config|extension|registry)\b/i],
    confidence: 0.78,
    needsRepro: false,
    risk: "medium",
    reason: "Request touches command, tool, launcher, extension, or config behavior."
  },
  {
    kind: "docs",
    patterns: [/\b(doc|docs|documentation|readme|guide)\b/i],
    confidence: 0.72,
    needsRepro: false,
    risk: "low",
    reason: "Request primarily mentions documentation."
  },
  {
    kind: "benchmark",
    patterns: [/\b(benchmark|bench|perf|performance|profile|speed)\b/i],
    confidence: 0.72,
    needsRepro: false,
    risk: "medium",
    reason: "Request mentions benchmark or performance work."
  },
  {
    kind: "feature_addition",
    patterns: [/\b(add|implement|create|build|introduce|support|enable|new)\b/i],
    confidence: 0.74,
    needsRepro: false,
    risk: "medium",
    reason: "Request asks for new behavior."
  },
  {
    kind: "tiny_edit",
    patterns: [/\b(typo|copy tweak|rename label|change text|one[- ]line|small wording|comment)\b/i],
    confidence: 0.76,
    needsRepro: false,
    risk: "low",
    reason: "Request appears to be a very small edit."
  }
];

export function classifyAutopilotTask(input: AutopilotInput): AutopilotClassification {
  const text = `${input.message}\n${input.recentErrors ?? ""}`;
  const lower = text.toLowerCase();
  const complexitySignals = detectComplexitySignals(text, input.repoHints?.likelyFiles ?? []);
  if (/\b(typo|copy tweak|rename label|change text|one[- ]line|small wording|comment)\b/i.test(text) && !/\b(failing|failed|crash|exception|traceback|stack trace)\b/i.test(text)) {
    return {
      taskKind: "tiny_edit",
      confidence: 0.82,
      needsRepro: false,
      risk: complexitySignals.length >= 2 ? "medium" : "low",
      reason: "Request appears to be a very small edit.",
      complexitySignals
    };
  }
  let best: Rule | undefined;
  let score = 0;

  for (const rule of RULES) {
    const matches = rule.patterns.filter((pattern) => pattern.test(text)).length;
    if (matches > 0) {
      const nextScore = matches * rule.confidence;
      if (!best || nextScore > score) {
        best = rule;
        score = nextScore;
      }
    }
  }

  if (!best) {
    const codeIntent = /\b(change|update|modify|make|remove|delete|wire|register)\b/i.test(text);
    return {
      taskKind: codeIntent ? "feature_addition" : "unknown",
      confidence: codeIntent ? 0.48 : 0.25,
      needsRepro: false,
      risk: codeIntent ? "medium" : "low",
      reason: codeIntent ? "Weak code-changing signal with low classifier confidence." : "No strong task signal matched.",
      complexitySignals
    };
  }

  let risk = best.risk;
  if (/\b(lockfile|package-lock|dependency|dependencies|delete|remove file|destructive|database|auth|production)\b/i.test(lower)) {
    risk = "high";
  } else if (complexitySignals.length >= 2 && risk === "low") {
    risk = "medium";
  }

  const confidence = Math.min(0.95, best.confidence + Math.min(0.12, complexitySignals.length * 0.03));
  return {
    taskKind: best.kind,
    confidence,
    needsRepro: best.needsRepro,
    risk,
    reason: best.reason,
    complexitySignals
  };
}

export function detectComplexitySignals(message: string, likelyFiles: string[] = []): string[] {
  const signals: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ["multiple modules likely", /\b(multi[- ]file|modules?|subsystem|workflow|end[- ]to[- ]end|integrat(e|ion))\b/i],
    ["command registration", /\b(slash command|\/[a-z][\w-]*|command|registry)\b/i],
    ["tool registration", /\b(tool|schema|registerTool|tooling)\b/i],
    ["configuration change", /\b(config|setting|defaults?|policy)\b/i],
    ["tests expected", /\b(test|tests|coverage|verify|ci)\b/i],
    ["documentation expected", /\b(docs?|readme|guide)\b/i],
    ["new subsystem", /\b(orchestrator|router|planner|executor|system|framework|architecture)\b/i],
    ["migration/refactor", /\b(migration|migrate|refactor|restructure|architecture)\b/i],
    ["unfamiliar API/docs likely", /\b(official docs|api|library|provider|sdk)\b/i]
  ];
  for (const [label, pattern] of checks) {
    if (pattern.test(message)) signals.push(label);
  }
  if (likelyFiles.length > 1) signals.push("multiple likely files");
  return [...new Set(signals)];
}
