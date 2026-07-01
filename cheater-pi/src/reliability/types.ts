import type { PacketType } from "../blueprint/types.js";

export type ReliabilityPacketOutputFormat = "json" | "patch" | "review";
export type ModelClass = "9b" | "moe30b" | "moe35b" | "unknown";
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
  packetContextBudget: number;
  hardContextCeiling: number;
  temperature: number;
  topP: number;
  repetitionPenalty: number;
  frequencyPenalty: number;
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
  modelClass?: ModelClass;
  contextBudgetTokens?: number;
  maxOutputTokens?: number;
  modelOperatingRules?: string[];
}

export interface ToolCallRecord {
  kind: "read_file" | "failed_command" | "search" | "patch" | "other";
  value: string;
  ok?: boolean;
  changedFiles?: string[];
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
