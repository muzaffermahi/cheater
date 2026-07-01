import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ClassificationResult,
  EvidencePacket,
  Mission,
  MissionStatus,
  MissionType,
  MissionLogEntry,
  OracleReport,
  Playbook,
  ProjectFacts,
  ReproResult
} from "./types.js";

export type { Mission } from "./types.js";

export interface MissionStoreOptions {
  cwd: string;
  logLimit?: number;
  rawLogCharLimit?: number;
}

export interface MissionStore {
  list(): Mission[];
  get(id: string): Mission | undefined;
  active(): Mission | undefined;
  setActive(id: string): void;
  create(input: { userGoal: string; missionType: MissionType; repoRoot: string }): Mission;
  update(id: string, patch: Partial<Mission>): Mission;
  appendLog(id: string, step: string, message: string): void;
  setStatus(id: string, status: MissionStatus, currentStep: string): Mission;
  setClassification(id: string, classification: ClassificationResult): Mission;
  setProjectOrientation(id: string, facts: ProjectFacts): Mission;
  setRepro(id: string, repro: ReproResult): Mission;
  setEvidence(id: string, evidence: EvidencePacket): Mission;
  setPlaybook(id: string, playbook: Playbook): Mission;
  setVerification(id: string, verification: OracleReport): Mission;
  addCommand(id: string, command: string): void;
  addFilesTouched(id: string, files: string[]): void;
  addTestsRun(id: string, tests: string[]): void;
  setPatchSummary(id: string, summary: string): void;
  addLearned(id: string, items: string[]): void;
  addRiskFlag(id: string, flag: string): void;
  truncateLog(message: string): string;
  saveDir(): string;
}

export function defaultMissionStore(options: MissionStoreOptions): MissionStore {
  const dir = join(options.cwd, ".cheater", "missions");
  mkdirSync(dir, { recursive: true });
  const indexFile = join(dir, "index.json");
  const logLimit = options.logLimit ?? 200;
  const rawLimit = options.rawLogCharLimit ?? 12000;

  function loadIndex(): { activeId?: string; ids: string[] } {
    if (!existsSync(indexFile)) return { ids: [] };
    try {
      const parsed = JSON.parse(readFileSync(indexFile, "utf8")) as { activeId?: string; ids: string[] };
      return { activeId: parsed.activeId, ids: parsed.ids ?? [] };
    } catch {
      return { ids: [] };
    }
  }

  function writeIndex(index: { activeId?: string; ids: string[] }): void {
    writeFileSync(indexFile, JSON.stringify(index, null, 2), "utf8");
  }

  function load(id: string): Mission | undefined {
    const file = join(dir, `${id}.json`);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Mission;
    } catch {
      return undefined;
    }
  }

  function write(mission: Mission): void {
    const file = join(dir, `${mission.id}.json`);
    writeFileSync(file, JSON.stringify(mission, null, 2), "utf8");
  }

  function updateIndexAfterMutation(prevIds: string[], next: Mission): string[] {
    const ids = prevIds.includes(next.id) ? prevIds : [...prevIds, next.id];
    return ids.slice(-50);
  }

  return {
    list() {
      const index = loadIndex();
      const missions: Mission[] = [];
      for (const id of index.ids) {
        const mission = load(id);
        if (mission) missions.push(mission);
      }
      return missions;
    },
    get(id) {
      return load(id);
    },
    active() {
      const index = loadIndex();
      if (!index.activeId) return undefined;
      return load(index.activeId);
    },
    setActive(id) {
      const index = loadIndex();
      index.activeId = id;
      writeIndex(index);
    },
    create(input) {
      const now = new Date().toISOString();
      const mission: Mission = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        repoRoot: input.repoRoot,
        userGoal: input.userGoal,
        missionType: input.missionType,
        status: "planning",
        currentStep: "created",
        evidence: null,
        projectOrientation: null,
        playbook: null,
        repro: null,
        classification: null,
        commandsRun: [],
        filesTouched: [],
        testsRun: [],
        patchSummary: "",
        verification: null,
        learned: [],
        riskFlags: []
      };
      write(mission);
      const index = loadIndex();
      index.ids = updateIndexAfterMutation(index.ids, mission);
      index.activeId = mission.id;
      writeIndex(index);
      return mission;
    },
    update(id, patch) {
      const current = load(id);
      if (!current) throw new Error(`Mission not found: ${id}`);
      const next: Mission = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
      write(next);
      return next;
    },
    appendLog(id, step, message) {
      const current = load(id);
      if (!current) return;
      const log = (current as Mission & { log?: MissionLogEntry[] }).log ?? [];
      log.push({ at: new Date().toISOString(), step, message });
      while (log.length > logLimit) log.shift();
      const withLog = { ...current, log } as Mission & { log: MissionLogEntry[] };
      write(withLog as Mission);
    },
    setStatus(id, status, currentStep) {
      return this.update(id, { status, currentStep });
    },
    setClassification(id, classification) {
      return this.update(id, { classification });
    },
    setProjectOrientation(id, facts) {
      return this.update(id, { projectOrientation: facts });
    },
    setRepro(id, repro) {
      let status: MissionStatus = "reproducing";
      if (repro.alreadyPassing) status = "no_change_needed";
      else if (!repro.reproduced && !repro.environmentFailure) status = "waiting_for_user";
      return this.update(id, { repro, status, currentStep: "repro_complete" });
    },
    setEvidence(id, evidence) {
      return this.update(id, { evidence });
    },
    setPlaybook(id, playbook) {
      return this.update(id, { playbook });
    },
    setVerification(id, verification) {
      return this.update(id, { verification });
    },
    addCommand(id, command) {
      const current = load(id);
      if (!current) return;
      const commandsRun = current.commandsRun.includes(command) ? current.commandsRun : [...current.commandsRun, command];
      write({ ...current, commandsRun, updatedAt: new Date().toISOString() });
    },
    addFilesTouched(id, files) {
      const current = load(id);
      if (!current) return;
      const merged = Array.from(new Set([...current.filesTouched, ...files]));
      write({ ...current, filesTouched: merged, updatedAt: new Date().toISOString() });
    },
    addTestsRun(id, tests) {
      const current = load(id);
      if (!current) return;
      const merged = Array.from(new Set([...current.testsRun, ...tests]));
      write({ ...current, testsRun: merged, updatedAt: new Date().toISOString() });
    },
    setPatchSummary(id, summary) {
      this.update(id, { patchSummary: summary });
    },
    addLearned(id, items) {
      const current = load(id);
      if (!current) return;
      const merged = Array.from(new Set([...current.learned, ...items]));
      write({ ...current, learned: merged, updatedAt: new Date().toISOString() });
    },
    addRiskFlag(id, flag) {
      const current = load(id);
      if (!current) return;
      if (current.riskFlags.includes(flag)) return;
      write({ ...current, riskFlags: [...current.riskFlags, flag], updatedAt: new Date().toISOString() });
    },
    truncateLog(message) {
      if (message.length <= rawLimit) return message;
      const truncated = message.slice(0, rawLimit);
      return `${truncated}\n...[truncated ${message.length - rawLimit} chars]`;
    },
    saveDir() {
      return dir;
    }
  };
}

