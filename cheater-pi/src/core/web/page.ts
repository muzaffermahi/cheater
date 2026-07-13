// Kitten Core — the self-contained local web UI document. NO Pi, NO build step, NO network.
//
// `renderPage(init)` returns ONE complete HTML document (inline CSS + inline vanilla JS) for the
// Kitten browser client: start/continue/interrupt/approve/inspect/resume coding sessions. The page
// renders the single canonical event model (core/events.ts) — it never invents its own state machine,
// it drives the same mascot from the same events as the TUI, and it treats ALL model/tool text as
// data (escaped via textContent/createElement, never innerHTML).
//
// Wire contract (every /api/* call sends header `x-kitten-token`; the SSE stream, which cannot set
// headers, takes the token as a query param):
//   GET  /api/conversations?search=      -> { conversations: [...] }
//   POST /api/conversations {title?}     -> { conversation }
//   GET  /api/conversations/:id          -> { conversation, events, runs }
//   POST /api/message {conversationId,text} -> { ok:true }   (run streams over SSE)
//   POST /api/cancel {runId}             -> { ok }
//   POST /api/approve {runId,callId,allowed} -> { ok }
//   POST /api/undo {conversationId}      -> { result }
//   POST /api/rename {conversationId,title}  -> { ok }
//   POST /api/archive {conversationId,archived} -> { ok }
//   GET  /api/diff?conversation=         -> { diff }
//   GET  /api/stream?conversation=&after=&token=  -> text/event-stream (id: seq, data: KittenEvent)
//
// IMPLEMENTATION NOTE: the browser <script> below is authored inside a TS template literal, so it
// deliberately contains NO backtick, NO backslash, and NO `${` sequence — special characters are
// produced at runtime via String.fromCharCode (newline/carriage-return/backtick) and all strings are
// built by concatenation. Keep that discipline when editing, or `tsc` will mis-parse the template.

/** Everything the page needs, injected once as `window.KITTEN`. */
export interface PageInit {
  /** Per-launch secret; the page sends it as header `x-kitten-token` on every /api call. */
  token: string;
  /** 8 mascot states -> a 2D grid of "#rrggbb" (or "" transparent). Keys:
   *  ready thinking working sampling verifying success blocked sleeping. */
  mascot: Record<string, string[][]>;
  /** The project root the server was launched in (shown in the sidebar footer). */
  cwd: string;
  /** Kitten version string (shown in the sidebar footer). */
  version: string;
}

/**
 * Render the complete Kitten web UI as a single self-contained HTML string. `init` is JSON-encoded
 * into `window.KITTEN` with `</` escaped to `<\/` so a stray `</script>` in a value cannot close the
 * injection script early.
 */
export function renderPage(init: PageInit): string {
  const dataScript = JSON.stringify(init).replace(/<\//g, "<\\/");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="color-scheme" content="dark light">',
    '<meta name="referrer" content="no-referrer">',
    "<title>Kitten</title>",
    "<style>" + CSS + "</style>",
    "<script>window.KITTEN = " + dataScript + ";</script>",
    "</head>",
    "<body>",
    BODY,
    "<script>" + SCRIPT + "</script>",
    "</body></html>",
  ].join("");
}

