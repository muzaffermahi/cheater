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
      // Verbs are stemmed on purpose: "crash" must also catch "crashes"/"crashing", and bare
      // "the upload fails" / "it throws" / "the UI hangs" are bug reports even without "fix".
      // Bare "bug" is guarded against product-vocabulary enumerations ("tag as bug, feature,
      // praise" / "bug or feature") - those are labeling FEATURES, not defect reports. Real bug
      // reports are carried by fix/debug/repair/crash/etc. or "a bug in X"/"the bug".
      /\b(fix|debug|repair|broken|bug\b(?!\s*(?:,|\/|:|or\b|feature\b|praise\b))|crash(es|ed|ing)?|exception|traceback|stack trace|wrong|incorrect|not working|throws?|throwing|thrown|hangs?|hanging|freezes?|freezing|frozen|fails?|failed|failing|blank (page|screen)|white screen)\b/i,
      // Keyword-less symptom reports: "the login button doesn't do anything when clicked"
      // is a fix request even though it never says "fix" or "bug".
      /\b(doesn'?t|does not|won'?t|will not|can'?t|cannot|isn'?t working|stopped working|no longer works?|does nothing|nothing happens|never\s+(loads?|renders?|updates?|saves?|fires?|responds?|closes?|opens?|shows?|appears?|works?|triggers?|displays?|refreshes))\b/i
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
    // "port/swap/replace/convert X to/for/with Y" are migrations too - the old list only had
    // the literal "port from"/"convert from", so "port the auth module from Express to Fastify"
    // and "swap the logging library for pino" matched no rule and fell to answer_only.
    patterns: [/\b(migrate|migration|schema|upgrade|port from|convert from|move .* to|port\b.{0,40}\bto\b|swap\b.{0,40}\b(for|with|to)\b|replace\b.{0,40}\bwith\b|convert\b.{0,30}\bto\b)/i],
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
    patterns: [/\b(add|implement|create|build|introduce|support|enable|new|tag|label|categorize|classify|write|generate|produce|scaffold|compress|encode|decode|compile|extract)\b/i],
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
// File/output/compute verbs are ACTIONS, not questions. Their omission was a top failure mode: a
// task literally titled "Write me data.comp ..." or "Write a regex ... save it to /app/regex.txt"
// or "Compute the number of tokens ... write it to answer.txt" matched no action verb, classified
// as `unknown`->`answer_only`, and the model was told "this is a question, do not edit files" - so
// it answered in chat and produced nothing. (Live-observed across the hard TB2 sweep.)
// Only clearly-action file/artifact-producing verbs are added - NOT question-ambiguous ones like
// print/output/compute/count ("what does it print?", "what's the output?", "how many?"), which would
// misfire on genuine questions. "write"/"save"/"generate" already catch the file-output tasks.
const ACTION_OVERRIDE = /\b(fix|repair|implement|refactor|resolve|build|create|add|enable|support|change|update|modify|remove|delete|wire|register|write|generate|produce|save|store|scaffold|compress|decompress|encode|decode|encrypt|decrypt|compile|install|configure|download|extract)\b/i;

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

// Destructive vocabulary inside a FEATURE the user wants BUILT ("add a feature to delete old
// files", "a button that wipes all data", "let users purge the cache") describes the app's
// future behavior on END-USER data, not an action on the working repo now. Such a request must
// stay a normal feature build, never the high-risk approval block - blocking app builds under
// requireApproval is a top failure mode. Only a destructive verb aimed at THIS repo/data now
// (no build framing) elevates.
const FEATURE_FRAMED = /\b(add|build|implement|create|introduce|a feature|a button|a ui|a screen|a page|an? endpoint|an? option|an? action|users? can|let users?|ability to|so (that )?users?|command that|function that|feature that)\b/i;

/** High-risk destructive INTENT on the working repo, excluding destructive verbs that merely describe a feature being built. */
export function elevatesToHighRisk(lower: string): boolean {
  return HIGH_RISK_INTENT.test(lower) && !FEATURE_FRAMED.test(lower);
}

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
  // A read-only request ("...just tell me, don't change anything") must not be dragged out of
  // explanation_only just because ACTION_OVERRIDE matched a verb INSIDE the negation ("don't
  // CHANGE"). When the user explicitly forbids edits, the action verbs are not action intent.
  const readOnlyIntent = /\b(just tell me|just explain|don'?t (change|edit|modify|touch|fix)|do not (change|edit|modify|touch|fix)|without (chang|edit|modif|touch)|no changes?\b|read[- ]only|explain only)\b/i.test(text);
  const hasActionIntent = !readOnlyIntent && ACTION_OVERRIDE.test(text);

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
    // Widen the no-rule-match code-intent net to match ACTION_OVERRIDE's coverage: a bare
    // "swap/port/replace/convert the X" is a code task, not a question, and must not default to
    // answer_only.
    const codeIntent = /\b(change|update|modify|make|remove|delete|wire|register|swap|port|replace|convert|write|generate|produce|save|store|scaffold|compress|decompress|encode|decode|encrypt|decrypt|compile|install|configure|download|extract)\b/i.test(text);
    return {
      taskKind: codeIntent ? "feature_addition" : "unknown",
      confidence: codeIntent ? 0.48 : 0.25,
      needsRepro: false,
      // Risk elevation must apply here too: this early return used to skip the destructive-
      // intent check entirely, so "delete all files in X" that matched no task rule was
      // never flagged high-risk. (Feature-framed destructive verbs stay medium - see FEATURE_FRAMED.)
      risk: elevatesToHighRisk(lower) ? "high" : codeIntent ? "medium" : "low",
      reason: codeIntent ? "Weak code-changing signal with low classifier confidence." : "No strong task signal matched.",
      complexitySignals
    };
  }

  let risk = best.risk;
  // High risk requires destructive INTENT on the working repo, not a destructive-sounding word:
  // "delete tasks" in a feature spec, "tag as bug", "auth" as a product feature, or a feature
  // that itself deletes/wipes end-user data must not trip this.
  if (elevatesToHighRisk(lower)) {
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
    // Fire on real command features, but NOT when "command" is a UI noun ("command palette/center/
    // line/bar/menu") - that misrouted a web-app build into Cheater's register-a-Pi-command path.
    // (The src/commands.ts fallback is also existsSync-gated now, so a web app can't get that file.)
    ["command registration", /\bslash command\b|\bregister\w*\s+command\b|\bcommand registr(?:y|ation)\b|\bcommand\b(?!\s+(?:palette|cent(?:er|re)|line|bar|menu|prompt))/i],
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