export function inMemoryMissionStore(options: MissionStoreOptions, initial?: Mission[]): MissionStore {
  const store = new Map<string, Mission>();
  for (const mission of initial ?? []) store.set(mission.id, mission);
  let activeId: string | undefined;
  if (initial && initial.length > 0) activeId = initial[initial.length - 1].id;
  const logLimit = options.logLimit ?? 200;
  const rawLimit = options.rawLogCharLimit ?? 12000;
  const logs = new Map<string, MissionLogEntry[]>();

  function snapshot(mission: Mission): Mission {
    return JSON.parse(JSON.stringify(mission)) as Mission;
  }

  return {
    list() {
      return [...store.values()].map(snapshot);
    },
    get(id) {
      const mission = store.get(id);
      return mission ? snapshot(mission) : undefined;
    },
    active() {
      if (!activeId) return undefined;
      const mission = store.get(activeId);
      return mission ? snapshot(mission) : undefined;
    },
    setActive(id) {
      activeId = id;
    },
    create(input) {
      const now = new Date().toISOString();
      const mission: Mission = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        repoRoot: input.repoRoot,
        userGoal: input.userGoal,
        missionType: input.missionType,
        status: "planning",
        currentStep: "created",
        evidence: null,
        projectOrientation: null,
        playbook: null,
        repro: null,
        classification: null,
        commandsRun: [],
        filesTouched: [],
        testsRun: [],
        patchSummary: "",
        verification: null,
        learned: [],
        riskFlags: []
      };
      store.set(mission.id, mission);
      activeId = mission.id;
      return snapshot(mission);
    },
    update(id, patch) {
      const current = store.get(id);
      if (!current) throw new Error(`Mission not found: ${id}`);
      const next: Mission = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
      store.set(id, next);
      return snapshot(next);
    },
    appendLog(id, step, message) {
      const list = logs.get(id) ?? [];
      list.push({ at: new Date().toISOString(), step, message });
      while (list.length > logLimit) list.shift();
      logs.set(id, list);
    },
    setStatus(id, status, currentStep) {
      return this.update(id, { status, currentStep });
    },
    setClassification(id, classification) {
      return this.update(id, { classification });
    },
    setProjectOrientation(id, facts) {
      return this.update(id, { projectOrientation: facts });
    },
    setRepro(id, repro) {
      let status: MissionStatus = "reproducing";
      if (repro.alreadyPassing) status = "no_change_needed";
      else if (!repro.reproduced && !repro.environmentFailure) status = "waiting_for_user";
      return this.update(id, { repro, status, currentStep: "repro_complete" });
    },
    setEvidence(id, evidence) {
      return this.update(id, { evidence });
    },
    setPlaybook(id, playbook) {
      return this.update(id, { playbook });
    },
    setVerification(id, verification) {
      return this.update(id, { verification });
    },
    addCommand(id, command) {
      const current = store.get(id);
      if (!current) return;
      if (current.commandsRun.includes(command)) return;
      store.set(id, { ...current, commandsRun: [...current.commandsRun, command] });
    },
    addFilesTouched(id, files) {
      const current = store.get(id);
      if (!current) return;
      const merged = Array.from(new Set([...current.filesTouched, ...files]));
      store.set(id, { ...current, filesTouched: merged });
    },
    addTestsRun(id, tests) {
      const current = store.get(id);
      if (!current) return;
      const merged = Array.from(new Set([...current.testsRun, ...tests]));
      store.set(id, { ...current, testsRun: merged });
    },
    setPatchSummary(id, summary) {
      this.update(id, { patchSummary: summary });
    },
    addLearned(id, items) {
      const current = store.get(id);
      if (!current) return;
      const merged = Array.from(new Set([...current.learned, ...items]));
      store.set(id, { ...current, learned: merged });
    },
    addRiskFlag(id, flag) {
      const current = store.get(id);
      if (!current) return;
      if (current.riskFlags.includes(flag)) return;
      store.set(id, { ...current, riskFlags: [...current.riskFlags, flag] });
    },
    truncateLog(message) {
      if (message.length <= rawLimit) return message;
      const truncated = message.slice(0, rawLimit);
      return `${truncated}\n...[truncated ${message.length - rawLimit} chars]`;
    },
    saveDir() {
      return options.cwd;
    }
  };
}