// ── Styles ─────────────────────────────────────────────────────────────────────────────────────────
// Warm, playful cat identity (Kitten's own look — not an imitation of any product). Dark by default;
// light via prefers-color-scheme in auto mode and via an explicit [data-theme] override from the
// theme toggle. Honors prefers-reduced-motion.
const CSS = `
:root{
  color-scheme: dark;
  --bg:#1b1613; --bg-1:#231b17; --bg-2:#2c221d; --panel:#20181400; --panel-solid:#201814;
  --border:#3b2e26; --border-2:#4a3a30;
  --text:#f5ebe4; --muted:#c4b2a6; --faint:#938175;
  --accent:#ff8f5e; --accent-2:#ffd071; --accent-ink:#2a160c;
  --ok:#6fce7f; --ok-bg:#173622; --ok-border:#2b5a38;
  --warn:#f5b544; --warn-bg:#382a12; --warn-border:#5a4620;
  --danger:#ff7a7a; --danger-bg:#391818; --danger-border:#5e2a2a;
  --user-bg:#33232c; --user-border:#4d3341;
  --code-bg:#140f0c; --chip:#2c221d;
  --shadow: rgba(0,0,0,.38);
  --px:5px; --side-w:280px; --radius:14px;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "Cascadia Code", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: light){
  :root:not([data-theme]){
    color-scheme: light;
    --bg:#fbf3ec; --bg-1:#fff8f2; --bg-2:#ffffff; --panel-solid:#fff8f2;
    --border:#ecdccd; --border-2:#e0cbb8;
    --text:#2d211a; --muted:#6f5d51; --faint:#9a887c;
    --accent:#e5622c; --accent-2:#cf951f; --accent-ink:#fff6ee;
    --ok:#2f9e56; --ok-bg:#e4f4e8; --ok-border:#bfe3c8;
    --warn:#b17715; --warn-bg:#f8ecd2; --warn-border:#e9d3a2;
    --danger:#c73b3b; --danger-bg:#f9e2e2; --danger-border:#eec4c4;
    --user-bg:#f4e7ef; --user-border:#e7cddc;
    --code-bg:#f4ece4; --chip:#f1e6db;
    --shadow: rgba(120,80,50,.14);
  }
}
:root[data-theme="light"]{
  color-scheme: light;
  --bg:#fbf3ec; --bg-1:#fff8f2; --bg-2:#ffffff; --panel-solid:#fff8f2;
  --border:#ecdccd; --border-2:#e0cbb8;
  --text:#2d211a; --muted:#6f5d51; --faint:#9a887c;
  --accent:#e5622c; --accent-2:#cf951f; --accent-ink:#fff6ee;
  --ok:#2f9e56; --ok-bg:#e4f4e8; --ok-border:#bfe3c8;
  --warn:#b17715; --warn-bg:#f8ecd2; --warn-border:#e9d3a2;
  --danger:#c73b3b; --danger-bg:#f9e2e2; --danger-border:#eec4c4;
  --user-bg:#f4e7ef; --user-border:#e7cddc;
  --code-bg:#f4ece4; --chip:#f1e6db;
  --shadow: rgba(120,80,50,.14);
}
*{ box-sizing:border-box; }
html,body{ height:100%; margin:0; }
body{
  font-family:var(--font); background:var(--bg); color:var(--text);
  font-size:15px; line-height:1.5; -webkit-font-smoothing:antialiased;
}
button,input,textarea{ font:inherit; color:inherit; }
:focus-visible{ outline:2px solid var(--accent); outline-offset:2px; border-radius:6px; }
:focus:not(:focus-visible){ outline:none; }
.visually-hidden{ position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }

.offline{
  position:fixed; top:0; left:0; right:0; z-index:50; text-align:center;
  background:var(--danger-bg); color:var(--danger); border-bottom:1px solid var(--danger-border);
  padding:6px 12px; font-size:13px; font-weight:600;
}
.offline[hidden]{ display:none; }

.app{
  display:grid; grid-template-columns:var(--side-w) 1fr; height:100vh; height:100dvh; overflow:hidden;
}

/* Sidebar */
.sidebar{
  display:flex; flex-direction:column; min-height:0;
  background:var(--bg-1); border-right:1px solid var(--border);
}
.side-head{
  display:flex; align-items:center; justify-content:space-between; gap:8px;
  padding:14px 14px 10px; border-bottom:1px solid var(--border);
}
.brand{ display:flex; align-items:center; gap:9px; font-weight:800; letter-spacing:.2px; font-size:17px; }
.brand svg{ width:26px; height:26px; display:block; }
.brand .k1{ color:var(--accent); }
.side-controls{ display:flex; gap:8px; padding:12px 14px; }
.search{
  flex:1; min-width:0; padding:9px 12px; border-radius:10px; border:1px solid var(--border-2);
  background:var(--bg-2); color:var(--text);
}
.search::placeholder{ color:var(--faint); }
.conv-list-wrap{ flex:1; min-height:0; overflow-y:auto; padding:6px 8px 10px; }
.conv-list{ list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px; }
.conv{ display:flex; align-items:center; border-radius:10px; }
.conv.active{ background:var(--bg-2); box-shadow:inset 0 0 0 1px var(--border-2); }
.conv-main{
  flex:1; min-width:0; display:flex; align-items:center; gap:9px; text-align:left;
  background:none; border:0; padding:9px 8px 9px 10px; cursor:pointer; border-radius:10px; color:inherit;
}
.conv-main:hover{ background:var(--bg-2); }
.conv .dot{ width:9px; height:9px; border-radius:50%; flex:0 0 auto; background:var(--faint); }
.conv .dot.idle{ background:var(--ok); }
.conv .dot.busy{ background:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
.conv .dot.arch{ background:var(--border-2); }
.conv-text{ min-width:0; flex:1; display:flex; flex-direction:column; }
.conv-title{ font-size:14px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.conv.archived .conv-title{ color:var(--muted); font-style:italic; }
.conv-time{ font-size:11px; color:var(--faint); }
.conv-acts{ display:flex; gap:2px; padding-right:6px; opacity:0; transition:opacity .12s; }
.conv:hover .conv-acts, .conv:focus-within .conv-acts{ opacity:1; }
.mini-btn{
  background:none; border:0; color:var(--muted); cursor:pointer; padding:5px 7px; border-radius:8px; font-size:12px;
}
.mini-btn:hover{ background:var(--bg-2); color:var(--text); }
.empty{ color:var(--faint); font-size:13px; padding:18px 12px; text-align:center; }
.side-foot{
  display:flex; flex-direction:column; gap:2px; padding:9px 14px; border-top:1px solid var(--border);
  font-size:11px; color:var(--faint);
}
.side-foot .cwd{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; direction:rtl; text-align:left; }

/* Main */
.main{ display:flex; flex-direction:column; min-width:0; min-height:0; background:var(--bg); }
.main-head{
  display:flex; align-items:center; justify-content:space-between; gap:14px;
  padding:12px 18px; border-bottom:1px solid var(--border); background:var(--bg-1);
}
.mh-left{ min-width:0; }
.conv-heading{ font-size:17px; font-weight:700; margin:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.route-info{ font-size:12px; color:var(--muted); margin-top:2px; min-height:1em; }
.mh-right{ display:flex; align-items:center; gap:14px; }
.mascot-wrap{ display:flex; flex-direction:column; align-items:center; gap:3px; }
.mascot{ line-height:0; }
.mascot-grid{ display:grid; gap:0; }
.mascot-cell{ width:var(--px); height:var(--px); }
.mascot-word{ font-size:11px; color:var(--muted); text-transform:capitalize; letter-spacing:.3px; }
.mh-actions{ display:flex; gap:6px; }
.icon-btn{
  background:var(--bg-2); border:1px solid var(--border-2); color:var(--text); cursor:pointer;
  padding:7px 11px; border-radius:9px; font-size:13px; white-space:nowrap;
}
.icon-btn:hover{ border-color:var(--accent); }
.icon-btn[aria-expanded="true"]{ border-color:var(--accent); color:var(--accent); }

/* Messages */
.messages{ flex:1; min-height:0; overflow-y:auto; padding:20px 18px 26px; display:flex; flex-direction:column; gap:12px; }
.empty-main{ margin:auto; text-align:center; color:var(--muted); display:flex; flex-direction:column; align-items:center; gap:12px; padding:40px; }
.empty-main svg{ width:72px; height:72px; opacity:.8; }
.empty-main p{ margin:0; max-width:340px; }

.msg{ max-width:min(760px, 100%); display:flex; flex-direction:column; gap:4px; }
.msg .role{ font-size:11px; font-weight:700; letter-spacing:.4px; text-transform:uppercase; color:var(--faint); }
.msg.user{ align-self:flex-end; align-items:flex-end; }
.msg.user .bubble{ background:var(--user-bg); border:1px solid var(--user-border); border-radius:14px 14px 4px 14px; padding:10px 14px; }
.msg.assistant{ align-self:flex-start; }
.msg.assistant .bubble{ background:var(--bg-1); border:1px solid var(--border); border-radius:14px 14px 14px 4px; padding:10px 14px; }
.bubble{ min-width:0; overflow-wrap:anywhere; }
.md-line{ margin:0; }
.md-line + .md-line{ margin-top:2px; }
.md-code{ background:var(--code-bg); border:1px solid var(--border); border-radius:10px; padding:10px 12px; overflow-x:auto; margin:6px 0; }
.md-code code{ font-family:var(--mono); font-size:13px; white-space:pre; }
.md-inline-code{ font-family:var(--mono); font-size:.88em; background:var(--code-bg); border:1px solid var(--border); border-radius:5px; padding:1px 5px; }
.reason{ align-self:flex-start; max-width:760px; }
.reason details{ font-size:12px; color:var(--muted); }
.reason summary{ cursor:pointer; color:var(--faint); }
.reason pre{ font-family:var(--mono); font-size:12px; white-space:pre-wrap; margin:6px 0 0; color:var(--muted); }

/* Tool cards */
.card{ align-self:flex-start; max-width:760px; width:100%; }
.tool{ background:var(--bg-1); border:1px solid var(--border); border-radius:12px; overflow:hidden; }
.tool > summary{ list-style:none; cursor:pointer; display:flex; align-items:center; gap:10px; padding:9px 13px; }
.tool > summary::-webkit-details-marker{ display:none; }
.tool > summary::before{ content:"›"; color:var(--faint); transition:transform .15s; }
.tool[open] > summary::before{ transform:rotate(90deg); }
.tool-name{ font-family:var(--mono); font-size:13px; font-weight:600; }
.tool-status{ margin-left:auto; font-size:12px; color:var(--muted); }
.tool.tool-ok .tool-status{ color:var(--ok); }
.tool.tool-fail{ border-color:var(--danger-border); }
.tool.tool-fail .tool-status{ color:var(--danger); }
.tool-body{ border-top:1px solid var(--border); padding:10px 13px; display:flex; flex-direction:column; gap:8px; }
.tool-args, .tool-output{ font-family:var(--mono); font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; margin:0; max-height:320px; overflow:auto; color:var(--muted); }
.tool-args{ color:var(--faint); }

/* Approval */
.approval{ background:var(--warn-bg); border:1px solid var(--warn-border); border-radius:12px; padding:12px 14px; display:flex; flex-direction:column; gap:8px; }
.approval-head{ font-weight:700; color:var(--warn); }
.approval-reason{ font-size:13px; color:var(--muted); }
.approval-actions{ display:flex; gap:8px; }
.approval.resolved-approve{ background:var(--ok-bg); border-color:var(--ok-border); }
.approval.resolved-deny{ opacity:.75; }
.approval-result{ font-size:12px; font-weight:700; color:var(--muted); }

/* Notes / status / verification */
.note{ align-self:flex-start; font-size:12.5px; color:var(--muted); background:var(--chip); border:1px solid var(--border); border-radius:999px; padding:5px 12px; }
.note.route{ color:var(--accent); }
.note.repair, .note.warn{ color:var(--warn); background:var(--warn-bg); border-color:var(--warn-border); }
.verify{ align-self:flex-start; font-size:13px; padding:7px 13px; border-radius:10px; font-family:var(--mono); max-width:760px; overflow-wrap:anywhere; }
.verify.start{ color:var(--muted); background:var(--bg-1); border:1px solid var(--border); }
.verify.ok{ color:var(--ok); background:var(--ok-bg); border:1px solid var(--ok-border); }
.verify.fail{ color:var(--warn); background:var(--warn-bg); border:1px solid var(--warn-border); }
.status{ align-self:flex-start; font-size:13px; font-weight:600; padding:7px 13px; border-radius:10px; }
.status.warn{ color:var(--warn); background:var(--warn-bg); border:1px solid var(--warn-border); }
.status.danger{ color:var(--danger); background:var(--danger-bg); border:1px solid var(--danger-border); }

/* Receipt */
.receipt{ align-self:flex-start; max-width:760px; width:100%; background:var(--bg-1); border:1px solid var(--border-2); border-radius:12px; padding:12px 14px; }
.receipt-head{ display:flex; align-items:center; gap:9px; font-weight:700; margin-bottom:8px; }
.badge{ font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; text-transform:uppercase; letter-spacing:.4px; }
.badge.ok{ color:var(--ok); background:var(--ok-bg); border:1px solid var(--ok-border); }
.badge.no{ color:var(--muted); background:var(--chip); border:1px solid var(--border); }
.receipt-line{ font-family:var(--mono); font-size:12.5px; color:var(--muted); white-space:pre-wrap; overflow-wrap:anywhere; }
.receipt-files{ margin-top:8px; display:flex; flex-wrap:wrap; gap:6px; }
.receipt-file{ font-family:var(--mono); font-size:12px; background:var(--chip); border:1px solid var(--border); border-radius:6px; padding:2px 7px; }

/* Composer */
.composer{ border-top:1px solid var(--border); padding:12px 18px 16px; background:var(--bg-1); display:flex; flex-direction:column; gap:8px; }
.run-banner{ display:flex; align-items:center; gap:10px; font-size:13px; color:var(--muted); background:var(--bg-2); border:1px solid var(--border-2); border-radius:10px; padding:6px 12px; }
.run-banner[hidden]{ display:none; }
.run-dot{ width:9px; height:9px; border-radius:50%; background:var(--accent); animation:pulse 1.2s ease-in-out infinite; }
.run-label{ flex:1; min-width:0; }
.composer-row{ display:flex; gap:10px; align-items:flex-end; }
.input{
  flex:1; min-width:0; resize:none; max-height:180px; overflow-y:auto;
  background:var(--bg-2); border:1px solid var(--border-2); border-radius:12px; padding:11px 14px;
}
.input::placeholder{ color:var(--faint); }
.input:disabled{ opacity:.55; }
.btn{ cursor:pointer; border:1px solid var(--border-2); background:var(--bg-2); color:var(--text); border-radius:11px; padding:10px 16px; font-weight:600; }
.btn:hover{ border-color:var(--accent); }
.btn:disabled{ opacity:.5; cursor:not-allowed; }
.btn-accent{ background:var(--accent); color:var(--accent-ink); border-color:transparent; }
.btn-accent:hover{ filter:brightness(1.05); border-color:transparent; }
.btn-stop{ background:var(--danger-bg); color:var(--danger); border-color:var(--danger-border); padding:6px 13px; }
.btn-approve{ background:var(--ok); color:#0e2a16; border-color:transparent; }
.btn-deny{ background:var(--bg-2); }
.send{ align-self:stretch; }

/* Drawer */
.drawer{
  position:fixed; top:0; right:0; height:100vh; height:100dvh; width:min(380px, 92vw); z-index:40;
  background:var(--panel-solid); border-left:1px solid var(--border); box-shadow:-14px 0 40px var(--shadow);
  display:flex; flex-direction:column; transform:translateX(100%); visibility:hidden; transition:transform .18s ease;
}
.drawer.open{ transform:none; visibility:visible; }
.drawer-head{ display:flex; align-items:center; justify-content:space-between; padding:14px 16px; border-bottom:1px solid var(--border); font-weight:700; }
.drawer-actions{ padding:10px 16px; border-bottom:1px solid var(--border); }
.files-list{ padding:10px 16px; display:flex; flex-direction:column; gap:6px; border-bottom:1px solid var(--border); max-height:34vh; overflow:auto; }
.file-row{ display:flex; align-items:center; gap:10px; font-size:12.5px; }
.file-path{ font-family:var(--mono); min-width:0; overflow-wrap:anywhere; flex:1; }
.file-stat{ display:flex; gap:8px; font-family:var(--mono); font-size:12px; flex:0 0 auto; }
.stat-add{ color:var(--ok); }
.stat-del{ color:var(--danger); }
.drawer-empty{ color:var(--faint); font-size:13px; padding:8px 0; }
.diff-view{ flex:1; min-height:0; overflow:auto; padding:12px 16px; font-family:var(--mono); font-size:12.5px; line-height:1.45; }
.diff-line{ white-space:pre; }
.diff-add{ color:var(--ok); background:color-mix(in srgb, var(--ok) 12%, transparent); }
.diff-del{ color:var(--danger); background:color-mix(in srgb, var(--danger) 12%, transparent); }
.diff-hunk{ color:var(--accent-2); }
.diff-file{ color:var(--muted); font-weight:700; }

/* Toasts */
.toasts{ position:fixed; bottom:18px; left:50%; transform:translateX(-50%); z-index:60; display:flex; flex-direction:column; gap:8px; align-items:center; }
.toast{ background:var(--bg-2); color:var(--text); border:1px solid var(--border-2); border-radius:10px; padding:9px 15px; font-size:13px; box-shadow:0 8px 24px var(--shadow); }

@keyframes pulse{ 0%,100%{ opacity:1; } 50%{ opacity:.35; } }

/* Responsive: collapse the sidebar on tablet/narrow widths into a slide-over. */
@media (max-width: 860px){
  .app{ grid-template-columns:1fr; }
  .sidebar{
    position:fixed; top:0; left:0; height:100vh; height:100dvh; width:min(300px, 88vw); z-index:45;
    transform:translateX(-100%); transition:transform .18s ease; box-shadow:14px 0 40px var(--shadow);
  }
  .app.nav-open .sidebar{ transform:none; }
  .menu-btn{ display:inline-flex; }
}
.menu-btn{ display:none; }
.scrim{ position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:44; }
.scrim[hidden]{ display:none; }

@media (prefers-reduced-motion: reduce){
  *{ animation:none !important; transition:none !important; scroll-behavior:auto !important; }
}
`;

