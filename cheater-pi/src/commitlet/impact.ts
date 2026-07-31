export type ImpactLabel =
  | "method_body_change"
  | "method_signature_change"
  | "class_declaration_change"
  | "import_change"
  | "config_change"
  | "command_registration_change"
  | "tool_registration_change"
  | "dependency_change"
  | "test_change"
  | "docs_change"
  | "unknown";

export function classifyImpact(files: string[], diffText = ""): ImpactLabel[] {
  const labels = new Set<ImpactLabel>();
  if (/^\+.*\bimport\b|^-.*\bimport\b/gm.test(diffText)) labels.add("import_change");
  // A named callable's param list changing: `function`/`def`, OR a keyword-less TS class method / arrow
  // (`run(a, b) {`, `const f = (…) =>`) — but NOT control-flow (`if (x) {`) or a bare call-site.
  if (/^[+-].*\b(function|def)\s+\w+\([^)]*\)/m.test(diffText)
    || /^[+-]\s*(?:(?:export|async|public|private|protected|static|readonly|get|set)\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|return\b|new\b|await\b)[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::[^;={]+)?\s*(?:=>|\{)/m.test(diffText))
    labels.add("method_signature_change");
  if (/^\+.*\b(class|interface)\s+\w+|^-.*\b(class|interface)\s+\w+/gm.test(diffText)) labels.add("class_declaration_change");
  // Only a real registration call or a commands file — the old bare `/[a-z]` matched paths/imports/
  // division (`a/b`, `./mod`), labelling nearly every diff a command-registration change.
  if (/\b(?:register|add)(?:Slash)?Command\(/i.test(diffText) || files.some((file) => /commands?\.ts$/i.test(file))) labels.add("command_registration_change");
  if (/registerTool\(/i.test(diffText) || files.some((file) => /tools?\.ts$/i.test(file))) labels.add("tool_registration_change");
  if (files.some((file) => /config|settings|pyproject|package\.json/i.test(file))) labels.add("config_change");
  if (files.some((file) => /package-lock|yarn\.lock|pnpm-lock|poetry\.lock|Cargo\.lock/i.test(file))) labels.add("dependency_change");
  if (files.some((file) => /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[jt]sx?$/i.test(file))) labels.add("test_change");
  if (files.some((file) => /README|docs?\//i.test(file))) labels.add("docs_change");
  if (!labels.size && diffText) labels.add("method_body_change");
  if (!labels.size) labels.add("unknown");
  return [...labels];
}

export function derivedVerificationForImpact(labels: ImpactLabel[]): string[] {
  const checks: string[] = [];
  if (labels.includes("method_signature_change")) checks.push("Recheck callers and focused tests.");
  if (labels.includes("import_change")) checks.push("Recheck import users and build/typecheck.");
  if (labels.includes("config_change")) checks.push("Recheck startup/build/test command.");
  if (labels.includes("command_registration_change")) checks.push("Recheck help/command registry tests.");
  if (labels.includes("tool_registration_change")) checks.push("Recheck schema/tool registry tests.");
  if (labels.includes("dependency_change")) checks.push("Require approval and broader verification.");
  if (labels.includes("test_change")) checks.push("Run test quality audit.");
  return checks;
}
