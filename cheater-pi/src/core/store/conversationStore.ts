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
}

export interface CreateConversationInput {
  id: string;
  title: string;
  projectRoot: string;
  projectId: string;
  model: string;
  mode: Lane | "auto";
  ts: number;
}

export interface ListConversationsOptions {
  projectId?: string;
  includeArchived?: boolean;
  search?: string;
  limit?: number;
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
];

function migrate(db: SqlDatabase): void {
  const from = userVersion(db);
  if (from >= MIGRATIONS.length) return;
  transact(db, () => {
    for (let v = from; v < MIGRATIONS.length; v++) db.exec(MIGRATIONS[v]);
  });
  setUserVersion(db, MIGRATIONS.length);
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
        `INSERT INTO conversations (id, title, project_root, project_id, model, mode, created_at, updated_at, archived, last_seq, search_text, schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
      ).run(
        input.id, input.title, input.projectRoot, input.projectId, input.model, input.mode,
        input.ts, input.ts, input.title.toLowerCase(), EVENT_SCHEMA_VERSION
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
      this.db.prepare(
        "UPDATE conversations SET last_seq = ?, updated_at = ?, search_text = substr(search_text || ' ' || ?, 1, 20000) WHERE id = ?"
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
        set("request = ?, lane = ?, status = 'running', started_at = ?", payload.request, payload.lane, ts);
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
          "status = 'completed', finished = ?, summary = ?, usage = ?, ended_at = ?",
          payload.finished ? 1 : 0, payload.summary, JSON.stringify(payload.usage), ts
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

  listRuns(conversationId: string): RunRow[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE conversation_id = ? ORDER BY started_at ASC")
      .all(conversationId)
      .map(mapRun);
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