// ── Body markup ──────────────────────────────────────────────────────────────────────────────────
// Static structure only; every dynamic value comes from window.KITTEN / the API via the script below.
const BODY = `
<div id="offline" class="offline" role="status" aria-live="polite" hidden>Connection lost. Reconnecting…</div>
<div class="scrim" id="scrim" hidden></div>
<div class="app" id="app">
  <aside class="sidebar" aria-label="Conversations">
    <div class="side-head">
      <div class="brand">
        <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="currentColor" class="k1" d="M9 6l7 8a16 15 0 0 1 16 0l7-8v14a15 15 0 1 1-37 0z"/><circle cx="18" cy="26" r="3" fill="#0e0a08"/><circle cx="30" cy="26" r="3" fill="#0e0a08"/><path d="M24 31l-3 3h6z" fill="#e7748e"/><path d="M4 30h9M4 34h9M35 30h9M35 34h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".55"/></svg>
        <span>Kitten</span>
      </div>
      <button id="themeBtn" class="mini-btn" title="Toggle theme" aria-label="Toggle color theme">◐ Theme</button>
    </div>
    <div class="side-controls">
      <label class="visually-hidden" for="search">Search conversations</label>
      <input id="search" class="search" type="search" placeholder="Search…" autocomplete="off" spellcheck="false">
      <button id="newBtn" class="btn btn-accent" type="button">New</button>
    </div>
    <nav class="conv-list-wrap" aria-label="Conversation list">
      <ul id="convList" class="conv-list"></ul>
      <div id="convEmpty" class="empty" hidden>No conversations yet — start one.</div>
    </nav>
    <div class="side-foot">
      <span id="cwd" class="cwd" title=""></span>
      <span id="ver" class="ver"></span>
    </div>
  </aside>

  <main class="main" aria-label="Conversation">
    <div class="main-head">
      <div class="mh-left" style="display:flex;align-items:center;gap:12px;min-width:0">
        <button id="menuBtn" class="icon-btn menu-btn" type="button" aria-label="Show conversations">☰</button>
        <div style="min-width:0">
          <h1 id="convTitle" class="conv-heading">Kitten</h1>
          <div id="routeInfo" class="route-info"></div>
        </div>
      </div>
      <div class="mh-right">
        <div class="mascot-wrap">
          <div id="mascot" class="mascot" role="img" aria-label="Kitten is ready"></div>
          <span id="mascotWord" class="mascot-word">ready</span>
        </div>
        <div class="mh-actions">
          <button id="renameBtn" class="icon-btn" type="button" title="Rename conversation">Rename</button>
          <button id="undoBtn" class="icon-btn" type="button" title="Undo the last run's file changes">Undo</button>
          <button id="changesBtn" class="icon-btn" type="button" title="Show changed files and diff" aria-expanded="false" aria-controls="drawer">Changes</button>
        </div>
      </div>
    </div>

    <section id="messages" class="messages" aria-label="Messages" tabindex="0">
      <div id="mainEmpty" class="empty-main">
        <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="var(--accent)" d="M9 6l7 8a16 15 0 0 1 16 0l7-8v14a15 15 0 1 1-37 0z"/><circle cx="18" cy="26" r="3" fill="#0e0a08"/><circle cx="30" cy="26" r="3" fill="#0e0a08"/><path d="M24 31l-3 3h6z" fill="#e7748e"/></svg>
        <p id="mainEmptyText">Pick a conversation on the left, or start a new one to begin.</p>
      </div>
    </section>

    <form id="composer" class="composer" autocomplete="off">
      <div id="runBanner" class="run-banner" hidden>
        <span class="run-dot" aria-hidden="true"></span>
        <span id="runLabel" class="run-label">Working…</span>
        <button type="button" id="stopBtn" class="btn btn-stop">Stop</button>
      </div>
      <div class="composer-row">
        <label class="visually-hidden" for="input">Message Kitten</label>
        <textarea id="input" class="input" rows="1" placeholder="Message Kitten…  (Enter to send, Shift+Enter for a new line)" disabled></textarea>
        <button type="submit" id="sendBtn" class="btn btn-accent send" disabled>Send</button>
      </div>
    </form>
  </main>

  <aside id="drawer" class="drawer" aria-label="Changed files and diff" aria-hidden="true">
    <div class="drawer-head"><span>Changes</span><button id="drawerClose" class="mini-btn" type="button" aria-label="Close changes panel">Close</button></div>
    <div class="drawer-actions"><button id="diffBtn" class="btn" type="button">View diff</button></div>
    <div id="filesList" class="files-list"></div>
    <div id="diffView" class="diff-view" aria-label="Unified diff"></div>
  </aside>
</div>
<div id="toasts" class="toasts" aria-live="assertive"></div>
`;

