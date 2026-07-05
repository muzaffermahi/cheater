export interface CheaterConfig {
  piCommand?: string | string[];
  provider?: string;
  model?: string;
  themeEnabled?: boolean;
  defaultTestCommand?: string;
  packagePath?: string;
  memoryEnabled?: boolean;
  skillsEnabled?: boolean;
  debug?: boolean;
  showStartupCard?: boolean;
  maxContextTokens?: number;
  // HTTP idle timeout (ms) for model requests. Pi's default (300000 = 5 min) kills a slow local
  // model's PREFILL of a big prompt (no response bytes flow during prefill), causing an infinite
  // disconnect/retry loop. Cheater raises it (default 30 min; 0 = no timeout) for the main session
  // (via the launcher writing Pi settings) AND for the worker/sidecar sessions it creates.
  httpIdleTimeoutMs?: number;
  // Explicit ceiling for the MAIN interactive session's context (planner/orchestrator).
  // Unset (default) means "breathe up to ~90% of the model's real context window" - do not
  // confuse this with the tiny per-worker packet budget (maxContextTokens/blueprintMaxAgentTokens).
  maxSessionContextTokens?: number;
  contextCompactRatio?: number;
  // When true, a high-risk request (destructive intent) stops and asks the user before
  // editing. Default false: Cheater is autonomous - one prompt runs to completion, and
  // destructive intent is surfaced as a caution the model proceeds through, not a hard stop.
  requireApprovalForHighRisk?: boolean;
  gymEnabled?: boolean;
  gymDefaultLimit?: number;
  gymDefaultConcurrency?: number;
  gymTempDir?: string;
  gymKeepWorkspaces?: boolean;
  gymRunFullTests?: "never" | "if_cheap" | "always";
  gymAutoLearn?: boolean;
  gymDeltaModeEnabled?: boolean;
  autopilotEnabled?: boolean;
  autopilotRouteAllCodeTasks?: boolean;
  blueprintModeEnabled?: boolean;
  blueprintAutoForComplexTasks?: boolean;
  blueprintUseFastPath?: boolean;
  blueprintCandidateCount?: number;
  blueprintShowInternalPlanSummary?: boolean;
  blueprintRequireApproval?: "always" | "high_risk_only" | "never";
  blueprintMaxPackets?: number;
  blueprintMaxCallsPerPacket?: number;
  blueprintMaxDebugRounds?: number;
  blueprintReplanAfterFailedDebug?: boolean;
  blueprintMemoryEnabled?: boolean;
  blueprintOfficialDocsSearchEnabled?: boolean;
  blueprintDocsProvider?: "local" | "official_allowlist" | "searxng";
  searxngBaseUrl?: string;
  blueprintMaxDocsFacts?: number;
  blueprintFetchDocsPages?: boolean;
  blueprintFreshAgentPerPacket?: boolean;
  blueprintMaxAgentTokens?: number;
  blueprintBlockPlannerFileTools?: boolean;
  bugFreshAgentEnabled?: boolean;
  reliabilityModeEnabled?: boolean;
  freshCallPacketsEnabled?: boolean;
  packetOneFilePerWorkerEnabled?: boolean;
  packetMaxFilesToTouch?: number;
  packetContextBudgetTokens9B?: number;
  packetContextBudgetTokensMoE?: number;
  packetHardContextCeilingTokens9B?: number;
  packetHardContextCeilingTokensMoE?: number;
  postEditSyntaxGateEnabled?: boolean;
  // Post-edit import gate: after each successful edit, verify the file's imports resolve
  // (repo files exist, named symbols are exported, npm packages are installed) and report
  // problems in-band on the edit's own result. Catches hallucinated imports immediately.
  postEditImportGateEnabled?: boolean;
  autoVerifyOnFinish?: boolean;
  // When the model ANSWERS an actionable task in chat but calls zero tools (writes nothing, runs
  // nothing), nudge it once at agent-end to actually do the work with its tools. Default on.
  nudgeAnsweredWithoutActing?: boolean;
  loopGovernorEnabled?: boolean;
  maxLoopBreaksPerPacket?: number;
  maxToolCallsTinyPacket?: number;
  maxToolCallsNormalPacket?: number;
  maxToolCallsHardPacket?: number;
  maxTotalToolCallsPerPacket?: number;
  sameFileReadLimit?: number;
  sameFailedCommandLimit?: number;
  sameSearchQueryLimit?: number;
  samePatchLimit?: number;
  stopSentinelsEnabled?: boolean;
  jsonStopSentinel?: string;
  patchStopSentinel?: string;
  reviewStopSentinel?: string;
  officialDocsSearchEnabled?: boolean;
  docsProvider?: "local" | "official_allowlist" | "searxng";
  maxDocsFacts?: number;
  benchmarkEnabled?: boolean;
  benchmarkDefaultTaskLimit?: number;
  commitletModeEnabled?: boolean;
  commitletAutoForCodeTasks?: boolean;
  // When true, each commitlet is dispatched to a real isolated fresh worker session
  // (context isolation) by default, instead of returning a prompt to the orchestrator.
  // Requires a working model backend; keep false for offline/dry-run use.
  commitletFreshWorkerDefault?: boolean;
  // Verified resampling: number of independent fresh-worker attempts per commitlet in
  // real-worker mode. The harness scores each candidate in code (guard/health/focused
  // verification), accepts the first verified pass, and keeps the best failing candidate
  // otherwise. 1 (default) = today's single attempt; 2-3 recommended for small local models
  // where samples are cheap and pass@1 is weak.
  commitletCandidateSamples?: number;
  // Adaptive test-time-compute (roadmap P5): when true, the per-commitlet best-of-N sample count,
  // self-debug rounds, and localization depth scale with a cheap HARDNESS signal (task kind, risk,
  // files in scope, repair, first-sample-verified) instead of the static commitletCandidateSamples.
  // Easy commitlets get k=1 (near-vanilla speed); hard ones get up to adaptiveMaxSamples. OFF by
  // default -> byte-identical static behavior. See runtime/computeBudget.ts.
  adaptiveComputeEnabled?: boolean;
  // Upper bound on adaptive best-of-N samples for the hardest commitlet (default 8), sized so a hard
  // commitlet still fits the ~15-min wall-clock target at ~25 tok/s (sequential on one GPU).
  adaptiveMaxSamples?: number;
  // Upper bound on adaptive self-debug / bounded-repair rounds (default 2; research: two rounds
  // capture 76-95% of the gain).
  adaptiveMaxDebugRounds?: number;
  // Disciplined SKILL memory (roadmap P3), SEPARATE from the disabled bugMemoryEnabled bug-corpus.
  // Only execution-verified fail->pass transitions are admitted; retrieval is event-driven and
  // similarity-gated; the bank is bounded + compacted. OFF by default until A/B-validated net-positive.
  skillMemoryEnabled?: boolean;
  // Max fresh-worker attempts to run AT ONCE (WorkerPool). Default 1 (sequential) - correct on a
  // single GPU, which serializes concurrent model calls anyway. >1 only helps on a batching backend
  // (vLLM/TGI) AND needs workerBackendBatches:true; otherwise Cheater runs sequentially and says why.
  maxWorkerConcurrency?: number;
  // Opt-in signal that the backend truly runs multiple model calls concurrently (continuous
  // batching). Cannot be auto-detected, and a single-slot GPU does NOT qualify. Off by default.
  workerBackendBatches?: boolean;
  // Wall-clock limit per fresh-worker attempt (ms). A wedged worker on a slow local backend
  // is aborted at this deadline instead of hanging the main session forever. Default 10min.
  commitletWorkerTimeoutMs?: number;
  // Bug memory MASTER switch (default OFF). Gates EVERYTHING the model could see or that feeds it
  // about "bug memory": the cheater_bug_memory_search tool (not even registered when off), the
  // Bug-memory system-prompt section, the Cheat-Layer recall appended to failure cards, and the
  // experience-store WRITE. Off by default because the recalled analogies proved net-negative for a
  // small local model (an out-of-repo "similar fix" is more distracting than helpful). Set true to
  // bring the whole feature back for A/B testing; experienceStoreEnabled/cheatSheetEnabled then act
  // as sub-toggles under it.
  bugMemoryEnabled?: boolean;
  // Minimal main-session system prompt (default ON): identity + edit discipline + the one flow.
  // The worked EXEMPLAR is dropped (set false to restore it) and the Bug-memory section only ever
  // appears when bugMemoryEnabled is true. Fewer prompt tokens => faster prefill on a local model
  // that recomputes the whole prompt each turn (LM Studio KV-cache reuse is unreliable for MoE/35B).
  minimalSystemPrompt?: boolean;
  // Experience store: harness-written bug memory. Cards are saved only on verified
  // fail->pass transitions and recalled in-band inside failure cards. Local-only JSONL.
  // Only active when bugMemoryEnabled is true (the master switch above).
  experienceStoreEnabled?: boolean;
  // Cheat Layer: on failures, the harness classifies the failure, retrieves compact evidence
  // (verified experience -> bug corpus -> local docs -> official docs when enabled), and
  // injects at most 3 hypothesis cards into repair packets and failure notices. The model
  // never calls a search tool; the verifier remains the source of truth.
  cheatSheetEnabled?: boolean;
  // Sidecar model: a small 2B-4B "clerk" model for bounded fuzzy chores (currently failure
  // distillation for informed repairs). OFF by default; the deterministic fallback is the floor,
  // so Cheater behaves identically when this is unset. When enabled without an explicit
  // sidecarModel, the job runs on the main model in bounded no-tool mode (sidecarAllowMainModel).
  // Every sidecar call is bounded (timeout + tiny output) and recorded in the completion receipt.
  // Auto-enables the moment a sidecarModel is set (unless sidecarEnabled is explicitly false), so
  // the user just points it at a 2-4B and it turns on. See sidecarConfig() in sidecar/client.ts.
  sidecarEnabled?: boolean;
  sidecarProvider?: string;
  sidecarModel?: string;
  // Optional endpoint for a SEPARATE sidecar server (e.g. a CPU-hosted llama.cpp on another port).
  // When unset the sidecar shares the main provider/endpoint and only the model id differs (the
  // LM Studio "two loaded models" case). A CPU-hosted sidecar is the recommended setup on a single
  // small GPU: it runs truly in parallel with the GPU-bound main model, no VRAM contention.
  sidecarBaseUrl?: string;
  sidecarTimeoutMs?: number;
  sidecarMaxOutputTokens?: number;
  sidecarAllowMainModel?: boolean;
  // How the sidecar overlaps the main model. "gap" (default): dispatch only in main-model idle
  // windows (while a deterministic tool runs) - safe on a single serialized GPU. "concurrent":
  // dispatch anytime - for a CPU-hosted sidecar or a real batching backend that won't contend.
  // "off": run sidecar jobs synchronously on demand (no background scheduling).
  sidecarParallelism?: "off" | "gap" | "concurrent";
  // Bounded typecheck gate (R1): after a commitlet edit, run the project typechecker and
  // hard-block ONLY new errors in the files this change touched (pre-existing repo errors warn;
  // no typechecker / timeout never blocks). A block routes through the bounded repair path, so it
  // is escapable, not a dead-end. Off by default until validated live. TypeScript-first.
  typeCheckGateEnabled?: boolean;
  typeCheckGateBlocking?: boolean;
  typeCheckGateTimeoutMs?: number;
  rollbackRequired?: boolean;
  maxFilesTouchedDefault?: number;
  maxDiffLinesDefault?: number;
  maxModelCallsPerCommitlet?: number;
  repairAttemptsPerCommitlet?: number;
  // #3 fix: run a SINGLE-commitlet task in-session (the main model does it directly) instead of
  // spawning a cold fresh worker that lacks the exploration context and fails terminal/surgical
  // tasks. Multi-commitlet plans still fan out to fresh workers. Default on.
  singleCommitletInSession?: boolean;
  healthScoreThreshold?: number;
  hardRejectHealthThreshold?: number;
  allowDependencyEditsByDefault?: boolean;
  allowLockfileEditsByDefault?: boolean;
  allowTestEditsByDefault?: boolean;
  finalReviewEnabled?: boolean;
  autoCleanupLowRiskHealthIssues?: boolean;
  telemetryEnabled?: boolean;
  telemetryLocalOnly?: boolean;
  retrievalMaxPlanningFacts?: number;
  retrievalMaxFeedbackFacts?: number;
  // Durable run state: .cheater/runs/<taskId>/ with the acceptance contract, workspace
  // digest, mutation/validation ledgers, per-worker capsules/plans/reports, phase control,
  // and the post-success guard. This is the context-reincarnation layer: a controller can be
  // respawned from these files alone. Default on.
  runStateEnabled?: boolean;
  // Action budget for the time-aware phase controller (EXPLORE/IMPLEMENT/VALIDATE/RESERVE).
  // Unset = derived from the plan's per-commitlet tool budgets.
  runStateActionBudget?: number;
  // Read-before-write hook: overwriting an existing file the run never read (and that the
  // contract does not name as an artifact) is blocked. Default on.
  readBeforeWriteEnabled?: boolean;
  // Threshold (chars) above which a full-file rewrite of an existing file draws a
  // verification-required warning. Default 6000.
  largeWriteWarnChars?: number;
  // Allow a capsule over the 8K hard token limit to spawn anyway (recorded as a warning).
  capsuleInvariantOverride?: boolean;
  // Max allowed files per worker capsule before the spawn invariant fails. Default 4.
  maxWorkerAllowedFiles?: number;
  // Worker fork mode: how much parent-session history a spawned worker inherits. The default
  // (and only safe value) is "none" - workers are briefed by capsule, never by transcript.
  // "last_n"/"all" additionally require workerForkModeOverrideReason and log a warning event.
  workerForkMode?: "none" | "last_n" | "all";
  workerForkModeOverrideReason?: string;
  workerForkTurns?: number;
  // --- Main LLM Call Governor (control plane: call the big model less, only when it matters) ---
  // The governor CLASSIFIES an intended call into a role, states the policy (main/sidecar/
  // deterministic + whether it may escalate), and RECORDS main calls made vs avoided for the
  // receipt. Off by default: the wiring still accounts, but the receipt section is gated on this,
  // so behaviour is identical when off. See runtime/mainCallGovernor.ts.
  mainCallGovernorEnabled?: boolean;
  // Roles the big model is allowed for (default: blueprint_planning, code_worker, repair_worker,
  // strategic_bug_reasoning). Clerical roles default to sidecar/deterministic.
  mainAllowedRoles?: string[];
  // Clerical roles permitted to ESCALATE to the big model when sidecar/deterministic is
  // insufficient. Default empty = deterministic is the floor (today's behaviour).
  mainFallbackAllowedRoles?: string[];
  // Roles preferred to the sidecar/deterministic path (default: route, failure_distill,
  // capsule_compress, compaction_summary, receipt_summary, tool_error_normalize).
  sidecarPreferredRoles?: string[];
  // --- Sidecar liveness / usage (keep the CPU clerk warm and honest about whether it earned its keep) ---
  sidecarKeepAliveEnabled?: boolean;
  sidecarHealthIntervalMs?: number;
  sidecarMinUsefulCallsPerRun?: number;
  // Fire one TINY JSON health check at run start to warm a cold CPU endpoint. Off by default.
  sidecarForceWarmOnRunStart?: boolean;
  // --- LM Studio stateful/telemetry probe (Part B) ---
  // Base URL of the LM Studio server to PROBE for native stateful chat + TTFT/token stats (e.g.
  // http://localhost:1234 or .../v1). Cheater cannot know the main model's endpoint (Pi owns it),
  // so set this to measure. Falls back to sidecarBaseUrl. Probe is a standalone fetch; it does NOT
  // rewire Pi's provider. /v1/chat/completions is treated as STATELESS unless proven otherwise.
  lmStudioBaseUrl?: string;
  providerProbeEnabled?: boolean;
  // Also run the fixed-prefix reuse micro-benchmark (measured only; never claims KV-cache). Off by default.
  providerProbeBenchmark?: boolean;
  // Lean worker prompt (Track 3 - prefill reduction): cap the growing/fixed capsule fields (rulePack,
  // operatingRules, workspaceDigest, mutationSummary, priorWorkerReports, snippets) harder so each
  // commitlet's prompt is smaller and the main model's per-file prefill is cheaper. Drops nothing
  // load-bearing. Off by default (byte-identical worker prompts when off). See promptCapsule.setLeanCapsule.
  leanWorkerPromptEnabled?: boolean;
  // MAIN-session prefill economy. The single biggest TTFT cost on a local model is the FIRST
  // prefill; the second is re-prefilling when the cached prompt PREFIX changes between turns (a
  // local engine like LM Studio/llama.cpp reuses the KV cache only for a byte-stable prefix).
  // These two keep the main-session prompt small and its prefix stable. Default ON (the whole
  // point of this build is fast local models); set false to restore the verbose/volatile behavior.
  //  - leanAutopilotInstruction: the per-message flow preamble is a tight 2-liner (the authoritative
  //    flow already lives once in the system prompt) instead of the 6-line block re-sent every turn.
  leanAutopilotInstruction?: boolean;
  //  - stablePromptPrefix: keep the volatile git-status OUT of the cached system-prompt prefix (it
  //    trails the stable content), and hold the cheater tool surface stable once a code session is
  //    underway (don't shrink to answer_only mid-session) so the tool-schema prefix isn't invalidated.
  stablePromptPrefix?: boolean;
  // How many upcoming commitlets the sidecar prepares ahead per dispatch window (Track 2). Higher =
  // the CPU clerk always has a queue to work while the GPU model writes. Default 3.
  sidecarPrefetchHorizon?: number;
  // Max sidecar jobs in flight at once (Track 2). Only >1 with a separate CPU endpoint that won't
  // contend with the GPU. Default 1 (a single local model can't usefully parallelize with itself).
  sidecarMaxConcurrency?: number;
  // From-scratch boilerplate acceleration (Phase A): the harness keeps a REGISTRY of stack profiles
  // and matches the model's OWN proposed file list to one (.tsx -> React+Vite TS, .jsx -> React+Vite
  // JS, ...), then stamps that stack's INVARIANT files (build config, standard entry, Tailwind
  // index.css, a localStorage hook) to disk so the local model never decodes pure boilerplate. The
  // model is never shown a menu; its file plan is its choice, and stamped files are an editable
  // starting point, not a cage. Purely additive: an unrecognized stack stamps nothing and the
  // model-authored path (blueprint/scaffold.ts) is byte-identical. Off by default until the headless
  // A/B confirms a net win with no new build-fix cycles; then flip on. See blueprint/stackTemplates.ts.
  scaffoldTemplatesEnabled?: boolean;
  // Which stack profiles are eligible (default: all registered, currently vite-react-ts + vite-react-js).
  scaffoldTemplateStacks?: string[];
}

export interface LaunchOptions {
  doctor: boolean;
  debug: boolean;
  noTheme: boolean;
  printPiCommand: boolean;
  help: boolean;
  version: boolean;
  passthrough: string[];
}

export interface PiCommandResolution {
  command: string[];
  source: "config" | "env" | "path" | "fallback";
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}
