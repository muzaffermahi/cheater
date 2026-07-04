import type { PacketType } from "../blueprint/types.js";

export type ReliabilityPacketOutputFormat = "json" | "patch" | "review";
// Capability tiers spanning Cheater's target band (roughly 7-40B local models), keyed to how
// tightly the harness must scope each worker packet. `small` (<=10B, e.g. Qwen2.5-Coder-7B):
// tightest packets, most explicit rules. `medium` (11-23B, e.g. Qwen2.5-Coder-14B,
// Codestral-22B): the local-coding sweet spot - slightly roomier. `large` (24B+, e.g.
// Gemma-2-27B, Qwen2.5-Coder-32B, DeepSeek-Coder-33B): roomiest, still one file per worker.
// `unknown`: size not inferable from the name - neutral defaults, never assume weak.
export type ModelClass = "small" | "medium" | "large" | "unknown";
export type LoopBreakAction = "inspect_one_file" | "edit_one_file" | "run_one_test" | "stop_blocked";

export interface LoopRecoveryDirective {
  action: LoopBreakAction;
  target?: string;
  instruction: string;
  allowedActions: LoopBreakAction[];
  terminal: boolean;
}

export interface ModelProfile {
  name: string;
  class: ModelClass;
  /** Approximate parameter count in billions parsed from the name, or null when unknown. */
  paramsBillions: number | null;
  packetContextBudget: number;
  hardContextCeiling: number;
  // NOTE: no temperature/topP/repetitionPenalty/frequencyPenalty here. Pi's SDK exposes no
  // sampling knobs (verified against its type declarations - only thinkingLevel is settable),
  // so carrying those fields implied a tuning capability Cheater does not have. The only
  // sampling lever that survives is thinkingLevel jitter in verified resampling.
  maxOutputTokens: number;
}

export interface FreshCallPacket {
  globalGoal: string;
  packetId: string;
  packetType: PacketType;
  filesToTouch: string[];
  filesToAvoid: string[];
  contextSketch: string;
  relevantSnippets: string[];
  previousState: string[];
  acceptanceCriteria: string[];
  allowedActions: Array<"inspect" | "edit" | "run_test" | "stop_blocked">;
  stopWhen: string;
  outputFormat: ReliabilityPacketOutputFormat;
  endSentinel: string;
  // The primary verification command for this packet, when the underlying WorkPacket has
  // one. Rendered as an explicit imperative instruction, not just a fact - a small model
  // grants bash access and shown a bare command string does not reliably infer it must run
  // that command itself before finishing.
  verificationCommand?: string;
  modelClass?: ModelClass;
  contextBudgetTokens?: number;
  maxOutputTokens?: number;
  modelOperatingRules?: string[];
}

export interface ToolCallRecord {
  kind: "read_file" | "failed_command" | "search" | "patch" | "other";
  value: string;
  // Repetition key for loop detection. For a patch this is a CONTENT signature (path + a hash of
  // the actual edit), so iterating on one file with DIFFERENT edits is not flagged as "same patch"
  // - only a byte-identical repeat is. Falls back to `value` when unset.
  signature?: string;
  ok?: boolean;
  changedFiles?: string[];
  toolCallId?: string;
}

export interface LoopBreakEvent {
  packetId: string;
  reason: string;
  forcedActions: LoopBreakAction[];
  recovery: LoopRecoveryDirective;
  compressedState: string[];
  breakCount: number;
  terminal: boolean;
}