// ── Browser script ─────────────────────────────────────────────────────────────────────────────────
// Pure vanilla JS. Reminder (see file header): NO backtick, NO backslash, NO `${` — control characters
// are made with String.fromCharCode and every string is concatenated. All server-provided text is put
// on the page via textContent / createElement; innerHTML is only ever assigned the empty string.
const SCRIPT = `
(function(){
  "use strict";
  var KITTEN = window.KITTEN || {};
  var TOKEN = KITTEN.token || "";
  var NL = String.fromCharCode(10);
  var CR = String.fromCharCode(13);
  var BT = String.fromCharCode(96);
  var FENCE = BT + BT + BT;

  function el(id){ return document.getElementById(id); }
  function mk(tag, cls){ var e = document.createElement(tag); if(cls) e.className = cls; return e; }
  function txt(tag, cls, s){ var e = mk(tag, cls); e.textContent = (s==null? "" : String(s)); return e; }

  // ── State ──────────────────────────────────────────────────────────────────
  var currentId = null;
  var convCache = [];
  var lastSeq = 0;
  var es = null;
  var reconnectTimer = null;
  var backoff = 800;
  var stick = true;
  var mascotState = "";
  var mascotGrids = {};
  var openAssistant = null;  // the currently-streaming assistant bubble (null = none open)
  var openReasoning = null;  // the currently-streaming reasoning box
  var toolCards = {};
  var activeRuns = {};
  var activeRunId = null;
  var changedFiles = {};
  var diffAvailable = false;
  var listTimer = null;

  var messagesEl, listEl, convEmptyEl, mainEmptyEl, titleEl, routeEl, drawerEl,
      filesListEl, diffViewEl, changesBtnEl, runBannerEl, runLabelEl, stopBtnEl,
      inputEl, sendBtnEl, appEl, scrimEl;

  // ── API helper (adds the token to every request) ────────────────────────────
  function api(path, body){
    var opts = { headers: { "x-kitten-token": TOKEN } };
    if(body !== undefined){
      opts.method = "POST";
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function(r){
      if(!r.ok) throw new Error("http " + r.status);
      return r.json();
    });
  }

  // ── Mascot ──────────────────────────────────────────────────────────────────
  var EVENT_MASCOT = {
    "user.message": "ready",
    "run.started": "thinking",
    "route.selected": "thinking",
    "tool.proposed": "working",
    "tool.started": "working",
    "tool.output": "working",
    "tool.completed": "working",
    "assistant.delta": "working",
    "candidate.started": "sampling",
    "verification.started": "verifying",
    "verification.evidence": "verifying",
    "verification.failed": "blocked",
    "repair.started": "blocked",
    "run.completed": "success",
    "run.failed": "blocked",
    "run.cancelled": "blocked",
    "run.interrupted": "blocked"
  };
  function mascotForEvent(type){ return EVENT_MASCOT[type] || null; }

  function buildMascotGrid(state){
    var grid = (KITTEN.mascot && KITTEN.mascot[state]) || (KITTEN.mascot && KITTEN.mascot.ready) || [];
    var cols = 0, y, x;
    for(y = 0; y < grid.length; y++){ if(grid[y] && grid[y].length > cols) cols = grid[y].length; }
    var host = mk("div", "mascot-grid");
    host.style.gridTemplateColumns = "repeat(" + cols + ", var(--px))";
    for(y = 0; y < grid.length; y++){
      var row = grid[y] || [];
      for(x = 0; x < cols; x++){
        var cell = mk("div", "mascot-cell");
        var c = row[x];
        if(c) cell.style.background = c;
        host.appendChild(cell);
      }
    }
    return host;
  }
  function setMascot(state){
    if(!KITTEN.mascot || !KITTEN.mascot[state]) state = "ready";
    if(state === mascotState) return;
    mascotState = state;
    var host = el("mascot");
    var grid = mascotGrids[state];
    if(!grid){ grid = buildMascotGrid(state); mascotGrids[state] = grid; }
    host.innerHTML = "";
    host.appendChild(grid);
    host.setAttribute("aria-label", "Kitten is " + state);
    var w = el("mascotWord");
    if(w) w.textContent = state;
  }

  // ── Safe markdown (escape-by-construction: textContent only) ─────────────────
  function renderInline(parent, text){
    var i = 0, n = text.length, buf = "";
    function flush(){ if(buf){ parent.appendChild(document.createTextNode(buf)); buf = ""; } }
    while(i < n){
      var ch = text.charAt(i);
      if(ch === BT){
        var end = text.indexOf(BT, i + 1);
        if(end > i){
          flush();
          var code = txt("code", "md-inline-code", text.slice(i + 1, end));
          parent.appendChild(code);
          i = end + 1; continue;
        }
      }
      if(ch === "*" && text.charAt(i + 1) === "*"){
        var b = text.indexOf("**", i + 2);
        if(b > i){
          flush();
          parent.appendChild(txt("strong", null, text.slice(i + 2, b)));
          i = b + 2; continue;
        }
      }
      buf += ch; i++;
    }
    flush();
  }
  function renderMarkdown(container, raw){
    container.innerHTML = "";
    var text = String(raw == null ? "" : raw);
    text = text.split(CR).join("");
    var lines = text.split(NL);
    var i = 0;
    while(i < lines.length){
      var line = lines[i];
      if(line.slice(0, 3) === FENCE){
        i++;
        var code = [];
        while(i < lines.length && lines[i].slice(0, 3) !== FENCE){ code.push(lines[i]); i++; }
        if(i < lines.length) i++;
        var pre = mk("pre", "md-code");
        pre.appendChild(txt("code", null, code.join(NL)));
        container.appendChild(pre);
        continue;
      }
      if(line === ""){ i++; continue; }
      var p = mk("div", "md-line");
      renderInline(p, line);
      container.appendChild(p);
      i++;
    }
  }

  // ── Scrolling ────────────────────────────────────────────────────────────────
  function nearBottom(){
    return messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 48;
  }
  function scrollToBottom(){ messagesEl.scrollTop = messagesEl.scrollHeight; }

  // ── Message renderers ────────────────────────────────────────────────────────
  function hideMainEmpty(){ if(mainEmptyEl){ mainEmptyEl.hidden = true; } }
  function append(node){ messagesEl.appendChild(node); if(stick) scrollToBottom(); }

  function addUserMessage(text){
    var wrap = mk("div", "msg user");
    wrap.appendChild(txt("div", "role", "You"));
    var bubble = mk("div", "bubble");
    renderMarkdown(bubble, text);
    wrap.appendChild(bubble);
    append(wrap);
  }
  function assistantBubble(){
    if(openAssistant) return openAssistant;
    var wrap = mk("div", "msg assistant");
    wrap.appendChild(txt("div", "role", "Kitten"));
    var bubble = mk("div", "bubble");
    wrap.appendChild(bubble);
    append(wrap);
    openAssistant = { wrap: wrap, bubble: bubble, acc: "" };
    return openAssistant;
  }
  function appendAssistant(runId, text, isFinal){
    var b = assistantBubble();
    b.acc = isFinal ? String(text || "") : (b.acc + String(text || ""));
    renderMarkdown(b.bubble, b.acc);
    if(isFinal) openAssistant = null; // the final answer closes this assistant segment
    if(stick) scrollToBottom();
  }
  function appendReasoning(runId, text){
    var box = openReasoning;
    if(!box){
      var wrap = mk("div", "reason");
      var det = mk("details", null);
      det.appendChild(txt("summary", null, "Reasoning"));
      var pre = mk("pre", null);
      det.appendChild(pre);
      wrap.appendChild(det);
      append(wrap);
      box = { pre: pre, acc: "" };
      openReasoning = box;
    }
    box.acc += String(text || "");
    box.pre.textContent = box.acc;
  }

  function addRoute(ev){
    var reasons = (ev.reasons || []).join(" · ");
    routeEl.textContent = "Lane: " + ev.lane + (ev.k > 1 ? "  ·  k=" + ev.k : "") + (reasons ? "  ·  " + reasons : "");
    var chip = txt("div", "note route", "Routed to the " + ev.lane + " lane" + (ev.k > 1 ? " (k=" + ev.k + ")" : ""));
    if(reasons) chip.title = reasons;
    append(chip);
  }

  function getToolCard(callId, name){
    var c = toolCards[callId];
    if(c){ if(name && c.nameEl.textContent === "tool"){ c.nameEl.textContent = name; } return c; }
    var det = mk("details", "card tool");
    det.open = false;
    var sum = mk("summary", null);
    var nameEl = txt("span", "tool-name", name || "tool");
    var statusEl = txt("span", "tool-status", "running");
    sum.appendChild(nameEl); sum.appendChild(statusEl);
    var body = mk("div", "tool-body");
    var argsEl = mk("pre", "tool-args"); argsEl.hidden = true;
    var outputEl = mk("pre", "tool-output");
    body.appendChild(argsEl); body.appendChild(outputEl);
    det.appendChild(sum); det.appendChild(body);
    append(det);
    c = { el: det, nameEl: nameEl, statusEl: statusEl, argsEl: argsEl, outputEl: outputEl };
    toolCards[callId] = c;
    return c;
  }
  function onToolCompleted(ev){
    var c = getToolCard(ev.callId, ev.name);
    c.el.classList.add(ev.ok ? "tool-ok" : "tool-fail");
    var d = (typeof ev.durationMs === "number") ? "  ·  " + fmtMs(ev.durationMs) : "";
    c.statusEl.textContent = (ev.ok ? "ok" : "failed") + d;
    if(ev.output){ c.outputEl.textContent = String(ev.output); }
    if(!ev.ok) c.el.open = true;
  }

  function addApproval(ev){
    var card = mk("div", "card approval");
    card.appendChild(txt("div", "approval-head", "Approval required: " + (ev.name || "action") + "  (" + (ev.risk || "?") + " risk)"));
    card.appendChild(txt("div", "approval-reason", ev.reason || ""));
    var acts = mk("div", "approval-actions");
    var yes = txt("button", "btn btn-approve", "Approve"); yes.type = "button";
    var no = txt("button", "btn btn-deny", "Deny"); no.type = "button";
    function respond(allowed){
      api("/api/approve", { runId: ev.runId, callId: ev.callId, allowed: allowed }).then(function(r){
        yes.disabled = true; no.disabled = true;
        // The server returns {ok:false} when nothing is pending (a stale card replayed from history, or
        // already answered elsewhere). Don't show a fake "Approved"/"Denied" for a no-op.
        if(!r || r.ok === false){
          card.appendChild(txt("div", "approval-result", "No longer pending"));
          return;
        }
        card.classList.add(allowed ? "resolved-approve" : "resolved-deny");
        card.appendChild(txt("div", "approval-result", allowed ? "Approved" : "Denied"));
      }).catch(function(){ toast("Could not send your approval"); });
    }
    yes.onclick = function(){ respond(true); };
    no.onclick = function(){ respond(false); };
    acts.appendChild(yes); acts.appendChild(no);
    card.appendChild(acts);
    append(card);
  }

  function addNote(cls, text){ append(txt("div", "note " + cls, text)); }
  function addVerify(kind, text){ append(txt("div", "verify " + kind, text)); }
  function addStatus(kind, text){ append(txt("div", "status " + kind, text)); }

  function addReceipt(ev){
    var card = mk("div", "card receipt");
    var head = mk("div", "receipt-head");
    head.appendChild(txt("span", null, "Receipt"));
    head.appendChild(txt("span", "badge " + (ev.verified ? "ok" : "no"), ev.verified ? "verified" : "unverified"));
    card.appendChild(head);
    var lines = ev.lines || [];
    for(var i = 0; i < lines.length; i++){ card.appendChild(txt("div", "receipt-line", lines[i])); }
    var files = ev.filesChanged || [];
    if(files.length){
      var fl = mk("div", "receipt-files");
      for(var j = 0; j < files.length; j++){ fl.appendChild(txt("span", "receipt-file", files[j])); }
      card.appendChild(fl);
    }
    append(card);
  }

  // ── Run banner / active-run tracking ─────────────────────────────────────────
  function onRunStarted(ev){
    activeRuns[ev.runId] = true;
    activeRunId = ev.runId;
    showRunBanner("Working…");
  }
  function onRunStatus(ev){
    if(ev.status === "cancelling"){ runLabelEl.textContent = "Stopping…"; }
    else if(ev.status === "waiting_approval"){ runLabelEl.textContent = "Waiting for approval…"; }
    else if(ev.status === "running"){ runLabelEl.textContent = "Working…"; }
  }
  function onRunEnd(runId){
    delete activeRuns[runId];
    var keys = Object.keys(activeRuns);
    activeRunId = keys.length ? keys[keys.length - 1] : null;
    if(!keys.length) hideRunBanner();
  }
  function showRunBanner(label){ runLabelEl.textContent = label; runBannerEl.hidden = false; }
  function hideRunBanner(){ runBannerEl.hidden = true; }

  // ── Files / diff ─────────────────────────────────────────────────────────────
  function onFileChanged(ev){
    changedFiles[ev.path] = { added: ev.added || 0, removed: ev.removed || 0 };
    renderFiles();
    updateChangesBadge();
  }
  function renderFiles(){
    filesListEl.innerHTML = "";
    var keys = Object.keys(changedFiles).sort();
    if(!keys.length){ filesListEl.appendChild(txt("div", "drawer-empty", "No file changes yet.")); return; }
    for(var i = 0; i < keys.length; i++){
      var p = keys[i], it = changedFiles[p];
      var row = mk("div", "file-row");
      row.appendChild(txt("span", "file-path", p));
      var stat = mk("span", "file-stat");
      stat.appendChild(txt("span", "stat-add", "+" + (it.added || 0)));
      stat.appendChild(txt("span", "stat-del", "-" + (it.removed || 0)));
      row.appendChild(stat);
      filesListEl.appendChild(row);
    }
  }
  function updateChangesBadge(){
    var n = Object.keys(changedFiles).length;
    changesBtnEl.textContent = n ? "Changes (" + n + ")" : "Changes";
  }
  function showDiff(){
    if(!currentId) return;
    api("/api/diff?conversation=" + encodeURIComponent(currentId)).then(function(res){
      diffViewEl.innerHTML = "";
      var text = String(res.diff || "");
      if(!text){ diffViewEl.appendChild(txt("div", "drawer-empty", "No changes to diff.")); return; }
      var lines = text.split(CR).join("").split(NL);
      for(var i = 0; i < lines.length; i++){
        var ln = lines[i];
        var cls = "diff-line";
        var head3 = ln.slice(0, 3);
        if(head3 === "+++" || head3 === "---" || ln.slice(0, 4) === "diff"){ cls += " diff-file"; }
        else if(ln.slice(0, 2) === "@@"){ cls += " diff-hunk"; }
        else if(ln.charAt(0) === "+"){ cls += " diff-add"; }
        else if(ln.charAt(0) === "-"){ cls += " diff-del"; }
        diffViewEl.appendChild(txt("div", cls, ln.length ? ln : " "));
      }
      openDrawer();
    }).catch(function(){ toast("Could not load the diff"); });
  }

  // ── The single event dispatcher (history replay AND live use the same path) ──
  function applyEvent(ev){
    if(!ev || ev.conversationId !== currentId) return;
    if(typeof ev.seq === "number"){ if(ev.seq <= lastSeq) return; lastSeq = ev.seq; }
    var wasStuck = stick;
    hideMainEmpty();
    var t = ev.type;
    // Any non-streaming event closes the open assistant/reasoning bubble so the NEXT delta starts a
    // fresh bubble in chronological position (interleaved with the tool cards), instead of collapsing
    // all of a run's prose into one bubble rendered above the cards it actually follows.
    if(t !== "assistant.delta" && t !== "reasoning.delta" && t !== "assistant.final"){ openAssistant = null; openReasoning = null; }
    if(t === "conversation.created"){ if(ev.title) setTitle(ev.title); }
    else if(t === "conversation.renamed"){ setTitle(ev.title); scheduleListRefresh(); }
    else if(t === "conversation.archived"){ scheduleListRefresh(); }
    else if(t === "user.message"){ addUserMessage(ev.text); }
    else if(t === "route.selected"){ addRoute(ev); }
    else if(t === "run.started"){ onRunStarted(ev); }
    else if(t === "run.status"){ onRunStatus(ev); }
    else if(t === "assistant.delta"){ appendAssistant(ev.runId, ev.text, false); }
    else if(t === "assistant.final"){ appendAssistant(ev.runId, ev.text, true); }
    else if(t === "reasoning.delta"){ appendReasoning(ev.runId, ev.text); }
    else if(t === "tool.proposed"){ var cp = getToolCard(ev.callId, ev.name); if(ev.args){ cp.argsEl.textContent = String(ev.args); cp.argsEl.hidden = false; } }
    else if(t === "tool.approval_required"){ addApproval(ev); }
    else if(t === "tool.started"){ getToolCard(ev.callId, ev.name).statusEl.textContent = "running"; }
    else if(t === "tool.output"){ var co = getToolCard(ev.callId, ""); co.outputEl.textContent += String(ev.chunk || ""); }
    else if(t === "tool.completed"){ onToolCompleted(ev); }
    else if(t === "candidate.started"){ addNote("", "Sampling candidate " + ((ev.index || 0) + 1)); }
    else if(t === "candidate.completed"){ addNote("", "Candidate " + ((ev.index || 0) + 1) + (ev.finished ? " finished" : " stopped") + (ev.summary ? ": " + ev.summary : "")); }
    else if(t === "candidate.rejected"){ addNote("warn", "Candidate " + ((ev.index || 0) + 1) + " rejected" + (ev.reason ? ": " + ev.reason : "")); }
    else if(t === "verification.started"){ addVerify("start", "Verifying: " + (ev.what || "")); }
    else if(t === "verification.evidence"){ addVerify(ev.passed ? "ok" : "fail", (ev.passed ? "PASS  " : "FAIL  ") + (ev.check || "") + (ev.proves ? "   (" + ev.proves + ")" : "")); }
    else if(t === "verification.passed"){ addVerify("ok", "Verified: " + (ev.detail || "")); }
    else if(t === "verification.failed"){ addVerify("fail", "Verification failed: " + (ev.detail || "")); }
    else if(t === "file.changed"){ onFileChanged(ev); }
    else if(t === "diff.updated"){ diffAvailable = true; }
    else if(t === "repair.started"){ addNote("repair", "Repair round " + (ev.round || 1)); }
    else if(t === "run.cancelled"){ onRunEnd(ev.runId); addStatus("warn", "Run cancelled."); }
    else if(t === "run.interrupted"){ onRunEnd(ev.runId); addStatus("warn", "Run interrupted."); }
    else if(t === "run.failed"){ onRunEnd(ev.runId); addStatus("danger", "Run failed: " + (ev.error || "unknown error")); }
    else if(t === "run.completed"){ onRunEnd(ev.runId); }
    else if(t === "run.undone"){ onRunEnd(ev.runId); addStatus("warn", "Reverted " + ((ev.restored || []).length) + " file(s); deleted " + ((ev.deleted || []).length) + "."); afterUndo(ev); }
    else if(t === "receipt.finalized"){ addReceipt(ev); }

    var ms = mascotForEvent(t);
    if(ms) setMascot(ms);
    else if(!activeRunId && (t === "run.completed" || t === "run.failed")) { /* leave last face */ }
    if(wasStuck) scrollToBottom();
  }

  function afterUndo(ev){
    var gone = (ev.restored || []).concat(ev.deleted || []);
    for(var i = 0; i < gone.length; i++){ delete changedFiles[gone[i]]; }
    renderFiles(); updateChangesBadge();
  }

  // ── Streaming (EventSource with manual reconnect + seq de-dup) ────────────────
  function openStream(id){
    closeStream();
    var url = "/api/stream?conversation=" + encodeURIComponent(id) +
              "&after=" + lastSeq + "&token=" + encodeURIComponent(TOKEN);
    var source;
    try { source = new EventSource(url); }
    catch(e){ setOffline(true); scheduleReconnect(id); return; }
    es = source;
    source.onopen = function(){ setOffline(false); backoff = 800; };
    source.onmessage = function(m){
      try { applyEvent(JSON.parse(m.data)); }
      catch(e){ /* ignore a malformed frame */ }
    };
    source.onerror = function(){
      setOffline(true);
      if(es === source){ try { source.close(); } catch(e){} es = null; }
      scheduleReconnect(id);
    };
  }
  function closeStream(){
    if(reconnectTimer){ clearTimeout(reconnectTimer); reconnectTimer = null; }
    if(es){ try { es.close(); } catch(e){} es = null; }
  }
  function scheduleReconnect(id){
    if(reconnectTimer) clearTimeout(reconnectTimer);
    if(currentId !== id) return;
    reconnectTimer = setTimeout(function(){
      reconnectTimer = null;
      if(currentId === id) openStream(id);
    }, backoff);
    backoff = Math.min(backoff * 2, 8000);
  }
  function setOffline(on){ el("offline").hidden = !on; }

  // ── Conversation selection / history load ────────────────────────────────────
  function resetMain(){
    messagesEl.innerHTML = "";
    openAssistant = null; openReasoning = null; toolCards = {}; activeRuns = {};
    activeRunId = null; changedFiles = {}; diffAvailable = false; lastSeq = 0; stick = true;
    routeEl.textContent = "";
    hideRunBanner();
    renderFiles(); updateChangesBadge();
    diffViewEl.innerHTML = "";
  }
  function selectConversation(id){
    if(!id) return;
    closeStream();
    currentId = id;
    setUrl(id);
    resetMain();
    setComposerEnabled(true);
    setMascot("ready");
    highlightList();
    closeNav();
    api("/api/conversations/" + encodeURIComponent(id)).then(function(res){
      if(currentId !== id) return;
      if(res.conversation){ setTitle(res.conversation.title); }
      var events = res.events || [];
      for(var i = 0; i < events.length; i++){ applyEvent(events[i]); }
      if(!events.length){ mainEmptyEl.hidden = true; }
      // Reconcile the Stop button with any run left active by the projection.
      var runs = res.runs || [];
      for(var j = 0; j < runs.length; j++){
        var st = runs[j].status;
        if(st === "queued" || st === "running" || st === "waiting_approval" || st === "cancelling"){
          activeRuns[runs[j].id] = true; activeRunId = runs[j].id; showRunBanner("Working…");
        }
      }
      scrollToBottom();
      openStream(id);
    }).catch(function(){
      if(currentId === id) toast("Could not load that conversation");
    });
  }
  function setTitle(t){ titleEl.textContent = t || "Untitled"; document.title = (t ? t + " — Kitten" : "Kitten"); }
  function setUrl(id){
    try { history.replaceState(null, "", "?c=" + encodeURIComponent(id)); } catch(e){}
  }
  function setComposerEnabled(on){
    inputEl.disabled = !on;
    sendBtnEl.disabled = !on || !inputEl.value.trim();
  }
  function showNoneSelected(){
    currentId = null;
    resetMain();
    setComposerEnabled(false);
    setMascot("sleeping");
    mainEmptyEl.hidden = false;
    setTitle("Kitten");
    highlightList();
  }

  // ── Sidebar list ─────────────────────────────────────────────────────────────
  function loadList(q){
    return api("/api/conversations?search=" + encodeURIComponent(q || "")).then(function(res){
      convCache = res.conversations || [];
      renderList(convCache, q || "");
      return convCache;
    }).catch(function(){ toast("Could not load conversations"); return []; });
  }
  function scheduleListRefresh(){
    if(listTimer) clearTimeout(listTimer);
    listTimer = setTimeout(function(){ listTimer = null; loadList(el("search").value); }, 250);
  }
  function renderList(items, q){
    listEl.innerHTML = "";
    if(!items.length){
      convEmptyEl.hidden = false;
      convEmptyEl.textContent = q ? "No conversations match your search." : "No conversations yet — start one.";
      return;
    }
    convEmptyEl.hidden = true;
    for(var i = 0; i < items.length; i++){
      listEl.appendChild(convItem(items[i]));
    }
    highlightList();
  }
  function convItem(c){
    var li = mk("li", "conv" + (c.archived ? " archived" : ""));
    li.setAttribute("data-id", c.id);
    var main = mk("button", "conv-main"); main.type = "button";
    main.setAttribute("aria-label", "Open conversation " + (c.title || "Untitled"));
    var dotCls = c.archived ? "dot arch" : (c.id === currentId && activeRunId ? "dot busy" : "dot idle");
    main.appendChild(mk("span", dotCls));
    var textWrap = mk("span", "conv-text");
    textWrap.appendChild(txt("span", "conv-title", c.title || "Untitled"));
    textWrap.appendChild(txt("span", "conv-time", relTime(c.updatedAt)));
    main.appendChild(textWrap);
    main.onclick = function(){ selectConversation(c.id); };
    var acts = mk("span", "conv-acts");
    var ren = txt("button", "mini-btn", "Rename"); ren.type = "button"; ren.title = "Rename";
    ren.onclick = function(e){ e.stopPropagation(); doRename(c); };
    var arc = txt("button", "mini-btn", c.archived ? "Unarchive" : "Archive"); arc.type = "button";
    arc.onclick = function(e){ e.stopPropagation(); doArchive(c); };
    acts.appendChild(ren); acts.appendChild(arc);
    li.appendChild(main); li.appendChild(acts);
    if(c.id === currentId){ li.classList.add("active"); main.setAttribute("aria-current", "true"); }
    return li;
  }
  function highlightList(){
    var nodes = listEl.querySelectorAll(".conv");
    for(var i = 0; i < nodes.length; i++){
      var isActive = nodes[i].getAttribute("data-id") === currentId;
      nodes[i].classList.toggle("active", isActive);
    }
  }

  function doRename(c){
    var next = window.prompt("Rename conversation", c.title || "");
    if(next == null) return;
    next = next.trim();
    if(!next || next === c.title) return;
    api("/api/rename", { conversationId: c.id, title: next }).then(function(){
      if(c.id === currentId) setTitle(next);
      loadList(el("search").value);
    }).catch(function(){ toast("Rename failed"); });
  }
  function doArchive(c){
    var want = !c.archived;
    api("/api/archive", { conversationId: c.id, archived: want }).then(function(){
      loadList(el("search").value);
    }).catch(function(){ toast("Archive failed"); });
  }
  function doNew(){
    api("/api/conversations", {}).then(function(res){
      var conv = res.conversation;
      if(!conv) return;
      el("search").value = "";
      loadList("").then(function(){ selectConversation(conv.id); });
    }).catch(function(){ toast("Could not start a conversation"); });
  }
  function doUndo(){
    if(!currentId) return;
    api("/api/undo", { conversationId: currentId }).then(function(res){
      var r = res.result || {};
      if(r.ok){ toast("Undid the last run's changes"); }
      else { toast(r.reason ? r.reason : "Nothing to undo"); }
    }).catch(function(){ toast("Undo failed"); });
  }

  // ── Composer ─────────────────────────────────────────────────────────────────
  var composing = false;
  function autoGrow(){
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
  }
  function send(){
    var text = inputEl.value.trim();
    if(!text || !currentId) return;
    inputEl.value = ""; autoGrow(); setComposerEnabled(true);
    api("/api/message", { conversationId: currentId, text: text }).catch(function(){
      toast("Message failed to send");
    });
  }
  function doStop(){
    if(!activeRunId) return;
    api("/api/cancel", { runId: activeRunId }).catch(function(){ toast("Could not stop the run"); });
  }

  // ── Drawer / nav / theme ─────────────────────────────────────────────────────
  function openDrawer(){
    drawerEl.classList.add("open");
    drawerEl.setAttribute("aria-hidden", "false");
    changesBtnEl.setAttribute("aria-expanded", "true");
  }
  function closeDrawer(){
    drawerEl.classList.remove("open");
    drawerEl.setAttribute("aria-hidden", "true");
    changesBtnEl.setAttribute("aria-expanded", "false");
  }
  function toggleDrawer(){
    if(drawerEl.classList.contains("open")) closeDrawer();
    else { renderFiles(); openDrawer(); }
  }
  function openNav(){ appEl.classList.add("nav-open"); scrimEl.hidden = false; }
  function closeNav(){ appEl.classList.remove("nav-open"); scrimEl.hidden = true; }

  function initTheme(){
    var saved = null;
    try { saved = window.localStorage.getItem("kitten-theme"); } catch(e){}
    if(saved === "light" || saved === "dark"){ document.documentElement.setAttribute("data-theme", saved); }
  }
  function cycleTheme(){
    var cur = document.documentElement.getAttribute("data-theme");
    var next = cur === "dark" ? "light" : (cur === "light" ? null : "dark");
    if(next){ document.documentElement.setAttribute("data-theme", next); }
    else { document.documentElement.removeAttribute("data-theme"); }
    try {
      if(next) window.localStorage.setItem("kitten-theme", next);
      else window.localStorage.removeItem("kitten-theme");
    } catch(e){}
  }

  // ── Toasts ───────────────────────────────────────────────────────────────────
  function toast(msg){
    var host = el("toasts");
    var t = txt("div", "toast", msg);
    host.appendChild(t);
    setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); }, 3200);
  }

  // ── Utils ────────────────────────────────────────────────────────────────────
  function fmtMs(ms){
    if(ms < 1000) return Math.round(ms) + "ms";
    return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
  }
  function relTime(ts){
    if(!ts) return "";
    var d = Date.now() - ts; if(d < 0) d = 0;
    var s = Math.floor(d / 1000);
    if(s < 45) return "just now";
    var m = Math.floor(s / 60); if(m < 60) return m + "m ago";
    var h = Math.floor(m / 60); if(h < 24) return h + "h ago";
    var day = Math.floor(h / 24); if(day < 7) return day + "d ago";
    var wk = Math.floor(day / 7); if(wk < 5) return wk + "w ago";
    try { return new Date(ts).toLocaleDateString(); } catch(e){ return ""; }
  }

  // ── Wiring ───────────────────────────────────────────────────────────────────
  function wire(){
    messagesEl.addEventListener("scroll", function(){ stick = nearBottom(); });

    el("newBtn").onclick = doNew;
    el("themeBtn").onclick = cycleTheme;
    el("renameBtn").onclick = function(){
      var c = null;
      for(var i = 0; i < convCache.length; i++){ if(convCache[i].id === currentId){ c = convCache[i]; break; } }
      if(c) doRename(c); else if(currentId) doRename({ id: currentId, title: titleEl.textContent });
    };
    el("undoBtn").onclick = doUndo;
    changesBtnEl.onclick = toggleDrawer;
    el("drawerClose").onclick = closeDrawer;
    el("diffBtn").onclick = showDiff;
    stopBtnEl.onclick = doStop;
    el("menuBtn").onclick = openNav;
    scrimEl.onclick = closeNav;

    var searchEl = el("search");
    var searchTimer = null;
    searchEl.addEventListener("input", function(){
      if(searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function(){ loadList(searchEl.value); }, 200);
    });

    el("composer").addEventListener("submit", function(e){ e.preventDefault(); send(); });
    inputEl.addEventListener("input", function(){ autoGrow(); sendBtnEl.disabled = inputEl.disabled || !inputEl.value.trim(); });
    inputEl.addEventListener("compositionstart", function(){ composing = true; });
    inputEl.addEventListener("compositionend", function(){ composing = false; });
    inputEl.addEventListener("keydown", function(e){
      if(e.key === "Enter" && !e.shiftKey && !composing){ e.preventDefault(); send(); }
    });

    document.addEventListener("keydown", function(e){
      if(e.key === "Escape"){
        if(drawerEl.classList.contains("open")) closeDrawer();
        else if(appEl.classList.contains("nav-open")) closeNav();
      }
    });

    // Refresh relative timestamps periodically.
    setInterval(function(){ if(!listTimer && convCache.length) renderList(convCache, el("search").value); }, 60000);
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────
  function boot(){
    messagesEl = el("messages"); listEl = el("convList"); convEmptyEl = el("convEmpty");
    mainEmptyEl = el("mainEmpty"); titleEl = el("convTitle"); routeEl = el("routeInfo");
    drawerEl = el("drawer"); filesListEl = el("filesList"); diffViewEl = el("diffView");
    changesBtnEl = el("changesBtn"); runBannerEl = el("runBanner"); runLabelEl = el("runLabel");
    stopBtnEl = el("stopBtn"); inputEl = el("input"); sendBtnEl = el("sendBtn");
    appEl = el("app"); scrimEl = el("scrim");

    initTheme();
    setMascot("ready");
    el("ver").textContent = KITTEN.version ? "v" + KITTEN.version : "";
    var cwd = KITTEN.cwd || "";
    el("cwd").textContent = cwd; el("cwd").title = cwd;
    wire();

    loadList("").then(function(){
      var wanted = null;
      try { wanted = new URLSearchParams(window.location.search).get("c"); } catch(e){}
      if(wanted){ selectConversation(wanted); }
      else if(convCache.length){ selectConversation(convCache[0].id); }
      else { showNoneSelected(); }
    });
  }

  if(document.readyState === "loading"){ document.addEventListener("DOMContentLoaded", boot); }
  else { boot(); }
})();
`;
