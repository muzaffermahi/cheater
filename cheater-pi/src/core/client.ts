// Kitten Core — client abstraction for local/remote app access. NO Pi.
//
// KittenClient wraps both local and remote access behind async methods.

import type { KittenApp, ApprovalPolicy, SubmitOptions } from "./app.js";
import type { ConversationStore, ConversationRow, RunRow } from "./store/conversationStore.js";
import type { KittenEvent, Lane } from "./events.js";

export interface KittenClient {
  createConversation(input?: { title?: string; projectRoot?: string; model?: string; mode?: Lane | "auto" }): Promise<ConversationRow>;
  getConversation(id: string): Promise<ConversationRow | null>;
  listConversations(opts?: { projectId?: string; includeArchived?: boolean; search?: string; limit?: number }): Promise<ConversationRow[]>;
  getEvents(id: string, afterSeq?: number): Promise<KittenEvent[]>;
  getRuns(id: string): Promise<RunRow[]>;
  rename(id: string, title: string): Promise<void>;
  archive(id: string, archived?: boolean): Promise<void>;
  submitMessage(conversationId: string, text: string, opts?: SubmitOptions): Promise<RunRow>;
  cancel(runId: string): boolean;
  resolveApproval(runId: string, callId: string, allowed: boolean): boolean;
  undoLast(conversationId: string): Promise<{ ok: boolean; restored: string[]; deleted: string[]; skipped: string[]; reason?: string }>;
  setApprovalPolicy(policy: ApprovalPolicy): void;
  subscribe(fn: (event: KittenEvent) => void): () => void;
  recover(): KittenEvent[];
  close(): void;
  streamConversation?(conversationId: string, afterSeq?: number): void;
}

export class LocalClient implements KittenClient {
  constructor(private app: KittenApp) {}
  async createConversation(input?: { title?: string; projectRoot?: string; model?: string; mode?: Lane | "auto" }): Promise<ConversationRow> {
    return this.app.createConversation(input);
  }
  async getConversation(id: string): Promise<ConversationRow | null> { return this.app.getConversation(id); }
  async listConversations(opts?: { projectId?: string; includeArchived?: boolean; search?: string; limit?: number }): Promise<ConversationRow[]> { return this.app.listConversations(opts); }
  async getEvents(id: string, afterSeq?: number): Promise<KittenEvent[]> { return this.app.getEvents(id, afterSeq); }
  async getRuns(id: string): Promise<RunRow[]> { return this.app.getRuns(id); }
  async rename(id: string, title: string): Promise<void> { this.app.rename(id, title); }
  async archive(id: string, archived?: boolean): Promise<void> { this.app.archive(id, archived); }
  async submitMessage(conversationId: string, text: string, opts?: SubmitOptions): Promise<RunRow> { return this.app.submitMessage(conversationId, text, opts); }
  cancel(runId: string): boolean { return this.app.cancel(runId); }
  resolveApproval(runId: string, callId: string, allowed: boolean): boolean { return this.app.resolveApproval(runId, callId, allowed); }
  async undoLast(conversationId: string): Promise<{ ok: boolean; restored: string[]; deleted: string[]; skipped: string[]; reason?: string }> { return this.app.undoLast(conversationId); }
  setApprovalPolicy(policy: ApprovalPolicy): void { this.app.setApprovalPolicy(policy); }
  subscribe(fn: (event: KittenEvent) => void): () => void { return this.app.subscribe(fn); }
  recover(): KittenEvent[] { return this.app.recover(); }
  close(): void { this.app.close(); }
}

export interface RemoteClientOptions {
  url: string;
  token: string;
}

export class RemoteClient implements KittenClient {
  private listeners = new Set<(event: KittenEvent) => void>();
  private activeStreams = new Map<string, EventSource>();

  constructor(private opts: RemoteClientOptions) {}

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.opts.url}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-kitten-token": this.opts.token },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) { const err = await res.text().catch(() => ""); throw new Error(`API ${method} ${path}: ${res.status} ${err.slice(0, 200)}`); }
    return res.json();
  }

  async createConversation(input?: { title?: string; projectRoot?: string; model?: string; mode?: Lane | "auto" }): Promise<ConversationRow> {
    const r = await this.api("POST", "/api/conversations", input ?? {});
    return r.conversation;
  }
  async getConversation(id: string): Promise<ConversationRow | null> {
    try { const r = await this.api("GET", `/api/conversations/${id}`); return r.conversation; } catch { return null; }
  }
  async listConversations(opts?: { projectId?: string; includeArchived?: boolean; search?: string; limit?: number }): Promise<ConversationRow[]> {
    const params = new URLSearchParams();
    if (opts?.search) params.set("search", opts.search);
    if (opts?.includeArchived) params.set("includeArchived", "1");
    if (opts?.limit) params.set("limit", String(opts.limit));
    const r = await this.api("GET", `/api/conversations?${params}`);
    return r.conversations;
  }
  async getEvents(id: string, afterSeq?: number): Promise<KittenEvent[]> {
    const r = await this.api("GET", `/api/conversations/${id}`);
    return r.events;
  }
  async getRuns(id: string): Promise<RunRow[]> {
    const r = await this.api("GET", `/api/conversations/${id}`);
    return r.runs;
  }
  async rename(id: string, title: string): Promise<void> { await this.api("POST", "/api/rename", { conversationId: id, title }); }
  async archive(id: string, archived = true): Promise<void> { await this.api("POST", "/api/archive", { conversationId: id, archived }); }
  async submitMessage(conversationId: string, text: string, opts?: SubmitOptions): Promise<RunRow> {
    await this.api("POST", "/api/message", { conversationId, text, lane: opts?.lane, k: opts?.k });
    return {} as RunRow;
  }
  cancel(runId: string): boolean { this.api("POST", "/api/cancel", { runId }).catch(() => {}); return true; }
  resolveApproval(runId: string, callId: string, allowed: boolean): boolean {
    this.api("POST", "/api/approve", { runId, callId, allowed }).catch(() => {});
    return true;
  }
  async undoLast(conversationId: string): Promise<{ ok: boolean; restored: string[]; deleted: string[]; skipped: string[]; reason?: string }> {
    const r = await this.api("POST", "/api/undo", { conversationId });
    return r.result;
  }
  setApprovalPolicy(_policy: ApprovalPolicy): void { /* remote approval policy controlled by the daemon */ }
  subscribe(fn: (event: KittenEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  recover(): KittenEvent[] { return []; }
  close(): void { for (const s of this.activeStreams.values()) s.close(); this.activeStreams.clear(); }

  streamConversation(conversationId: string, afterSeq = 0): void {
    const existing = this.activeStreams.get(conversationId);
    if (existing) existing.close();
    const url = `${this.opts.url}/api/stream?conversation=${encodeURIComponent(conversationId)}&token=${encodeURIComponent(this.opts.token)}&after=${afterSeq}`;
    const es = new EventSource(url);
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as KittenEvent;
        for (const fn of this.listeners) { try { fn(event); } catch { /* ignore */ } }
      } catch { /* skip malformed */ }
    };
    es.onerror = () => { /* connection lost; remote client will reconnect on next action */ };
    this.activeStreams.set(conversationId, es);
  }
}
