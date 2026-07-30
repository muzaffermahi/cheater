// Kitten Core — the durable conversation/run/event store. NO Pi.
//
// One transactional SQLite store behind a repository interface (Goal §6). It holds three things:
//   • conversations — the mutable aggregate (title, project, model, timestamps, archived, searchable text)
//   • events        — the append-only, gap-free, per-conversation-ordered log (the source of truth)
//   • runs          — a queryable projection of each execution's lifecycle + outcome
// The event log is authoritative: conversations/runs are updated transactionally *from* the same
// events so a crash can never leave the projection ahead of the log. `seq` is assigned here, making
// this the single ordering authority; ids are derived (`conversationId:seq`) and reproducible.
//
// Everything is synchronous (SQLite is), which keeps ordering trivial and lets the app await nothing
// on the hot path. Tests open ":memory:" for a fully isolated store.

import {
  EVENT_SCHEMA_VERSION, eventId, eventRunId,
  type EventPayload, type KittenEvent, type RunStatus,
  type Lane,
} from "../events.js";
import { openSqlite, transact, userVersion, setUserVersion, type SqlDatabase, type SqlValue } from "./db.js";

export interface ConversationRow {
  id: string;
  title: string;
  projectRoot: string;
  projectId: string;
  model: string;
  mode: Lane | "auto";
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  lastSeq: number;
  provider?: string | null;
  agent?: string | null;
  parentConversationId?: string | null;
  parentRunId?: string | null;
}

export interface RunRow {
  id: string;
  conversationId: string;
  request: string;
  lane: Lane | null;
  reasons: string[];
  k: number;
  status: RunStatus;
  finished: boolean;
  winner: number | null;
  summary: string;
  verified: boolean;
  filesChanged: string[];
  usage: { prompt: number; completion: number; reasoning: number };
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Pre-run git snapshot for /undo (JSON of RunSnapshot), or null. */
  snapshot: string | null;
  model: string | null;
  agent: string | null;
  parentRunId: string | null;
  undone: boolean;
  snapshotAfter: string | null;
}

export interface CreateConversationInput {
  id: string;
  title: string;
  projectRoot: string;
  projectId: string;
  model: string;
  mode: Lane | "auto";
  ts: number;
  provider?: string | null;
  agent?: string | null;
  parentConversationId?: string | null;
  parentRunId?: string | null;
}

export interface ListConversationsOptions {
  projectId?: string;
  includeArchived?: boolean;
  search?: string;
  limit?: number;
}

export type TaskNodeStatus = "queued" | "blocked" | "running" | "waiting" | "verifying" | "completed" | "failed" | "cancelled" | "interrupted";

