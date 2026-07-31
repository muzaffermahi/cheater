// Kitten Task Compiler — public surface.
//
// One import site for the whole layer, so callers depend on the contract rather than on the stage
// layout. The pipeline is documented in compile.ts; the IR in ir.ts.

export * from "./ir.js";
export { extractLiterals, namesConcreteArtifact, type LiteralExtraction } from "./extract.js";
export { classifyFamily, familyTemplate, FAMILY_TEMPLATES, type FamilyDecision, type FamilyTemplate } from "./family.js";
export { groundTask, collectRepositoryFacts, type GroundingResult, type RepositoryFacts } from "./grounding.js";
export { resolveAmbiguities, unresolvedMaterialCount, type AmbiguityResult } from "./ambiguity.js";
export { compileVerification, executableChecks, type VerificationInput } from "./verification.js";
export { validateCompiledTask, findProhibitedScoreFields, PROHIBITED_SCORE_FIELDS, type ValidationIssue, type ValidationResult } from "./validate.js";
export { decomposeCompiledTask, wouldDecompose, type DecompositionResult, type DerivedTaskNode } from "./decompose.js";
export { renderCompiledTask, renderContractBlock, renderClarification, type ContractSlice } from "./render.js";
export {
  renderArm, measureCompileSide, summarizeArm, summarizeByFamily, renderEvaluation,
  EVALUATION_ARMS, EVALUATION_FIXTURES,
  type ArmSummary, type CompileSideMeasurement, type EvaluationArm, type EvaluationCase, type EvaluationOutcome,
} from "./evaluate.js";
export {
  compileTask, sliceContract, isTaskCompilerFlag,
  type CompileInput, type CompileResult, type CompilerTelemetry, type CompilerTrace, type TaskCompilerFlag,
} from "./compile.js";
