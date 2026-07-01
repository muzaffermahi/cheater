"""Visual theme for the Cheater Cockpit.

We keep all colors and the global CSS in one place so the rest of the
package can stay focused on behaviour. The theme is intentionally subtle:
no neon, no emoji dependency, no bright-on-bright.

The CSS string is read by the main :class:`~cheater.tui.app.CheaterCockpit`
at startup and applied to the app.
"""

from __future__ import annotations

# --- palette ---
# A small, dependency-free palette. Names describe intent, not hue.
SUCCESS = "#7fc8a9"  # calm green
WARNING = "#e6c07b"  # amber
ERROR = "#e06c75"  # warm red
MUTED = "#5c6370"  # dim grey
ACCENT = "#61afef"  # soft blue
RUNNING = "#c678dd"  # purple while something is live
PANEL_BG = "#1d2128"  # very dark surface
BORDER_DIM = "#3a3f4b"
BORDER_FOCUS = "#61afef"
TEXT = "#d4d4d4"
TEXT_DIM = "#9ba1ad"

PALETTE: dict[str, str] = {
    "success": SUCCESS,
    "warning": WARNING,
    "error": ERROR,
    "muted": MUTED,
    "accent": ACCENT,
    "running": RUNNING,
    "text": TEXT,
    "text-dim": TEXT_DIM,
    "border-dim": BORDER_DIM,
    "border-focus": BORDER_FOCUS,
    "panel-bg": PANEL_BG,
}


# --- global CSS ---
# We use textual CSS syntax. Keep it compact. Compact mode is selected
# by toggling the `.compact` class on :root.
APP_CSS = """
/* Cheater Cockpit theme variables */
$success: #7fc8a9;
$warning: #e6c07b;
$error: #e06c75;
$muted: #5c6370;
$accent: #61afef;
$running: #c678dd;
$text: #d4d4d4;
$text-dim: #9ba1ad;
$border-dim: #3a3f4b;
$panel-bg: #1d2128;

Screen {
    background: $panel-bg;
    color: $text;
}

/* --- top status bar --- */
#status {
    dock: top;
    height: 1;
    background: #21252b;
    color: $text-dim;
    padding: 0 1;
}
#status .mode { color: $accent; }
#status .running { color: $running; }
#status .ok { color: $success; }
#status .warn { color: $warning; }
#status .err { color: $error; }
#status .sep { color: $border-dim; }

/* --- 3-pane layout --- */
#layout {
    layout: horizontal;
    height: 1fr;
}

#sidebar {
    width: 28;
    min-width: 20;
    background: #181a1f;
    border-right: tall $border-dim;
    padding: 1 1;
}
#sidebar Static.title { color: $accent; text-style: bold; }
#sidebar .item { padding: 0 1; }
#sidebar .item:hover { background: #2a2f37; }
#sidebar .item.active { background: #2a3441; color: $text; text-style: bold; }
#sidebar .item .badge { color: $text-dim; }
#sidebar .dim { color: $text-dim; }

#main {
    width: 1fr;
    border-right: tall $border-dim;
}

/* Right inspector is hidden by default; .with-inspector toggles it */
#inspector {
    width: 36;
    min-width: 28;
    background: #181a1f;
    border-left: tall $border-dim;
    padding: 1 1;
    display: none;
}
#inspector Static.section { color: $accent; text-style: bold; padding-top: 1; }
#inspector .k { color: $text-dim; }
#inspector .v { color: $text; }
#inspector .pill { color: $text-dim; }
.with-inspector #inspector { display: block; }

/* --- center area --- */
#center {
    height: 1fr;
    layout: vertical;
}

#tabs {
    dock: top;
    height: 1;
    background: #1a1d23;
}
#tabs > Tab {
    padding: 0 2;
}
#tabs > Tab.--active {
    color: $accent;
    text-style: bold;
}

#transcript {
    height: 1fr;
    padding: 0 1;
    background: $panel-bg;
    overflow-y: auto;
}

/* --- composer + status bar --- */
#composer-wrap {
    dock: bottom;
    height: auto;
    background: #1a1d23;
    border-top: tall $border-dim;
    padding: 0 1;
}
#slash-hint {
    height: 1;
    color: $text-dim;
    padding: 0 1;
}
#composer {
    height: 3;
    background: #1a1d23;
    border: none;
}
#composer:focus {
    border: none;
}
#status-bar {
    dock: bottom;
    height: 1;
    background: #14161a;
    color: $text-dim;
    padding: 0 1;
}
#status-bar .running { color: $running; }
#status-bar .ok { color: $success; }
#status-bar .warn { color: $warning; }
#status-bar .err { color: $error; }
#status-bar .sep { color: $border-dim; }
#status-bar .accent { color: $accent; }

/* --- generic widgets --- */
.event-card {
    height: auto;
    margin: 0 0 1 0;
    padding: 0 1;
    background: #1d2128;
    border: round $border-dim;
}
.event-card.success { border: round $success; }
.event-card.error { border: round $error; }
.event-card.warning { border: round $warning; }
.event-card.running { border: round $running; }
.event-card .head { color: $accent; }
.event-card .meta { color: $text-dim; }
.event-card .body { color: $text; padding: 0 0 1 0; }
.event-card.collapsed .body { display: none; }

.role-user {
    background: #1f242c;
    border-left: thick $accent;
    padding: 0 1;
    margin: 0 0 1 0;
    height: auto;
}
.role-assistant {
    background: #1a1d23;
    border-left: thick $running;
    padding: 0 1;
    margin: 0 0 1 0;
    height: auto;
}
.role-system {
    color: $text-dim;
    padding: 0 1;
    margin: 0 0 1 0;
    height: auto;
}
.role-error {
    background: #2a1f1f;
    border-left: thick $error;
    color: $error;
    padding: 0 1;
    margin: 0 0 1 0;
    height: auto;
}

.modal-screen {
    align: center middle;
}
.modal {
    width: 80%;
    max-width: 120;
    height: 80%;
    max-height: 32;
    background: $panel-bg;
    border: thick $accent;
    padding: 1 2;
}
.modal .title { color: $accent; text-style: bold; padding: 0 0 1 0; }
.modal .hint { color: $text-dim; padding: 0 0 1 0; }

.empty {
    color: $text-dim;
    padding: 1 2;
}

.list-row {
    height: 1;
    padding: 0 1;
}
.list-row.active {
    background: #2a3441;
    color: $text;
    text-style: bold;
}

.kv {
    height: auto;
}
.kv .k { width: 1fr; color: $text-dim; }
.kv .v { width: 2fr; color: $text; }

/* --- compact mode --- */
.compact #sidebar { width: 18; }
.compact #inspector { width: 28; }
.compact #composer { height: 2; }
.compact .event-card { margin: 0; }
.compact .role-user, .compact .role-assistant { padding: 0; }
"""


def style(s: str, kind: str) -> str:
    """Wrap a string in a Textual markup span for the given semantic kind.

    ``kind`` is one of: success, warning, error, muted, accent, running, text.
    """
    color = PALETTE.get(kind, PALETTE["text"])
    return f"[{color}]{s}[/]"