export interface TaskNodeRow {
  id: string;
  conversationId: string;
  runId: string | null;
  parentId: string | null;
  agent: string;
  objective: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  allowedFiles: string[];
  forbiddenFiles: string[];
  modelTier: string;
  workspaceMode: "shared-readonly" | "isolated-worktree";
  status: TaskNodeStatus;
  budget: { maxTurns: number; maxTokens: number; maxWallMs: number; maxToolCalls: number };
  report: string;
  evidence: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateTaskNodeInput {
  id: string;
  conversationId: string;
  runId?: string | null;
  parentId?: string | null;
  agent: string;
  objective: string;
  acceptanceCriteria?: string[];
  dependencies?: string[];
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  modelTier?: string;
  workspaceMode?: "shared-readonly" | "isolated-worktree";
  status?: TaskNodeStatus;
  budget?: Partial<TaskNodeRow["budget"]>;
  ts: number;
}

// ── Migrations ────────────────────────────────────────────────────────────────────────────────────
// An ordered list; index+1 is the target user_version. On open we run every migration past the current
// user_version inside one transaction. Append new migrations, never edit shipped ones.
const MIGRATIONS: string[] = [
  // v1 — the initial schema.
  `
  CREATE TABLE conversations (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    project_root  TEXT NOT NULL,
    project_id    TEXT NOT NULL,
    model         TEXT NOT NULL,
    mode          TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    archived      INTEGER NOT NULL DEFAULT 0,
    last_seq      INTEGER NOT NULL DEFAULT 0,
    search_text   TEXT NOT NULL DEFAULT '',
    schema_version INTEGER NOT NULL
  );
  CREATE INDEX idx_conversations_project ON conversations(project_id, updated_at DESC);
  CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);

  CREATE TABLE events (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    ts              INTEGER NOT NULL,
    type            TEXT NOT NULL,
    run_id          TEXT,
    payload         TEXT NOT NULL,
    schema_version  INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, seq)
  );
  CREATE INDEX idx_events_run ON events(run_id);

  CREATE TABLE runs (
    id             TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    request        TEXT NOT NULL DEFAULT '',
    lane           TEXT,
    reasons        TEXT NOT NULL DEFAULT '[]',
    k              INTEGER NOT NULL DEFAULT 1,
    status         TEXT NOT NULL,
    finished       INTEGER NOT NULL DEFAULT 0,
    winner         INTEGER,
    summary        TEXT NOT NULL DEFAULT '',
    verified       INTEGER NOT NULL DEFAULT 0,
    files_changed  TEXT NOT NULL DEFAULT '[]',
    usage          TEXT NOT NULL DEFAULT '{}',
    error          TEXT,
    started_at     INTEGER NOT NULL,
    ended_at       INTEGER,
    schema_version INTEGER NOT NULL
  );
  CREATE INDEX idx_runs_conversation ON runs(conversation_id, started_at);
  `,
  // v2 — pre-run git snapshot for /undo.
  `
  ALTER TABLE runs ADD COLUMN snapshot TEXT;
  `,
  // v3 — model identity, agent, parent links, undo tracking, provider.
  `
  ALTER TABLE runs          ADD COLUMN model TEXT;
  ALTER TABLE runs          ADD COLUMN agent TEXT;
  ALTER TABLE runs          ADD COLUMN parent_run_id TEXT;
  ALTER TABLE runs          ADD COLUMN undone INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs          ADD COLUMN snapshot_after TEXT;
  ALTER TABLE conversations ADD COLUMN provider TEXT;
  ALTER TABLE conversations ADD COLUMN agent TEXT;
  ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT;
  ALTER TABLE conversations ADD COLUMN parent_run_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_conversation_id);
  CREATE TABLE IF NOT EXISTS input_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    input TEXT NOT NULL,
    ts INTEGER NOT NULL,
    conversation_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_input_history_ts ON input_history(ts DESC);
  `,
  // v4 — durable subagent task DAG. The task table is a projection; task lifecycle events remain in
  // the parent conversation event log so the desktop client can replay the same visible history.
  `
  CREATE TABLE task_nodes (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    run_id TEXT,
    parent_id TEXT,
    agent TEXT NOT NULL,
    objective TEXT NOT NULL,
    acceptance_criteria TEXT NOT NULL DEFAULT '[]',
    dependencies TEXT NOT NULL DEFAULT '[]',
    allowed_files TEXT NOT NULL DEFAULT '[]',
    forbidden_files TEXT NOT NULL DEFAULT '[]',
    model_tier TEXT NOT NULL DEFAULT 'main',
    workspace_mode TEXT NOT NULL DEFAULT 'shared-readonly',
    status TEXT NOT NULL DEFAULT 'queued',
    budget TEXT NOT NULL DEFAULT '{}',
    report TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(parent_id) REFERENCES task_nodes(id) ON DELETE SET NULL
  );
  CREATE INDEX idx_task_nodes_conversation ON task_nodes(conversation_id, created_at);
  CREATE INDEX idx_task_nodes_parent ON task_nodes(parent_id);
  CREATE INDEX idx_task_nodes_status ON task_nodes(status);
  `,
];

/**
 * The additive safety net under the migration list.
 *
 * `user_version` is only a claim, and a store on a real machine may carry a stamp this code line never
 * wrote — an older or forked Kitten whose migration list was numbered differently. A store found at
 * `user_version` 6 with only four migrations here took the "already current" fast path while missing
 * every column v3 adds, so **every** new conversation failed with "table conversations has no column
 * named provider": the app was unusable on the very store it had been using.
 *
 * So the schema itself is checked, never just the number. Everything here is additive and idempotent —
 * missing tables and columns are created, nothing is dropped, renamed or rewritten — which makes it
 * safe to run on every open regardless of which line stamped the file.
 */
const REPAIR_TABLES: ReadonlyArray<{ table: string; ddl: string }> = [
  {
    table: "input_history",
    ddl: `
    CREATE TABLE IF NOT EXISTS input_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      input TEXT NOT NULL,
      ts INTEGER NOT NULL,
      conversation_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_input_history_ts ON input_history(ts DESC);
    `,
  },
  {
    table: "task_nodes",
    ddl: `
    CREATE TABLE IF NOT EXISTS task_nodes (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      run_id TEXT,
      parent_id TEXT,
      agent TEXT NOT NULL,
      objective TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      dependencies TEXT NOT NULL DEFAULT '[]',
      allowed_files TEXT NOT NULL DEFAULT '[]',
      forbidden_files TEXT NOT NULL DEFAULT '[]',
      model_tier TEXT NOT NULL DEFAULT 'main',
      workspace_mode TEXT NOT NULL DEFAULT 'shared-readonly',
      status TEXT NOT NULL DEFAULT 'queued',
      budget TEXT NOT NULL DEFAULT '{}',
      report TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(parent_id) REFERENCES task_nodes(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_nodes_conversation ON task_nodes(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_nodes_parent ON task_nodes(parent_id);
    CREATE INDEX IF NOT EXISTS idx_task_nodes_status ON task_nodes(status);
    `,
  },
];

/** Every column this code line reads or writes beyond the v1 tables. */
const REPAIR_COLUMNS: ReadonlyArray<{ table: string; column: string; type: string }> = [
  { table: "runs", column: "snapshot", type: "TEXT" },
  { table: "runs", column: "model", type: "TEXT" },
  { table: "runs", column: "agent", type: "TEXT" },
  { table: "runs", column: "parent_run_id", type: "TEXT" },
  { table: "runs", column: "undone", type: "INTEGER NOT NULL DEFAULT 0" },
  { table: "runs", column: "snapshot_after", type: "TEXT" },
  { table: "conversations", column: "provider", type: "TEXT" },
  { table: "conversations", column: "agent", type: "TEXT" },
  { table: "conversations", column: "parent_conversation_id", type: "TEXT" },
  { table: "conversations", column: "parent_run_id", type: "TEXT" },
];

function tableNames(db: SqlDatabase): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function columnNames(db: SqlDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** What this store is missing, as executable additive statements. Read-only: takes no write lock. */
export function pendingRepairs(db: SqlDatabase): Array<{ label: string; sql: string }> {
  const pending: Array<{ label: string; sql: string }> = [];
  const tables = tableNames(db);
  if (!tables.has("conversations")) return pending; // an empty file: the migrations own it
  for (const { table, ddl } of REPAIR_TABLES) {
    if (!tables.has(table)) pending.push({ label: `created table ${table}`, sql: ddl });
  }
  for (const { table, column, type } of REPAIR_COLUMNS) {
    if (!tables.has(table) || columnNames(db, table).has(column)) continue;
    pending.push({ label: `added ${table}.${column}`, sql: `ALTER TABLE ${table} ADD COLUMN ${column} ${type}` });
  }
  return pending;
}

/** Apply the additive repairs. Returns what it did, so a caller can surface the reconciliation. */
export function reconcileSchema(db: SqlDatabase): string[] {
  const pending = pendingRepairs(db);
  for (const repair of pending) db.exec(repair.sql);
  return pending.map((repair) => repair.label);
}

function migrate(db: SqlDatabase): void {
  if (userVersion(db) >= MIGRATIONS.length) {
    // The stamp says current — verify it, because a foreign stamp is exactly how a store ends up
    // "current" without the columns. The check is read-only, so the common case still takes no write
    // lock; only an actually-drifted store is repaired, additively, under a transaction.
    if (!pendingRepairs(db).length) return;
    const repaired = transact(db, () => reconcileSchema(db));
    if (repaired.length) process.emitWarning(`kitten store schema reconciled: ${repaired.join(", ")}`);
    return;
  }
  // Read the version, apply migrations, AND bump the version all inside ONE BEGIN IMMEDIATE. This store
  // is explicitly opened by two processes (a TUI and a web client on the same file), so a concurrent
  // first-open must not double-migrate: BEGIN IMMEDIATE serializes them, and the loser re-reads the
  // bumped version inside the lock and finds nothing to do (rather than re-running CREATE TABLE →
  // "table already exists"). Setting the version in the SAME transaction also makes a crash atomic —
  // it can never leave committed tables with a stale user_version.
  transact(db, () => {
    const from = userVersion(db);
    if (from >= MIGRATIONS.length) { reconcileSchema(db); return; } // another process migrated while we waited
    for (let v = from; v < MIGRATIONS.length; v++) db.exec(MIGRATIONS[v]);
    setUserVersion(db, MIGRATIONS.length);
    // A partially-migrated store from another line can leave this list with nothing to do for a
    // version it never actually applied; reconcile before anyone reads or writes a row.
    reconcileSchema(db);
  });
}

// ── Store ────────────────────────────────────────────────────────────────────────────────────────

export class ConversationStore {
  private readonly db: SqlDatabase;

  /** Wrap an already-open db (tests inject ":memory:") and run migrations. */
  constructor(db: SqlDatabase) {
    this.db = db;
    migrate(db);
  }

  /** Open (or create) a file-backed store at `path` and migrate it. */
  static open(path: string): ConversationStore {
    return new ConversationStore(openSqlite(path));
  }

  close(): void {
    this.db.close();
  }

  // ── Conversations ────────────────────────────────────────────────────────────────────────────
  /** Insert a conversation and append its `conversation.created` event atomically. */
  createConversation(input: CreateConversationInput): { conversation: ConversationRow; event: KittenEvent } {
    return transact(this.db, () => {
      this.db.prepare(
        `INSERT INTO conversations (id, title, project_root, project_id, model, mode, created_at, updated_at, archived, last_seq, search_text, schema_version, provider, agent, parent_conversation_id, parent_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.id, input.title, input.projectRoot, input.projectId, input.model, input.mode,
        input.ts, input.ts, input.title.toLowerCase(), EVENT_SCHEMA_VERSION, input.provider ?? null, input.agent ?? null, input.parentConversationId ?? null, input.parentRunId ?? null
      );
      const event = this._append(input.id, {
        type: "conversation.created", title: input.title, projectRoot: input.projectRoot,
        projectId: input.projectId, model: input.model, mode: input.mode,
      }, input.ts);
      return { conversation: this.getConversation(input.id)!, event };
    });
  }

  getConversation(id: string): ConversationRow | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
    return row ? mapConversation(row) : null;
  }

  listConversations(opts: ListConversationsOptions = {}): ConversationRow[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (opts.projectId) { where.push("project_id = ?"); params.push(opts.projectId); }
    if (!opts.includeArchived) where.push("archived = 0");
    if (opts.search) { where.push("search_text LIKE ?"); params.push(`%${opts.search.toLowerCase()}%`); }
    const sqlText =
      `SELECT * FROM conversations ${where.length ? "WHERE " + where.join(" AND ") : ""} ` +
      `ORDER BY updated_at DESC LIMIT ?`;
    params.push(Math.max(1, Math.min(1000, opts.limit ?? 100)));
    return this.db.prepare(sqlText).all(...params).map(mapConversation);
  }

  /** Child conversations form the durable lineage tree used for subagent cancellation. */
  listChildConversations(parentConversationId: string): ConversationRow[] {
    return this.db.prepare("SELECT * FROM conversations WHERE parent_conversation_id = ? ORDER BY created_at ASC").all(parentConversationId).map(mapConversation);
  }

  renameConversation(id: string, title: string, ts: number): KittenEvent | null {
    if (!this.getConversation(id)) return null;
    return transact(this.db, () => {
      this.db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(title, ts, id);
      return this._append(id, { type: "conversation.renamed", title }, ts);
    });
  }

  setArchived(id: string, archived: boolean, ts: number): KittenEvent | null {
    if (!this.getConversation(id)) return null;
    return transact(this.db, () => {
      this.db.prepare("UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?").run(archived ? 1 : 0, ts, id);
      return this._append(id, { type: "conversation.archived", archived }, ts);
    });
  }

  // ── Events ────────────────────────────────────────────────────────────────────────────────────
  /** Append an event, assigning the next per-conversation seq. Transactional; returns the full event. */
  appendEvent(conversationId: string, payload: EventPayload, ts: number): KittenEvent {
    return transact(this.db, () => this._append(conversationId, payload, ts));
  }

  /** Read events in order. `afterSeq` (default 0) enables incremental replay/reconnect (Goal §7). */
  readEvents(conversationId: string, afterSeq = 0): KittenEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC")
      .all(conversationId, afterSeq)
      .map(mapEvent);
  }

  /** Internal: the actual append. MUST run inside a transaction (callers wrap it). Updates the
   *  conversation aggregate and the run projection from the same event, so they never drift. */
  private _append(conversationId: string, payload: EventPayload, ts: number): KittenEvent {
    const conv = this.db.prepare("SELECT last_seq FROM conversations WHERE id = ?").get(conversationId);
    if (!conv) throw new Error(`appendEvent: unknown conversation ${conversationId}`);
    const seq = Number(conv.last_seq) + 1;
    const runId = eventRunId(payload) ?? null;
    this.db.prepare(
      "INSERT INTO events (conversation_id, seq, ts, type, run_id, payload, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(conversationId, seq, ts, payload.type, runId, JSON.stringify(payload), EVENT_SCHEMA_VERSION);

    // Conversation aggregate: bump seq + updated_at, and fold human text into the search index.
    let searchAdd = "";
    if (payload.type === "user.message") searchAdd = payload.text;
    else if (payload.type === "assistant.final") searchAdd = payload.text;
    if (searchAdd) {
      // Keep the NEWEST 20000 chars (negative substr counts from the right). `1, 20000` kept the OLDEST
      // instead, so once a long conversation filled the index every later message fell past position
      // 20000 and became unsearchable. The full text is retained in the event log; this is just the index.
      this.db.prepare(
        "UPDATE conversations SET last_seq = ?, updated_at = ?, search_text = substr(search_text || ' ' || ?, -20000) WHERE id = ?"
      ).run(seq, ts, searchAdd.toLowerCase(), conversationId);
    } else {
      this.db.prepare("UPDATE conversations SET last_seq = ?, updated_at = ? WHERE id = ?").run(seq, ts, conversationId);
    }

    this._applyRunProjection(conversationId, payload, ts);
    return { id: eventId(conversationId, seq), conversationId, seq, ts, schemaVersion: EVENT_SCHEMA_VERSION, ...payload };
  }

  /** Keep the `runs` row in sync with run-lifecycle events. */
  private _applyRunProjection(conversationId: string, payload: EventPayload, ts: number): void {
    const runId = eventRunId(payload);
    if (!runId) return;
    const ensure = (): void => {
      const exists = this.db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId);
      if (!exists) {
        this.db.prepare(
          "INSERT INTO runs (id, conversation_id, status, started_at, schema_version) VALUES (?, ?, 'queued', ?, ?)"
        ).run(runId, conversationId, ts, EVENT_SCHEMA_VERSION);
      }
    };
    const set = (cols: string, ...vals: SqlValue[]): void => {
      this.db.prepare(`UPDATE runs SET ${cols} WHERE id = ?`).run(...vals, runId);
    };
    switch (payload.type) {
      case "route.selected":
        ensure();
        set("lane = ?, reasons = ?, k = ?", payload.lane, JSON.stringify(payload.reasons), payload.k);
        break;
      case "run.started":
        ensure();
        set("request = ?, lane = ?, status = 'running', started_at = ?, model = ?", payload.request, payload.lane, ts, payload.model ?? null);
        break;
      case "run.status":
        ensure();
        set("status = ?", payload.status);
        break;
      case "file.changed": {
        ensure();
        const row = this.db.prepare("SELECT files_changed FROM runs WHERE id = ?").get(runId);
        const files: string[] = row ? safeJsonArray(row.files_changed) : [];
        if (!files.includes(payload.path)) files.push(payload.path);
        set("files_changed = ?", JSON.stringify(files));
        break;
      }
      case "receipt.finalized":
        ensure();
        set("verified = ?, files_changed = ?", payload.verified ? 1 : 0, JSON.stringify(payload.filesChanged));
        break;
      case "run.completed":
        ensure();
        set(
          "status = 'completed', finished = ?, verified = ?, summary = ?, usage = ?, ended_at = ?, model = ?",
          payload.finished ? 1 : 0, payload.verified ? 1 : 0, payload.summary, JSON.stringify(payload.usage), ts, payload.model ?? null
        );
        break;
      case "run.failed":
        ensure();
        set("status = 'failed', error = ?, ended_at = ?", payload.error, ts);
        break;
      case "run.cancelled":
        ensure();
        set("status = 'cancelled', ended_at = ?", ts);
        break;
      case "run.interrupted":
        ensure();
        set("status = 'interrupted', ended_at = ?", ts);
        break;
      default:
        break; // other run events (assistant/tool/candidate/verification/...) don't change the projection
    }
  }

  // ── Runs ──────────────────────────────────────────────────────────────────────────────────────
  getRun(id: string): RunRow | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? mapRun(row) : null;
  }

  /** Record the pre-run snapshot used by /undo. No-op if the run row doesn't exist yet. */
  setRunSnapshot(runId: string, snapshotJson: string): void {
    this.db.prepare("UPDATE runs SET snapshot = ? WHERE id = ?").run(snapshotJson, runId);
  }

  setRunSnapshotAfter(runId: string, snapshotJson: string): void {
    this.db.prepare("UPDATE runs SET snapshot_after = ? WHERE id = ?").run(snapshotJson, runId);
  }

  setRunUndone(runId: string, undone: boolean): void {
    this.db.prepare("UPDATE runs SET undone = ? WHERE id = ?").run(undone ? 1 : 0, runId);
  }

  listRuns(conversationId: string): RunRow[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE conversation_id = ? ORDER BY started_at ASC")
      .all(conversationId)
      .map(mapRun);
  }

  createTaskNode(input: CreateTaskNodeInput): TaskNodeRow {
    const budget = { maxTurns: 12, maxTokens: 12000, maxWallMs: 900_000, maxToolCalls: 40, ...(input.budget ?? {}) };
    this.db.prepare(
      `INSERT INTO task_nodes (id, conversation_id, run_id, parent_id, agent, objective, acceptance_criteria,
       dependencies, allowed_files, forbidden_files, model_tier, workspace_mode, status, budget, report, evidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '[]', ?, ?)`
    ).run(
      input.id, input.conversationId, input.runId ?? null, input.parentId ?? null, input.agent, input.objective.slice(0, 4000),
      JSON.stringify((input.acceptanceCriteria ?? []).slice(0, 32)), JSON.stringify((input.dependencies ?? []).slice(0, 32)),
      JSON.stringify((input.allowedFiles ?? []).slice(0, 64)), JSON.stringify((input.forbiddenFiles ?? []).slice(0, 64)),
      input.modelTier ?? "main", input.workspaceMode ?? "shared-readonly", input.status ?? "queued", JSON.stringify(budget), input.ts, input.ts
    );
    return this.getTaskNode(input.id)!;
  }

  getTaskNode(id: string): TaskNodeRow | null {
    const row = this.db.prepare("SELECT * FROM task_nodes WHERE id = ?").get(id);
    return row ? mapTaskNode(row) : null;
  }

  listTaskNodes(conversationId: string): TaskNodeRow[] {
    return this.db.prepare("SELECT * FROM task_nodes WHERE conversation_id = ? ORDER BY created_at ASC").all(conversationId).map(mapTaskNode);
  }

  updateTaskNode(id: string, update: { status?: TaskNodeStatus; report?: string; evidence?: string[]; runId?: string | null; ts: number }): TaskNodeRow | null {
    const current = this.getTaskNode(id);
    if (!current) return null;
    const status = update.status ?? current.status;
    const report = update.report ?? current.report;
    const evidence = update.evidence ?? current.evidence;
    this.db.prepare("UPDATE task_nodes SET status = ?, report = ?, evidence = ?, run_id = ?, updated_at = ? WHERE id = ?")
      .run(status, report.slice(0, 12000), JSON.stringify(evidence.slice(0, 64)), update.runId === undefined ? current.runId : update.runId, update.ts, id);
    return this.getTaskNode(id);
  }

  /**
   * Crash recovery (Goal §6): any run left in a transient state at startup was interrupted by a
   * crash/close. Flip each to `interrupted` and append a `run.interrupted` event so the history
   * reflects it — a UI must never show these as still running. Returns the appended events.
   */
  recoverInterruptedRuns(now: number): KittenEvent[] {
    const stuck = this.db
      .prepare("SELECT id, conversation_id, status FROM runs WHERE status IN ('queued','running','waiting_approval','cancelling')")
      .all();
    const events: KittenEvent[] = [];
    for (const r of stuck) {
      const runId = String(r.id);
      const conversationId = String(r.conversation_id);
      const fromStatus = String(r.status) as RunStatus;
      events.push(this.appendEvent(conversationId, { type: "run.interrupted", runId, fromStatus }, now));
    }
    return events;
  }
}

// ── Row mapping ──────────────────────────────────────────────────────────────────────────────────

function mapConversation(r: Record<string, SqlValue>): ConversationRow {
  return {
    id: String(r.id),
    title: String(r.title),
    projectRoot: String(r.project_root),
    projectId: String(r.project_id),
    model: String(r.model),
    mode: String(r.mode) as Lane | "auto",
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    archived: Number(r.archived) !== 0,
    lastSeq: Number(r.last_seq),
    provider: r.provider != null ? String(r.provider) : null,
    agent: r.agent != null ? String(r.agent) : null,
    parentConversationId: r.parent_conversation_id != null ? String(r.parent_conversation_id) : null,
    parentRunId: r.parent_run_id != null ? String(r.parent_run_id) : null,
  };
}

function mapRun(r: Record<string, SqlValue>): RunRow {
  return {
    id: String(r.id),
    conversationId: String(r.conversation_id),
    request: String(r.request ?? ""),
    lane: r.lane != null ? (String(r.lane) as Lane) : null,
    reasons: safeJsonArray(r.reasons),
    k: Number(r.k ?? 1),
    status: String(r.status) as RunStatus,
    finished: Number(r.finished) !== 0,
    winner: r.winner != null ? Number(r.winner) : null,
    summary: String(r.summary ?? ""),
    verified: Number(r.verified) !== 0,
    filesChanged: safeJsonArray(r.files_changed),
    usage: safeUsage(r.usage),
    error: r.error != null ? String(r.error) : null,
    startedAt: Number(r.started_at),
    endedAt: r.ended_at != null ? Number(r.ended_at) : null,
    snapshot: r.snapshot != null ? String(r.snapshot) : null,
    model: r.model != null ? String(r.model) : null,
    agent: r.agent != null ? String(r.agent) : null,
    parentRunId: r.parent_run_id != null ? String(r.parent_run_id) : null,
    undone: Number(r.undone ?? 0) !== 0,
    snapshotAfter: r.snapshot_after != null ? String(r.snapshot_after) : null,
  };
}

function mapTaskNode(r: Record<string, SqlValue>): TaskNodeRow {
  return {
    id: String(r.id), conversationId: String(r.conversation_id), runId: r.run_id == null ? null : String(r.run_id),
    parentId: r.parent_id == null ? null : String(r.parent_id), agent: String(r.agent), objective: String(r.objective),
    acceptanceCriteria: safeJsonArray(r.acceptance_criteria), dependencies: safeJsonArray(r.dependencies),
    allowedFiles: safeJsonArray(r.allowed_files), forbiddenFiles: safeJsonArray(r.forbidden_files), modelTier: String(r.model_tier),
    workspaceMode: String(r.workspace_mode) === "isolated-worktree" ? "isolated-worktree" : "shared-readonly",
    status: String(r.status) as TaskNodeStatus, budget: safeBudget(r.budget), report: String(r.report ?? ""), evidence: safeJsonArray(r.evidence),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

function mapEvent(r: Record<string, SqlValue>): KittenEvent {
  const payload = JSON.parse(String(r.payload)) as EventPayload;
  const conversationId = String(r.conversation_id);
  const seq = Number(r.seq);
  return { id: eventId(conversationId, seq), conversationId, seq, ts: Number(r.ts), schemaVersion: Number(r.schema_version), ...payload };
}

function safeJsonArray(v: SqlValue): string[] {
  try { const a = JSON.parse(String(v ?? "[]")); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}
function safeUsage(v: SqlValue): { prompt: number; completion: number; reasoning: number } {
  try {
    const u = JSON.parse(String(v ?? "{}"));
    return { prompt: Number(u.prompt ?? 0), completion: Number(u.completion ?? 0), reasoning: Number(u.reasoning ?? 0) };
  } catch { return { prompt: 0, completion: 0, reasoning: 0 }; }
}
function safeBudget(v: SqlValue): TaskNodeRow["budget"] {
  try {
    const b = JSON.parse(String(v ?? "{}"));
    return { maxTurns: Number(b.maxTurns ?? 12), maxTokens: Number(b.maxTokens ?? 12000), maxWallMs: Number(b.maxWallMs ?? 900_000), maxToolCalls: Number(b.maxToolCalls ?? 40) };
  } catch { return { maxTurns: 12, maxTokens: 12000, maxWallMs: 900_000, maxToolCalls: 40 }; }
}
