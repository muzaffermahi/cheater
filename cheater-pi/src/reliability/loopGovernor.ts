import type { BlueprintConfig } from "../blueprint/config.js";
import type { LoopBreakAction, LoopBreakEvent, LoopRecoveryDirective, ToolCallRecord } from "./types.js";

export class LoopGovernor {
  private readonly events: LoopBreakEvent[] = [];

  constructor(private readonly config: BlueprintConfig, private readonly packetId: string) {}

  get breakCount(): number {
    return this.events.length;
  }

  get history(): LoopBreakEvent[] {
    return [...this.events];
  }

  observeText(text: string): LoopBreakEvent | undefined {
    const reasons = [
      repeatedSentence(text) ? "same sentence repeated at least three times" : "",
      repeatedParagraph(text) ? "same paragraph structure repeated" : "",
      repeatedJsonFields(text) ? "same JSON field sequence repeated" : ""
    ].filter(Boolean);
    return reasons.length ? this.break(reasons.join("; "), text.split(/\r?\n/).filter(Boolean).slice(-5), []) : undefined;
  }

  observeTools(records: ToolCallRecord[]): LoopBreakEvent | undefined {
    if (records.length > this.config.maxTotalToolCallsPerPacket) {
      return this.break(`more than ${this.config.maxTotalToolCallsPerPacket} tool calls in one packet`, summarizeTools(records), records);
    }
    const read = overLimit(records, "read_file", this.config.sameFileReadLimit);
    if (read) return this.break(`same file read too often: ${read}`, summarizeTools(records), records);
    const failed = overLimit(records, "failed_command", this.config.sameFailedCommandLimit);
    if (failed) return this.break(`same failed command repeated: ${failed}`, summarizeTools(records), records);
    const search = overLimit(records, "search", this.config.sameSearchQueryLimit);
    if (search) return this.break(`same search query repeated: ${search}`, summarizeTools(records), records);
    const patch = overLimit(records, "patch", this.config.samePatchLimit);
    if (patch) return this.break(`same patch generated again: ${patch.slice(0, 80)}`, summarizeTools(records), records);
    if (pingPongFiles(records)) return this.break("switching between the same two files repeatedly", summarizeTools(records), records);
    return undefined;
  }

  observeNoProgress(records: ToolCallRecord[], textSummaries: string[]): LoopBreakEvent | undefined {
    const changed = records.some((record) => (record.changedFiles ?? []).length > 0);
    const inspectOnly = records.filter((record) => ["read_file", "search"].includes(record.kind)).length;
    if (!changed && inspectOnly >= 3) return this.break("several inspect/search actions produced no file changes", summarizeTools(records), records);
    if (textSummaries.length >= 2 && normalize(textSummaries.at(-1) ?? "") === normalize(textSummaries.at(-2) ?? "")) {
      return this.break("same failure summary appeared twice", textSummaries.slice(-5), records);
    }
    return undefined;
  }

  private break(reason: string, state: string[], records: ToolCallRecord[]): LoopBreakEvent {
    const nextCount = this.events.length + 1;
    const terminal = nextCount >= this.config.maxLoopBreaksPerPacket;
    const recovery = chooseRecovery(reason, state.filter(Boolean).slice(-5), records, terminal);
    const event: LoopBreakEvent = {
      packetId: this.packetId,
      reason,
      forcedActions: ["inspect_one_file", "edit_one_file", "run_one_test", "stop_blocked"],
      recovery,
      compressedState: state.filter(Boolean).slice(-5),
      breakCount: nextCount,
      terminal
    };
    this.events.push(event);
    return event;
  }
}

function chooseRecovery(reason: string, state: string[], records: ToolCallRecord[], terminal: boolean): LoopRecoveryDirective {
  const allowedActions: LoopBreakAction[] = ["inspect_one_file", "edit_one_file", "run_one_test", "stop_blocked"];
  if (terminal || /more than \d+ tool calls/.test(reason)) {
    return directive("stop_blocked", undefined, "Stop this packet and report the loop blocker with the compressed state.", allowedActions, terminal);
  }

  const changedFile = latestChangedFile(records);
  const failedCommand = latestValue(records, "failed_command");
  if (/same failed command|same failure summary/.test(reason)) {
    if (changedFile) return directive("edit_one_file", changedFile, `Edit only ${changedFile} to address the repeated failure before running any command again.`, allowedActions, terminal);
    return directive("inspect_one_file", latestReadableTarget(records, state), "Inspect one new relevant file before editing; do not rerun the failed command yet.", allowedActions, terminal);
  }

  if (/same patch/.test(reason)) {
    if (failedCommand) return directive("run_one_test", failedCommand, `Run exactly this verification command once to get fresh evidence: ${failedCommand}`, allowedActions, terminal);
    return directive("edit_one_file", changedFile ?? latestReadableTarget(records, state), "Change one allowed file with a different patch; do not repeat the same patch text.", allowedActions, terminal);
  }

  if (/same file read|inspect\/search actions|same search query|switching between/.test(reason)) {
    if (changedFile) return directive("edit_one_file", changedFile, `Edit only ${changedFile}; enough inspection has happened for this loop break.`, allowedActions, terminal);
    return directive("inspect_one_file", latestReadableTarget(records, state), "Inspect exactly one new specific file or stop if no new file is available.", allowedActions, terminal);
  }

  return directive("stop_blocked", undefined, "Choose one forced action only: inspect one new file, edit one file, run one test, or stop with blocker.", allowedActions, terminal);
}

