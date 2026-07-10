// Kitten Core — the SQL adapter. NO Pi.
//
// A deliberately tiny port over a synchronous SQLite driver so the store code below never touches the
// concrete engine. We back it with Node's built-in `node:sqlite` (DatabaseSync): real SQLite —
// transactions, WAL, SQL queries, migrations — with ZERO native-module install friction (no node-gyp,
// no prebuild matrix), which is exactly what a local-first, cleanly-packageable product needs
// (Goal §6/§11). The engine is confined to `openSqlite`; swapping to better-sqlite3 later touches only
// this file because both expose the same prepare/run/get/all sync surface.
//
// node:sqlite is a stable-enough experimental API on Node >= 22.5; we pin the engine there.

import { createRequire } from "node:module";

// `require` is not defined in ESM; bind one to this module's URL so we can load the `node:sqlite`
// builtin lazily (deferring its experimental warning until a store is actually opened).
const require = createRequire(import.meta.url);

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): Record<string, SqlValue> | undefined;
  all(...params: SqlValue[]): Record<string, SqlValue>[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

/** Coerce a JS value into something the SQLite driver accepts (undefined→null, boolean→0/1). */
export function sql(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
  if (v instanceof Uint8Array) return v;
  // Objects/arrays are stored as JSON by the caller; anything else is stringified defensively.
  return String(v);
}

/**
 * Open a SQLite database at `path` (or ":memory:" for an isolated in-memory store — used by tests).
 * Enables WAL + foreign keys + a busy timeout so a TUI and web client observing the same file cannot
 * corrupt each other's writes. Never throws lazily: a bad path fails here, loudly, at open.
 */
export function openSqlite(path: string): SqlDatabase {
  // Silence BEFORE requiring node:sqlite: the experimental warning can fire during module load, not only
  // on `new DatabaseSync`. Lazy require keeps the import cheap and surfaces a clear error if unavailable.
  silenceSqliteExperimentalWarning();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(path);
  // Pragmas: WAL for concurrent readers, NORMAL sync (durable enough for a local app, far faster than
  // FULL), a 5s busy timeout, and enforced foreign keys. :memory: ignores journal_mode — harmless.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db as unknown as SqlDatabase;
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: unknown) => SqlDatabase;
}

function loadNodeSqlite(): NodeSqliteModule {
  try {
    // node:sqlite is a builtin; require works under NodeNext for builtins.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("node:sqlite") as NodeSqliteModule;
    if (!mod?.DatabaseSync) throw new Error("node:sqlite present but DatabaseSync missing");
    return mod;
  } catch (e) {
    throw new Error(
      `Kitten needs Node's built-in SQLite (node:sqlite). Upgrade to Node >= 22.5 (you have ${process.version}). ` +
      `Underlying error: ${(e as Error).message}`
    );
  }
}

// node:sqlite emits a one-time "SQLite is an experimental feature" ExperimentalWarning on first use.
// That is expected here (we pin the engine deliberately) and looks alarming to a user running `kitten`,
// so swallow exactly that one message. Every OTHER warning — including other ExperimentalWarnings —
// passes through untouched. Installed once, before the first DatabaseSync.
let sqliteWarningSilenced = false;
function silenceSqliteExperimentalWarning(): void {
  if (sqliteWarningSilenced) return;
  sqliteWarningSilenced = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
    const message = typeof warning === "string" ? warning : warning?.message ?? "";
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === "ExperimentalWarning" && /\bSQLite is an experimental feature\b/.test(message)) return;
    (original as (w: string | Error, ...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

/** Run `fn` inside a single transaction, rolling back on any throw. Returns fn's result. */
export function transact<T>(db: SqlDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const out = fn();
    db.exec("COMMIT;");
    return out;
  } catch (e) {
    try { db.exec("ROLLBACK;"); } catch { /* already rolled back */ }
    throw e;
  }
}

/** Read the SQLite schema version (PRAGMA user_version). */
export function userVersion(db: SqlDatabase): number {
  const row = db.prepare("PRAGMA user_version;").get();
  const v = row ? Object.values(row)[0] : 0;
  return typeof v === "number" ? v : Number(v ?? 0);
}

/** Set the SQLite schema version. Value is inlined (PRAGMA cannot bind a parameter). */
export function setUserVersion(db: SqlDatabase, v: number): void {
  db.exec(`PRAGMA user_version = ${Math.floor(v)};`);
}
