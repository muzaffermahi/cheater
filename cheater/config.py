"""Cheater configuration system.

Locations:
  - project config:  .cheater/config.toml   (checked into the user's repo, optional)
  - user config:     ~/.config/cheater/config.toml  (cross-project defaults)
  - session data:    .cheater/sessions/  (managed by cheater.sessions)

Format: TOML. If tomli/tomllib is not available, a tiny parser handles
key = "value" lines (sufficient for our config keys).

Public API:
  load_config(start_dir=...)   -> CheaterConfig
  save_config(config, path)   -> None
  config_path_for(start_dir)  -> Optional[Path]
  user_config_path()          -> Path

Defaults are minimal and safe (no model, ask mode, balanced memory).
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_USER_DIR = Path.home() / ".config" / "cheater"


@dataclass
class MemoryConfig:
    mode: str = "balanced"  # off | compact | balanced | aggressive
    quality_min: float = 0.0
    top_k: int = 5
    same_language_boost: float = 0.1
    mmr_lambda: float = 0.0
    compact_first: bool = False
    compact_cards_path: str = ""  # optional


@dataclass
class ProviderSettings:
    provider: str = "none"  # none | openai
    model: str = ""
    base_url: str = ""
    api_key: str = ""  # only stored in local config files; redacted in logs
    temperature: float = 0.2
    max_tokens: int = 1024
    timeout: float = 60.0
    max_retries: int = 2


@dataclass
class PermissionsConfig:
    mode: str = "ask"  # ask | plan | build | review
    allow_shell: bool = False
    allow_write: bool = False
    allow_apply_patch: bool = False
    auto_yes: bool = False  # never True by default; CLI flag only


@dataclass
class ArenaDistillConfig:
    """Settings for the arena + distiller + tool-policy layer.

    Added in v0.7 to make the self-improvement layer observable and
    tunable from a single config file.
    """

    trace_enabled: bool = True
    trace_full_prompts: bool = False
    context_budget: str = "normal"  # tiny | small | normal | large | int
    arena_default_cases: str = ".cheater/eval_cases"
    distill_min_success_only: bool = True
    tool_policy_enabled: bool = True
    janitor_auto_apply: bool = False


@dataclass
class CheaterConfig:
    """Top-level Cheater configuration."""

    project_root: str = ""
    cards_path: str = "data/cards/cards.v1.jsonl"
    sample_cards_path: str = "data/samples/sample_cards.v1.jsonl"
    heldout_bench_path: str = "data/benchmarks/heldout_retrieval.v1.jsonl"
    sample_bench_path: str = "data/benchmarks/sample_benchmark.jsonl"
    mode: str = "ask"  # ask | plan | build | review | bench
    memory: MemoryConfig = field(default_factory=MemoryConfig)
    provider: ProviderSettings = field(default_factory=ProviderSettings)
    permissions: PermissionsConfig = field(default_factory=PermissionsConfig)
    arena: ArenaDistillConfig = field(default_factory=ArenaDistillConfig)
    first_run_done: bool = False
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        # Redact api_key for any logging
        if d.get("provider", {}).get("api_key"):
            d["provider"]["api_key"] = "***REDACTED***"
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "CheaterConfig":
        mem = d.get("memory") or {}
        prov = d.get("provider") or {}
        perms = d.get("permissions") or {}
        arena_d = d.get("arena") or {}
        return cls(
            project_root=d.get("project_root", "") or "",
            cards_path=d.get("cards_path", "data/cards/cards.v1.jsonl"),
            sample_cards_path=d.get(
                "sample_cards_path", "data/samples/sample_cards.v1.jsonl"
            ),
            heldout_bench_path=d.get(
                "heldout_bench_path", "data/benchmarks/heldout_retrieval.v1.jsonl"
            ),
            sample_bench_path=d.get(
                "sample_bench_path", "data/benchmarks/sample_benchmark.jsonl"
            ),
            mode=d.get("mode", "ask"),
            memory=MemoryConfig(
                mode=mem.get("mode", "balanced"),
                quality_min=float(mem.get("quality_min", 0.0)),
                top_k=int(mem.get("top_k", 5)),
                same_language_boost=float(mem.get("same_language_boost", 0.1)),
                mmr_lambda=float(mem.get("mmr_lambda", 0.0)),
                compact_first=bool(mem.get("compact_first", False)),
                compact_cards_path=mem.get("compact_cards_path", ""),
            ),
            provider=ProviderSettings(
                provider=prov.get("provider", "none"),
                model=prov.get("model", ""),
                base_url=prov.get("base_url", ""),
                api_key=prov.get("api_key", ""),
                temperature=float(prov.get("temperature", 0.2)),
                max_tokens=int(prov.get("max_tokens", 1024)),
                timeout=float(prov.get("timeout", 60.0)),
                max_retries=int(prov.get("max_retries", 2)),
            ),
            permissions=PermissionsConfig(
                mode=perms.get("mode", "ask"),
                allow_shell=bool(perms.get("allow_shell", False)),
                allow_write=bool(perms.get("allow_write", False)),
                allow_apply_patch=bool(perms.get("allow_apply_patch", False)),
                auto_yes=bool(perms.get("auto_yes", False)),
            ),
            arena=ArenaDistillConfig(
                trace_enabled=bool(arena_d.get("trace_enabled", True)),
                trace_full_prompts=bool(arena_d.get("trace_full_prompts", False)),
                context_budget=str(arena_d.get("context_budget", "normal")),
                arena_default_cases=str(
                    arena_d.get("arena_default_cases", ".cheater/eval_cases")
                ),
                distill_min_success_only=bool(
                    arena_d.get("distill_min_success_only", True)
                ),
                tool_policy_enabled=bool(arena_d.get("tool_policy_enabled", True)),
                janitor_auto_apply=bool(arena_d.get("janitor_auto_apply", False)),
            ),
            first_run_done=bool(d.get("first_run_done", False)),
            extra=d.get("extra", {}) or {},
        )


def _toml_load(text: str) -> dict[str, Any]:
    """Tiny TOML loader handling [section] headers and key = "value" pairs.

    Good enough for our config files. We intentionally avoid depending on
    tomli/tomllib so this works on bare Python.
    """
    out: dict[str, Any] = {}
    cur_section = ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            cur_section = line[1:-1].strip()
            if cur_section not in out:
                out[cur_section] = {}
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        target: dict[str, Any] = out[cur_section] if cur_section else out
        if (val.startswith('"') and val.endswith('"')) or (
            val.startswith("'") and val.endswith("'")
        ):
            target[key] = val[1:-1]
        elif val.lower() in ("true", "false"):
            target[key] = val.lower() == "true"
        else:
            try:
                if "." in val:
                    target[key] = float(val)
                else:
                    target[key] = int(val)
            except ValueError:
                target[key] = val
    return out


def _toml_dump(d: dict[str, Any]) -> str:
    """Tiny TOML emitter handling flat dicts and [section] dicts."""
    lines: list[str] = []
    # Flat keys first
    for k, v in d.items():
        if isinstance(v, dict):
            continue
        lines.append(f"{k} = {_toml_value(v)}")
    # Sections
    for k, v in d.items():
        if not isinstance(v, dict):
            continue
        lines.append("")
        lines.append(f"[{k}]")
        for k2, v2 in v.items():
            lines.append(f"{k2} = {_toml_value(v2)}")
    return "\n".join(lines) + "\n"


def _toml_value(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v)
    return f'"{s}"'


def user_config_path() -> Path:
    """Return the user config path. Created on demand."""
    return DEFAULT_USER_DIR / "config.toml"


def project_config_path(start_dir: str | Path | None = None) -> Path | None:
    """Find the project config by walking up from start_dir. Returns None if not found."""
    cur = Path(start_dir or os.getcwd()).resolve()
    for parent in [cur, *cur.parents]:
        candidate = parent / ".cheater" / "config.toml"
        if candidate.is_file():
            return candidate
    return None


def load_config(start_dir: str | Path | None = None) -> CheaterConfig:
    """Load config: project first, then user, then env. Never raises.

    Project config overrides user config. Env vars override both. Missing
    files are silently ignored.
    """
    cfg = CheaterConfig()
    # 1. Project config
    p_path = project_config_path(start_dir)
    if p_path:
        try:
            raw = _toml_load(p_path.read_text(encoding="utf-8"))
            cfg = CheaterConfig.from_dict(raw)
        except (OSError, ValueError):
            pass
    # 2. User config (overrides project)
    u_path = user_config_path()
    if u_path.is_file():
        try:
            raw = _toml_load(u_path.read_text(encoding="utf-8"))
            user_cfg = CheaterConfig.from_dict(raw)
            # Merge: user wins on scalar fields; sections merged with user winning
            cfg.mode = user_cfg.mode or cfg.mode
            cfg.memory = _merge_dataclass(cfg.memory, user_cfg.memory, MemoryConfig)
            cfg.provider = _merge_dataclass(
                cfg.provider, user_cfg.provider, ProviderSettings
            )
            cfg.permissions = _merge_dataclass(
                cfg.permissions, user_cfg.permissions, PermissionsConfig
            )
            cfg.arena = _merge_dataclass(cfg.arena, user_cfg.arena, ArenaDistillConfig)
            cfg.first_run_done = cfg.first_run_done or user_cfg.first_run_done
        except (OSError, ValueError):
            pass
    # 3. Env vars (overrides both)
    env_provider = os.environ.get("CHEATER_PROVIDER")
    if env_provider:
        cfg.provider.provider = env_provider
    env_model = os.environ.get("CHEATER_MODEL")
    if env_model:
        cfg.provider.model = env_model
    env_base = os.environ.get("CHEATER_BASE_URL")
    if env_base:
        cfg.provider.base_url = env_base
    env_key = os.environ.get("CHEATER_API_KEY")
    if env_key:
        cfg.provider.api_key = env_key
    # 4. Project root detection
    if start_dir:
        cfg.project_root = str(Path(start_dir).resolve())
    elif not cfg.project_root:
        cfg.project_root = os.getcwd()
    return cfg


def _merge_dataclass(a: Any, b: Any, cls: type) -> Any:
    """Merge two dataclass instances. Non-default values from b win."""
    if b is None:
        return a
    if a is None:
        return b
    a_d = asdict(a)
    b_d = asdict(b)
    merged = dict(a_d)
    for k, v in b_d.items():
        if v is None:
            continue
        if isinstance(v, dict) and not v:
            continue
        if isinstance(v, str) and v == "":
            continue
        merged[k] = v
    return cls(**merged)


def save_config(cfg: CheaterConfig, path: str | Path) -> None:
    """Save config to a TOML file. Creates parent dirs. Redacts nothing (user file)."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    d = asdict(cfg)
    p.write_text(_toml_dump(d), encoding="utf-8")


