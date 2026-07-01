import { disagreementGate, retrieveFeedbackMemory, retrievePlanningMemory } from "../blueprint/memory.js";
import type { RepoOrientation } from "../blueprint/types.js";

export function retrieveCommitletPlanningFacts(cwd: string, query: string, orientation: RepoOrientation, maxFacts = 3) {
  const memoryHits = retrievePlanningMemory(cwd, query, true).slice(0, maxFacts);
  return disagreementGate({ memoryHits, docsFacts: [], orientation }).trustedMemory;
}

export function retrieveCommitletFeedbackFacts(cwd: string, failureText: string, orientation: RepoOrientation, maxFacts = 5) {
  const memoryHits = retrieveFeedbackMemory(cwd, failureText, true).slice(0, maxFacts);
  return disagreementGate({ memoryHits, docsFacts: [], orientation }).trustedMemory;
}