function directive(action: LoopBreakAction, target: string | undefined, instruction: string, allowedActions: LoopBreakAction[], terminal: boolean): LoopRecoveryDirective {
  return { action, target, instruction, allowedActions, terminal };
}

function repeatedSentence(text: string): boolean {
  const counts = new Map<string, number>();
  for (const sentence of text.split(/[.!?]\s+/).map(normalize).filter((s) => s.length > 20)) {
    counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
    if ((counts.get(sentence) ?? 0) >= 3) return true;
  }
  return false;
}

function repeatedParagraph(text: string): boolean {
  const paragraphs = text.split(/\n\s*\n/).map((p) => normalize(p).replace(/[a-z0-9_./-]+/gi, "x")).filter((p) => p.length > 40);
  return paragraphs.some((p, i) => i > 0 && p === paragraphs[i - 1]);
}

function repeatedJsonFields(text: string): boolean {
  const fields = [...text.matchAll(/"([^"]+)"\s*:/g)].map((m) => m[1]).join(",");
  if (!fields) return false;
  const chunks = fields.match(/(?:[^,]+,?){4}/g) ?? [];
  const counts = new Map<string, number>();
  for (const chunk of chunks) {
    counts.set(chunk, (counts.get(chunk) ?? 0) + 1);
    if ((counts.get(chunk) ?? 0) >= 3) return true;
  }
  return false;
}

function overLimit(records: ToolCallRecord[], kind: ToolCallRecord["kind"], limit: number): string | undefined {
  const counts = new Map<string, number>();
  for (const record of records.filter((r) => r.kind === kind)) {
    const key = structuralKey(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if ((counts.get(key) ?? 0) > limit) return record.value;
  }
  return undefined;
}

/**
 * Repetition key that ignores cosmetic differences so genuine degeneration is caught but
 * ordinary iteration is not. Commands are made flag-insensitive and number-insensitive
 * (line numbers, ports, timestamps collapse), so `pytest -v x.py` and `pytest -q x.py`
 * count as the same command family instead of two "different" calls.
 */
function structuralKey(record: ToolCallRecord): string {
  if (record.kind === "failed_command" || record.kind === "other") return commandSignature(record.value);
  return normalize(record.value);
}

function commandSignature(cmd: string): string {
  return cmd
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token && !token.startsWith("-"))
    .map((token) => token.replace(/\d+/g, "#"))
    .join(" ")
    .trim();
}

function pingPongFiles(records: ToolCallRecord[]): boolean {
  const reads = records.filter((r) => r.kind === "read_file").map((r) => r.value).slice(-4);
  return reads.length === 4 && reads[0] === reads[2] && reads[1] === reads[3] && reads[0] !== reads[1];
}

function summarizeTools(records: ToolCallRecord[]): string[] {
  return records.slice(-5).map((record) => `${record.kind}: ${record.value}`);
}

function latestChangedFile(records: ToolCallRecord[]): string | undefined {
  for (const record of [...records].reverse()) {
    const changed = record.changedFiles?.find(Boolean);
    if (changed) return changed;
  }
  return undefined;
}

function latestValue(records: ToolCallRecord[], kind: ToolCallRecord["kind"]): string | undefined {
  return [...records].reverse().find((record) => record.kind === kind)?.value;
}

function latestReadableTarget(records: ToolCallRecord[], state: string[]): string | undefined {
  const fromRecord = [...records].reverse().find((record) => ["read_file", "search", "patch"].includes(record.kind))?.value;
  if (fromRecord) return fromRecord;
  const fromState = [...state].reverse().map((line) => line.replace(/^[^:]+:\s*/, "").trim()).find(Boolean);
  return fromState;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\w\s/-]+/g, "").replace(/\s+/g, " ").trim();
}
