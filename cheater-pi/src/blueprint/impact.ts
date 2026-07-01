import { addDerivedImpactNode } from "./planGraph.js";
import type { PlanGraph } from "./types.js";

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
  | "docs_change";

export function classifyImpact(files: string[], diffText = ""): ImpactLabel[] {
  const text = `${files.join("\n")}\n${diffText}`;
  const labels: ImpactLabel[] = [];
  if (/^\+.*\b(import|require)\b/m.test(diffText) || /^\-.*\b(import|require)\b/m.test(diffText)) labels.push("import_change");
  if (/\bfunction\s+\w+\s*\(|\w+\([^)]*\):/m.test(diffText)) labels.push("method_signature_change");
  if (/\bclass\s+\w+/m.test(diffText)) labels.push("class_declaration_change");
  if (files.some((file) => /config|\.json$|\.toml$|\.ya?ml$/i.test(file))) labels.push("config_change");
  if (/registerCommand|slash command|commandHelp/i.test(text)) labels.push("command_registration_change");
  if (/registerTool|Type\.Object|tool schema/i.test(text)) labels.push("tool_registration_change");
  if (files.some((file) => /package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|pyproject\.toml|package\.json$/i.test(file))) labels.push("dependency_change");
  if (files.some((file) => /(^|[\\/])(test|tests|__tests__)[\\/]|\.test\./i.test(file))) labels.push("test_change");
  if (files.some((file) => /(^|[\\/])docs?[\\/]|README\.md$/i.test(file))) labels.push("docs_change");
  if (!labels.length && diffText.trim()) labels.push("method_body_change");
  return [...new Set(labels)];
}

export function propagateImpact(graph: PlanGraph, labels: ImpactLabel[], sourcePacketId: string): PlanGraph {
  let next = graph;
  for (const label of labels) {
    if (label === "method_signature_change") next = addDerivedImpactNode(next, "Recheck callers and tests", sourcePacketId);
    if (label === "import_change") next = addDerivedImpactNode(next, "Recheck import users and tests", sourcePacketId);
    if (label === "config_change") next = addDerivedImpactNode(next, "Recheck startup/build/test commands", sourcePacketId);
    if (label === "command_registration_change") next = addDerivedImpactNode(next, "Recheck command help and registry", sourcePacketId);
    if (label === "tool_registration_change") next = addDerivedImpactNode(next, "Recheck tool schema and registry", sourcePacketId);
    if (label === "dependency_change") next = addDerivedImpactNode(next, "Request approval for dependency changes", sourcePacketId);
    if (label === "test_change") next = addDerivedImpactNode(next, "Flag test changes for review", sourcePacketId);
  }
  return next;
}
