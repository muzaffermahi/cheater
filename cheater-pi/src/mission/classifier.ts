import type { ClassificationResult, MissionType, RiskLevel } from "./types.js";

export interface ClassifyInput {
  message: string;
  recentErrors?: string;
  repoHints?: { hasPackageJson?: boolean; hasPyproject?: boolean; hasTests?: boolean };
  reproRequired?: boolean;
}

interface Rule {
  type: MissionType;
  patterns: RegExp[];
  shouldPatch: boolean;
  needsRepro: boolean;
  risk: RiskLevel;
  why: string;
  firstSteps: string[];
}

const RULES: Rule[] = [
  {
    type: "explanation_only",
    patterns: [
      /^\s*(explain|describe|what does|how does|why does|walk me through|tell me about)\b/i,
      /\b(what is|what's the difference|how do i understand|how should i think about)\b/i
    ],
    shouldPatch: false,
    needsRepro: false,
    risk: "low",
    why: "User asked for an explanation, not a change.",
    firstSteps: ["Read the smallest relevant code region", "Explain with file:line references"]
  },
  {
    type: "repo_orientation",
    patterns: [
      /^\s*(orient|map|overview|where is|where are|how is .* structured|what's in this repo|whats in this repo|repository structure|repo structure)\b/i
    ],
    shouldPatch: false,
    needsRepro: false,
    risk: "low",
    why: "User asked for repo orientation, not a change.",
    firstSteps: ["Load orientation cache", "Show entry points and danger zones"]
  },
  {
    type: "import_error",
    patterns: [
      /\b(modulenotfounderror|importerror|cannot find module|can't find module|no module named|cannot import|unable to import|missing dependency|unresolved import)\b/i
    ],
    shouldPatch: true,
    needsRepro: true,
    risk: "medium",
    why: "Detected an import / module resolution error.",
    firstSteps: ["Inspect the failing import", "Run the repro command", "Check installed package version vs declaration"]
  },
  {
    type: "type_error",
    patterns: [
      /\b(typeerror|typescript error|ts\d+|cannot assign|cannot read properties|cannot read property|is not assignable|is not a function|property .* does not exist|argument of type)\b/i
    ],
    shouldPatch: true,
    needsRepro: true,
    risk: "medium",
    why: "Detected a typing / runtime type mismatch.",
    firstSteps: ["Inspect the symbol types", "Run the focused typecheck/test", "Patch the smallest type-correct call site"]
  },
  {
    type: "test_failure",
    patterns: [
      /\b(test(s|ed|ing)? (failed|failing|fails)|pytest|jest|mocha|assertionerror|expected .* to (be|equal)|test_.*\bFAILED\b|\bFAILED\b|✗|✘)\b/i
    ],
    shouldPatch: true,
    needsRepro: true,
    risk: "medium",
    why: "Detected a failing test signal.",
    firstSteps: ["Re-run the failing test", "Compare expected vs actual", "Patch the smallest source behavior"]
  },
  {
    type: "lint_warning",
    patterns: [
      /\b(eslint|flake8|ruff|pylint|warning:|warn:|unused variable|lint)\b/i
    ],
    shouldPatch: true,
    needsRepro: false,
    risk: "low",
    why: "Detected a lint/style warning.",
    firstSteps: ["Run the linter", "Apply minimal style fix", "Re-run linter"]
  },
  {
    type: "refactor",
    patterns: [
      /\b(refactor|reorganize|restructure|clean up|cleanup|simplify|rename|extract|deduplicate|consolidate|tidy)\b/i
    ],
    shouldPatch: true,
    needsRepro: false,
    risk: "medium",
    why: "Refactor request: behavior must not change.",
    firstSteps: ["Identify public API boundaries", "Plan the smallest safe change", "Run existing focused tests after each step"]
  },
  {
    type: "feature_addition",
    patterns: [
      /\b(add|implement|create|build|introduce|support|enable|new (feature|option|command|flag))\b/i
    ],
    shouldPatch: true,
    needsRepro: false,
    risk: "medium",
    why: "Feature addition request.",
    firstSteps: ["Confirm acceptance criteria", "Inspect nearby patterns", "Implement the minimal slice", "Run focused tests"]
  },
  {
    type: "bug_fix",
    patterns: [
      /\b(bug|broken|doesn't work|does not work|not working|wrong|incorrect|fail(ing|ed)?|crash(es|ing)?|hangs|throws|exception|stack ?trace|traceback|segfault|got .* expected)\b/i
    ],
    shouldPatch: true,
    needsRepro: true,
    risk: "medium",
    why: "Generic bug report: reproduce before patching.",
    firstSteps: ["Reproduce the issue with a focused command", "Gather evidence (memory + orientation)", "Patch the smallest likely cause"]
  }
];

const UNKNOWN_FIRST_STEPS = [
  "Ask the user for the smallest missing detail: failing command, error text, or intended outcome",
  "If intent is clear, classify again and proceed"
];

function pickFirstStep(type: MissionType, message: string, reproRequired: boolean): string[] {
  if (type === "unknown") return UNKNOWN_FIRST_STEPS;
  if (reproRequired) return ["Run the focused repro command", "Gather evidence (memory + orientation + docs)", "Patch only after evidence supports a cause"];
  return RULES.find((rule) => rule.type === type)?.firstSteps ?? ["Inspect, then act"];
}

function bumpRisk(risk: RiskLevel, factors: number): RiskLevel {
  if (factors >= 3) return "high";
  if (factors >= 1 && risk === "low") return "medium";
  return risk;
}

export function classifyTask(input: ClassifyInput): ClassificationResult {
  const text = `${input.message}\n${input.recentErrors ?? ""}`;
  const lower = text.toLowerCase();

  let best: { rule: Rule; score: number } | undefined;
  for (const rule of RULES) {
    let score = 0;
    for (const pattern of rule.patterns) {
      const match = text.match(pattern);
      if (match) {
        score += 2;
        if (match[0].length > 6) score += 1;
        if (lower.startsWith(match[0].toLowerCase())) score += 1;
      }
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { rule, score };
    }
  }

  if (!best) {
    const reproRequired = input.reproRequired ?? true;
    return {
      missionType: "unknown",
      confidence: 0.2,
      why: "No clear signal in the request or recent errors.",
      recommendedFirstSteps: UNKNOWN_FIRST_STEPS,
      shouldPatch: false,
      needsRepro: false,
      risk: "low"
    };
  }

  const reproRequired = input.reproRequired ?? true;
  const needsRepro = best.rule.needsRepro && reproRequired;
  const riskFactors = countRiskFactors(input);
  const risk = bumpRisk(best.rule.risk, riskFactors);
  const confidence = Math.min(0.95, 0.45 + best.score * 0.1);

  return {
    missionType: best.rule.type,
    confidence,
    why: best.rule.why,
    recommendedFirstSteps: pickFirstStep(best.rule.type, input.message, needsRepro),
    shouldPatch: best.rule.shouldPatch,
    needsRepro,
    risk
  };
}

function countRiskFactors(input: ClassifyInput): number {
  let factors = 0;
  if (input.repoHints?.hasTests) factors += 1;
  const dangerMatch = input.message.match(/\b(deploy|release|prod|production|main branch|master branch|db|migration|schema|auth|token|secret|lockfile|package-lock)\b/i);
  if (dangerMatch) {
    factors += 2;
    if (/\b(production|main branch|master branch|auth|secret|migration)\b/i.test(input.message)) factors += 1;
  }
  if (input.recentErrors && input.recentErrors.length > 600) factors += 1;
  return factors;
}