def first_run_wizard(
    cfg: CheaterConfig, *, noninteractive: bool = False
) -> CheaterConfig:
    """Run a first-run setup. Updates cfg in place.

    noninteractive=True: pick safe defaults (no model, ask mode).
    noninteractive=False: interactively ask the user.
    """
    if noninteractive:
        cfg.first_run_done = True
        return cfg
    # Interactive prompts (lazy import for testability)
    import sys

    out = sys.stdout
    out.write("\n=== Cheater first-run setup ===\n")
    out.write("Detected project root: " + cfg.project_root + "\n")
    out.write("\nSelect a mode:\n")
    out.write("  1) ask     (read-only; explore, search, guide, no edits) [default]\n")
    out.write("  2) plan    (read-only + plan; produces step plans)\n")
    out.write("  3) build   (edit with confirm; can apply patches)\n")
    out.write("  4) review  (review current git diff; suggest fixes)\n")
    out.write("  5) bench   (run benchmarks)\n")
    choice = input("mode [1/2/3/4/5, default 1]: ").strip() or "1"
    mode_map = {"1": "ask", "2": "plan", "3": "build", "4": "review", "5": "bench"}
    cfg.mode = mode_map.get(choice, "ask")
    cfg.permissions.mode = cfg.mode
    cfg.permissions.allow_shell = cfg.mode in ("build",)
    cfg.permissions.allow_write = cfg.mode in ("build",)
    cfg.permissions.allow_apply_patch = cfg.mode in ("build",)

    out.write("\nSelect a model provider (you can change this later):\n")
    out.write("  1) none    (deterministic; no LLM) [default]\n")
    out.write(
        "  2) openai  (OpenAI-compatible; works with LM Studio, Ollama /v1, etc.)\n"
    )
    pchoice = input("provider [1/2, default 1]: ").strip() or "1"
    if pchoice == "2":
        cfg.provider.provider = "openai"
        cfg.provider.base_url = input(
            "base_url (e.g. http://localhost:1234/v1): "
        ).strip()
        cfg.provider.model = input("model (e.g. qwen2.5-coder-7b-instruct): ").strip()
        key = input("api_key (leave blank for local): ").strip()
        cfg.provider.api_key = key
    else:
        cfg.provider.provider = "none"

    out.write("\nSelect memory mode:\n")
    out.write("  1) off\n")
    out.write("  2) compact  (top-3, high-quality only)\n")
    out.write("  3) balanced (top-5, default) [default]\n")
    out.write("  4) aggressive (top-10, low quality-min)\n")
    mchoice = input("memory [1/2/3/4, default 3]: ").strip() or "3"
    mem_map = {"1": "off", "2": "compact", "3": "balanced", "4": "aggressive"}
    cfg.memory.mode = mem_map.get(mchoice, "balanced")
    cfg.memory.top_k = {"off": 0, "compact": 3, "balanced": 5, "aggressive": 10}[
        cfg.memory.mode
    ]

    cfg.first_run_done = True
    out.write("\n=== Setup complete ===\n")
    out.write(f"Mode:     {cfg.mode}\n")
    out.write(f"Provider: {cfg.provider.provider}\n")
    out.write(f"Memory:   {cfg.memory.mode}\n")
    out.write(
        "\nYou can edit these later in .cheater/config.toml or "
        "~/.config/cheater/config.toml.\n"
    )
    return cfg
