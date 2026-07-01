import type { TestAuditReport } from "./types.js";

export function auditTestChanges(diffText = "", acceptanceCriteria: string[] = []): TestAuditReport {
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  const lines = diffText.split(/\r?\n/);
  const addedLines = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const removedLines = lines.filter((line) => line.startsWith("-") && !line.startsWith("---"));
  const addedText = addedLines.join("\n");
  const removedText = removedLines.join("\n");
  const criteriaText = acceptanceCriteria.join(" ");

  if (removedLines.some((line) => ASSERTION_PATTERN.test(line))) blockingIssues.push("Test assertions were removed. -> Keep the assertions and fix the code under test instead.");
  // Match skip/only as CALL syntax (.skip(, .only(, xit(, @pytest.mark.skip) so ordinary
  // words inside an added test title ("...only when...") do not false-block.
  if (addedLines.some((line) => SKIP_CALL_PATTERN.test(line))) {
    blockingIssues.push("A test was skipped, focused (.only), xfailed, or marked todo. -> Remove the skip/only/todo marker so the suite actually runs this test.");
  }

  if (hasStrictAssertion(removedText) && hasWeakAssertion(addedText)) {
    blockingIssues.push("Test assertions were weakened from strict checks to broad truthiness/wildcard checks. -> Restore the strict assertion (toEqual/toBe/toThrow) that pins the real behavior.");
  }

  const mockLines = addedLines.filter((line) => MOCK_PATTERN.test(line));
  const assertionLines = addedLines.filter((line) => ASSERTION_PATTERN.test(line));
  if (mockLines.length > 0 && assertionLines.length === 0) {
    blockingIssues.push("Test change adds mocks or stubs without clear assertions. -> Add an assertion on the observable behavior, not just the mock call.");
  } else if (mockLines.length > assertionLines.length && !/\b(mock|stub|fake)\b/i.test(criteriaText)) {
    warnings.push("Test change appears mock-heavy; confirm it still exercises behavior.");
  }

  if (/\b(golden|snapshot|snapshots|snap)\b/i.test(diffText) && !hasGoldenReason(diffText, criteriaText)) {
    blockingIssues.push("Golden/snapshot output changed without an explicit reason. -> State in the commitlet why the golden output changed, or revert the snapshot update.");
  }
  if (acceptanceCriteria.length && addedLines.some((line) => /\b(test|it)\s*\(/.test(line)) && !criteriaOverlap(addedText, acceptanceCriteria)) {
    warnings.push("New tests may not map clearly to acceptance criteria.");
  }
  if (addedLines.some((line) => /\b(_private|private|internal|toHaveBeenCalledWith)\b/i.test(line)) && !hasBehaviorAssertion(addedText)) {
    warnings.push("Test change may focus on implementation details instead of behavior.");
  }
  return {
    passed: blockingIssues.length === 0,
    warnings,
    blockingIssues
  };
}

const ASSERTION_PATTERN = /\b(assert|expect|should|equal|throws|rejects|resolves)\b/i;
// Skip/only/todo detected as CALL syntax, not bare words in a test title/description.
const SKIP_CALL_PATTERN = /(\.\s*(skip|only)\s*\(|\bx(it|describe|test)\s*\(|\.\s*todo\s*\(|@pytest\.mark\.(skip|skipif|xfail)|\bpytest\.skip\s*\(|\bit\.skip\b|\bdescribe\.skip\b|\btest\.skip\b)/i;
const STRICT_ASSERTION_PATTERN = /\b(toEqual|toStrictEqual|toBe|toMatchObject|toThrow|deepEqual|strictEqual|throws|rejects|resolves)\b/i;
const WEAK_ASSERTION_PATTERN = /\b(toBeTruthy|toBeFalsy|toBeDefined|toBeUndefined|expect\.any|expect\.anything|assert\.ok|toContain)\b/i;
const MOCK_PATTERN = /\b(jest\.mock|vi\.mock|mock|stub|fake|spyOn|mockResolvedValue|mockRejectedValue|mockReturnValue)\b/i;
const BEHAVIOR_ASSERTION_PATTERN = /\b(toEqual|toStrictEqual|toBe|toMatch|toThrow|deepEqual|strictEqual|includes|contains)\b/i;
const REASON_PATTERN = /\b(reason|because|acceptance|intentional|approved|expected|fixture update|golden update|snapshot update)\b/i;
const STOP_WORDS = new Set(["should", "would", "could", "there", "their", "about", "after", "before", "tests", "test", "with", "from", "that", "this"]);

function hasStrictAssertion(text: string): boolean {
  return STRICT_ASSERTION_PATTERN.test(text);
}

function hasWeakAssertion(text: string): boolean {
  return WEAK_ASSERTION_PATTERN.test(text);
}

function hasBehaviorAssertion(text: string): boolean {
  return BEHAVIOR_ASSERTION_PATTERN.test(text);
}

function hasGoldenReason(diffText: string, criteriaText: string): boolean {
  return REASON_PATTERN.test(diffText) || REASON_PATTERN.test(criteriaText) || /\b(golden|snapshot)\b/i.test(criteriaText);
}

function criteriaOverlap(addedText: string, acceptanceCriteria: string[]): boolean {
  const addedTokens = new Set(tokens(addedText));
  return acceptanceCriteria.some((criterion) => tokens(criterion).some((token) => addedTokens.has(token)));
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
}
