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
    // A from-scratch creation SPEC must outrank bug_fix/test_failure: long feature specs
    // routinely contain the words "bug" ("tag as bug"), "delete" ("delete tasks"), or
    // "fails" ("if build fails, fix it") as feature descriptions, and those words used to
    // hijack routing into careful-repro + high-risk blocking for a plain app build.
    kind: "feature_addition",
    patterns: [
      /\b(create|build|make|scaffold|generate|write)\b.{0,80}\b(complete|new|full|entire)?\s*(app|application|web ?app|website|webpage|page|project|game|tool|cli|dashboard|component|library)\b.{0,80}\bfrom scratch\b/is,
      /\bfrom scratch\b.{0,80}\b(app|application|web ?app|website|project|game|tool|cli|dashboard)\b/is,
      /^\s*(create|build|make|scaffold|generate)\b.{0,60}\b(app|application|web ?app|website|project|game|tool|cli|dashboard)\b/i
    ],
    confidence: 0.9,
    needsRepro: false,
    risk: "medium",
    reason: "Request is a from-scratch creation spec."
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
    patterns: [
      /\b(fix|debug|repair|broken|bug|crash|exception|traceback|stack trace|wrong|incorrect|not working)\b/i,
      // Keyword-less symptom reports: "the login button doesn't do anything when clicked"
      // is a fix request even though it never says "fix" or "bug".
      /\b(doesn'?t|does not|won'?t|will not|can'?t|cannot|isn'?t working|stopped working|no longer works?|does nothing|nothing happens|never (loads|renders|updates|saves|fires|responds))\b/i
    ],
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

// explanation_only is start-anchored ("Explain...", "Walk me through...") so it wins on
// messages that OPEN with an explanation verb even when they explicitly command a code
// change later ("Explain why the login test is failing and fix it"). Any of these action
// verbs ANYWHERE in the message means the request is not purely informational, so
// explanation_only must not fire regardless of how the message opens.
const ACTION_OVERRIDE = /\b(fix|repair|implement|refactor|resolve|build|create|add|enable|support|change|update|modify|remove|delete|wire|register)\b/i;

// Destructive intent, not destructive vocabulary: the verb must target a repo/file/data
// object (or name an inherently dangerous artifact like a lockfile). Exported so the policy
// layer's blocked_needs_user gate uses the exact same definition.
export const HIGH_RISK_INTENT = new RegExp(
  [
    String.raw`\b(lockfile|package-lock)\b`,
    String.raw`\b(add|bump|upgrade|change|swap|install)\b.{0,30}\b(dependency|dependencies)\b`,
    String.raw`\b(delete|remove|drop|wipe|purge)\b.{0,30}\b(file|files|folder|director\w*|repo\w*|branch|database|table|all\b|everything)`,
    String.raw`\bdestructive\b`,
    String.raw`\b(production|prod)\b.{0,20}\b(data|database|deploy|config)`,
    String.raw`\brewrite\b.{0,20}\b(history|the repo)`
  ].join("|"),
  "i"
);

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
  const hasActionIntent = ACTION_OVERRIDE.test(text);

  for (const rule of RULES) {
    if (rule.kind === "explanation_only" && hasActionIntent) continue;
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
      // Risk elevation must apply here too: this early return used to skip the destructive-
      // intent check entirely, so "delete all files in X" that matched no task rule was
      // never flagged high-risk.
      risk: HIGH_RISK_INTENT.test(lower) ? "high" : codeIntent ? "medium" : "low",
      reason: codeIntent ? "Weak code-changing signal with low classifier confidence." : "No strong task signal matched.",
      complexitySignals
    };
  }

  let risk = best.risk;
  // High risk requires destructive INTENT, not a destructive-sounding word: "delete tasks"
  // in a feature spec, "tag as bug", or "auth" as a product feature must not trip this.
  if (HIGH_RISK_INTENT.test(lower)) {
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
