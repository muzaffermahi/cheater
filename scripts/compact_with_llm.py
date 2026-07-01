"""LLM-compact a memory-card corpus using an OpenAI-compatible endpoint.

The default endpoint is Alibaba Cloud DashScope (OpenAI-compatible chat
completions). The default model is `deepseek-v3.1` (the closest real
DeepSeek model on DashScope as of writing — there is no published
"DeepSeek V4 Flash" on DashScope yet; see the note below).

You can point this at any OpenAI-compatible endpoint by overriding
--base-url, --model, and --api-key. That includes:
  - DashScope (Alibaba Cloud Model Studio)
  - OpenAI
  - LM Studio (local)
  - Ollama's /v1 (local)
  - OpenRouter, Together, etc.

ENVIRONMENT VARIABLES (defaults; override with --base-url, --model, --api-key):
  LLM_PROVIDER       = alibaba-cloud-model-studio
  LLM_BASE_URL       = https://ws-js7otw156ipsmyhg.eu-central-1.maas.aliyuncs.com/compatible-mode/v1
  LLM_MODEL          = deepseek-v4-flash
  DASHSCOPE_API_KEY  = sk-...   (your Alibaba Cloud Model Studio key)

CHEATER_LLM_* env vars override LLM_* if both are set.
CHEATER_API_KEY is also honored for the API key.

This script:
  - Streams a v1 card JSONL in chunks
  - Sends each card to the model with a strict JSON schema prompt
  - Validates the response against the v1 schema
  - Computes a quality score for the compacted card
  - Writes a new v1 JSONL that matches cheater/quality.py expectations
  - Supports --resume to skip already-compacted ids
  - Supports --limit, --max-concurrent, --dry-run, --json
  - Handles provider errors with retries + exponential backoff
  - Never calls the API during import time

Public API: run(args) -> int
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

# ----- defaults (env-driven; see module docstring) -----

DEFAULT_PROVIDER = os.environ.get("LLM_PROVIDER", "alibaba-cloud-model-studio")
DEFAULT_BASE_URL = os.environ.get(
    "LLM_BASE_URL",
    "https://ws-js7otw156ipsmyhg.eu-central-1.maas.aliyuncs.com/compatible-mode/v1",
)
DEFAULT_MODEL = os.environ.get("LLM_MODEL", "deepseek-v4-flash")
DEFAULT_TIMEOUT = 60.0
DEFAULT_MAX_RETRIES = 4
DEFAULT_MAX_TOKENS = 500
DEFAULT_TEMPERATURE = 0.1
DEFAULT_MAX_CONCURRENT = 12
DEFAULT_TRIM_INPUT = True
DEFAULT_TRIM_EMBED_CHARS = 1500

# Fields the model needs to do good compaction. Anything else is dropped
# before sending the input to the API.
KEEP_FIELDS: tuple[str, ...] = (
    "id",
    "source",
    "repo",
    "language",
    "bug_type",
    "symptom",
    "root_cause",
    "fix_pattern",
    "failed_approaches",
    "key_files",
    "search_keywords",
    "test_signal",
    "embedding_text",
)

# A very small test-only endpoint: LM Studio default. Do NOT default to a
# paid endpoint; require --api-key for that path.
LOCAL_DEFAULT_BASE_URL = "http://localhost:1234/v1"

# Compaction prompt: take a noisy v1 card and produce a clean, structured
# compact card that the cheater guide + retrieval can use directly.
COMPACTION_SYSTEM = """\
You are a precise bug-compaction assistant. You receive a JSON object \
representing one real bug from a public OSS repository. Your job is to \
return a single, clean JSON object that an LLM coding agent can use to \
diagnose and fix similar bugs in a different repository.

Rules:
  1. Output ONLY a single JSON object. No prose, no markdown, no code fences.
  2. Preserve the original `id`, `repo`, and `language` from the input.
     If `repo` or `language` is missing, fill with a short string from the \
     card text or "(unknown)". Do NOT invent a repo or language.
  3. `bug_type`: one short, concrete phrase (e.g. "TypeError in env var \
     parser", "Async cleanup race", "off-by-one in pagination"). Do NOT use \
     generic phrases like "bug" or "error".
  4. `symptom`: 1-2 sentences, concrete (error messages, function names, \
     file paths if present in the input). No marketing prose.
  5. `root_cause`: 1-3 sentences, the actual mechanism. Cite a file or \
     function if known.
  6. `fix_pattern`: 2-4 sentences, the minimal change. Concrete enough \
     that a developer reading it knows what to do.
  7. `failed_approaches`: a JSON array of short strings (1 sentence each). \
     Include things tried that did not work. Empty array if none. Never null.
  8. `key_files`: a JSON array of file paths. Empty array if none known.
  9. `search_keywords`: a JSON array of 3-8 lowercase strings that another \
     developer would type when searching for this bug. Do NOT include \
     the repo name.
 10. `test_signal`: a short string naming a failing test, function, or \
     command. Empty string if none.
 11. `embedding_text`: a single string, 1-3 sentences, summarizing the \
     card. Should be highly searchable and self-contained.
 12. NEVER invent details. If the input does not contain enough \
     information, output the field with an empty string / empty array \
     and DO NOT make things up. Honesty is more important than completeness.
"""

COMPACTION_USER_TEMPLATE = """\
Input card (JSON):
```json
{input_card}
```

Return the compacted JSON object now. No prose.
"""


# ----- data types -----

@dataclass
class CompactionResult:
    """The result of compacting one card."""
    input_id: str
    output_card: dict[str, Any] | None
    error: str = ""
    elapsed: float = 0.0
    attempts: int = 0


@dataclass
class CompactionSummary:
    """Aggregate stats for a compaction run."""
    total: int = 0
    compacted: int = 0
    skipped_already_present: int = 0
    failed: int = 0
    low_quality: int = 0
    elapsed: float = 0.0
    attempts: int = 0
    quality_tiers: dict[str, int] = field(default_factory=dict)
    failures_by_reason: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total": self.total,
            "compacted": self.compacted,
            "skipped_already_present": self.skipped_already_present,
            "failed": self.failed,
            "low_quality": self.low_quality,
            "elapsed": round(self.elapsed, 2),
            "attempts": self.attempts,
            "quality_tiers": self.quality_tiers,
            "failures_by_reason": self.failures_by_reason,
        }


# ----- core helpers -----

def _load_existing_ids(out_path: Path) -> set[str]:
    """Read output JSONL and return the set of ids already written. For --resume."""
    ids: set[str] = set()
    if not out_path.is_file():
        return ids
    with out_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            cid = obj.get("id")
            if isinstance(cid, str) and cid:
                ids.add(cid)
    return ids


def _stream_cards(path: Path) -> Iterable[dict[str, Any]]:
    """Stream JSONL cards from `path`. Skips blank/invalid lines."""
    if not path.is_file():
        return
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                yield obj


def _call_provider(
    base_url: str,
    api_key: str,
    model: str,
    system: str,
    user: str,
    *,
    timeout: float,
    max_retries: int,
    temperature: float,
    max_tokens: int,
    response_format_json: bool = True,
) -> str:
    """Call an OpenAI-compatible chat-completions endpoint with retries.

    Returns the assistant message text. Raises RuntimeError on persistent failure.
    """
    if not base_url:
        raise RuntimeError("base_url is required (e.g. https://dashscope.aliyuncs.com/compatible-mode/v1)")
    if not model:
        raise RuntimeError("model is required (e.g. deepseek-v3.1)")
    url = base_url.rstrip("/") + "/chat/completions"
    body: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if response_format_json:
        body["response_format"] = {"type": "json_object"}
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    data = json.dumps(body).encode("utf-8")
    last_err: str = ""
    for attempt in range(max_retries + 1):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            return payload["choices"][0]["message"]["content"] or ""
        except urllib.error.HTTPError as e:
            body_text = ""
            try:
                body_text = e.read().decode("utf-8", errors="ignore")
            except Exception:
                pass
            last_err = f"HTTP {e.code}: {body_text[:300]}"
            # Retry on 429 / 5xx
            if e.code in (429, 500, 502, 503, 504) and attempt < max_retries:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(last_err) from e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_err = f"{type(e).__name__}: {e}"
            if attempt < max_retries:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(last_err) from e
    raise RuntimeError(last_err or "unknown provider failure")


_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*\n(.*?)\n```", re.DOTALL)


def _parse_json_response(text: str) -> dict[str, Any] | None:
    """Extract a JSON object from a model response. Tolerates code fences."""
    if not text:
        return None
    # Strip code fences if present
    m = _JSON_FENCE_RE.search(text)
    if m:
        text = m.group(1)
    # Find the first { and the last matching }
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    end = -1
    in_str = False
    esc = False
    for i in range(start, len(text)):
        c = text[i]
        if esc:
            esc = False
            continue
        if c == "\\":
            esc = True
            continue
        if c == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end < 0:
        return None
    candidate = text[start:end + 1]
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        return None


def _coerce_str(v: Any) -> str:
    return "" if v is None else (v if isinstance(v, str) else str(v))


def _coerce_str_list(v: Any) -> list[str]:
    if v is None:
        return []
    if isinstance(v, list):
        return [_coerce_str(x) for x in v if x is not None]
    if isinstance(v, str):
        # Split on commas / newlines if model returned a string
        parts = re.split(r"[,\n;]+", v)
        return [p.strip() for p in parts if p.strip()]
    return [str(v)]


def _trim_input_card(
    card: dict[str, Any],
    *,
    keep_fields: tuple[str, ...] = KEEP_FIELDS,
    max_embed_chars: int = DEFAULT_TRIM_EMBED_CHARS,
) -> tuple[dict[str, Any], int, int]:
    """Trim a raw v1 card down to the fields the compaction model needs.

    Returns (trimmed_card, original_size, trimmed_size) in characters
    (of the JSON serialization).
    """
    original = json.dumps(card, ensure_ascii=False)
    out: dict[str, Any] = {}
    for f in keep_fields:
        if f in card and card[f] is not None:
            v = card[f]
            if f == "embedding_text" and isinstance(v, str) and len(v) > max_embed_chars:
                v = v[:max_embed_chars].rstrip() + " … [truncated]"
            out[f] = v
    # If the card had no `id` in KEEP_FIELDS, preserve it anyway — the
    # validate step needs it.
    if "id" not in out and "id" in card:
        out["id"] = card["id"]
    trimmed = json.dumps(out, ensure_ascii=False)
    return out, len(original), len(trimmed)


def _validate_and_normalize(card: dict[str, Any], original: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """Validate a compacted card and merge it with the original v1 card.

    Returns (card, error). On error, card is None.
    """
    if not isinstance(card, dict):
        return None, "compacted card is not a JSON object"

    out: dict[str, Any] = {}

    # id: required, must match original if present
    cid = _coerce_str(card.get("id")) or _coerce_str(original.get("id"))
    if not cid:
        return None, "missing id"
    out["id"] = cid

    # repo, language
    out["repo"] = _coerce_str(card.get("repo")) or _coerce_str(original.get("repo")) or "(unknown)"
    out["language"] = _coerce_str(card.get("language")) or _coerce_str(original.get("language")) or "(unknown)"

    # bug_type: must be short, not a sentence
    bt = _coerce_str(card.get("bug_type"))
    if len(bt) > 120:
        bt = bt[:120].rstrip()
    out["bug_type"] = bt

    # symptom, root_cause, fix_pattern
    for k in ("symptom", "root_cause", "fix_pattern"):
        v = _coerce_str(card.get(k))
        out[k] = v

    # lists
    out["failed_approaches"] = _coerce_str_list(card.get("failed_approaches"))[:5]
    out["key_files"] = _coerce_str_list(card.get("key_files"))[:10]
    out["search_keywords"] = [s.lower() for s in _coerce_str_list(card.get("search_keywords"))[:12]]
    out["test_signal"] = _coerce_str(card.get("test_signal"))

    # embedding_text
    emb = _coerce_str(card.get("embedding_text"))
    if not emb:
        # Synthesize a small embedding_text from the other fields
        emb = " | ".join(
            x for x in (out["bug_type"], out["symptom"], out["root_cause"], out["fix_pattern"])
            if x
        )
    out["embedding_text"] = emb

    # Carry forward useful fields from the original card
    for k in ("source", "schema_version"):
        v = original.get(k)
        if v is not None:
            out[k] = v

    out["schema_version"] = out.get("schema_version") or "v1"
    out["compacted_by"] = "llm-compact"
    out["compacted_model"] = None  # filled in by caller
    out["usable"] = True
    return out, ""


def _compute_quality(card: dict[str, Any]) -> tuple[float, list[str]]:
    """Compute a simple quality score for a compacted card.

    This is intentionally simpler than cheater/quality.py (which is tuned
    for raw SWE-agent trajectory text). A compacted card should be
    SHORT and CONCRETE; we score those properties.
    """
    reasons: list[str] = []
    score = 1.0

    def penalize(amt: float, reason: str) -> None:
        nonlocal score
        score = max(0.0, score - amt)
        reasons.append(reason)

    sym = (card.get("symptom") or "").strip()
    if len(sym) < 20:
        penalize(0.3, "symptom too short")
    if len(sym) > 600:
        penalize(0.1, "symptom too long")

    rc = (card.get("root_cause") or "").strip()
    if len(rc) < 20:
        penalize(0.3, "root_cause too short")

    fp = (card.get("fix_pattern") or "").strip()
    if len(fp) < 20:
        penalize(0.3, "fix_pattern too short")
    if len(fp) > 1200:
        penalize(0.05, "fix_pattern too long")

    bt = (card.get("bug_type") or "").strip()
    if not bt:
        penalize(0.1, "bug_type missing")
    if bt and len(bt.split()) > 12:
        penalize(0.05, "bug_type is a sentence, not a phrase")

    kws = card.get("search_keywords") or []
    if not isinstance(kws, list) or len(kws) < 2:
        penalize(0.2, "search_keywords missing or < 2")

    if card.get("repo", "(unknown)") == "(unknown)":
        penalize(0.1, "repo missing (cross-project ambiguity risk)")

    if not card.get("embedding_text"):
        penalize(0.2, "embedding_text missing")

    return round(score, 3), reasons


def _quality_tier(score: float) -> str:
    if score >= 0.7:
        return "high"
    if score >= 0.4:
        return "medium"
    if score >= 0.2:
        return "low"
    return "junk"


# ----- single-card compaction -----

def compact_one(
    card: dict[str, Any],
    *,
    base_url: str,
    api_key: str,
    model: str,
    timeout: float,
    max_retries: int,
    temperature: float,
    max_tokens: int,
    quality_min: float = 0.0,
    trim_input: bool = True,
) -> CompactionResult:
    """Compact a single card. Returns a CompactionResult."""
    cid = str(card.get("id") or "?")
    if trim_input:
        payload_card, _orig_n, _trim_n = _trim_input_card(card)
    else:
        payload_card = card
    user = COMPACTION_USER_TEMPLATE.format(input_card=json.dumps(payload_card, ensure_ascii=False))
    start = time.time()
    attempts = 0
    try:
        text = _call_provider(
            base_url=base_url,
            api_key=api_key,
            model=model,
            system=COMPACTION_SYSTEM,
            user=user,
            timeout=timeout,
            max_retries=max_retries,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        attempts += 1
    except RuntimeError as e:
        return CompactionResult(
            input_id=cid,
            output_card=None,
            error=f"provider: {e}",
            elapsed=time.time() - start,
            attempts=1,
        )
    parsed = _parse_json_response(text)
    if parsed is None:
        return CompactionResult(
            input_id=cid,
            output_card=None,
            error="json_parse: model response was not parseable JSON",
            elapsed=time.time() - start,
            attempts=1,
        )
    out, err = _validate_and_normalize(parsed, card)
    if out is None:
        return CompactionResult(
            input_id=cid,
            output_card=None,
            error=f"validate: {err}",
            elapsed=time.time() - start,
            attempts=1,
        )
    score, reasons = _compute_quality(out)
    out["quality_score"] = score
    out["quality_tier"] = _quality_tier(score)
    out["quality_reasons"] = reasons
    out["compacted_model"] = model
    if quality_min > 0 and score < quality_min:
        return CompactionResult(
            input_id=cid,
            output_card=out,
            error=f"below_quality_min: score={score} < {quality_min}",
            elapsed=time.time() - start,
            attempts=1,
        )
    return CompactionResult(
        input_id=cid,
        output_card=out,
        error="",
        elapsed=time.time() - start,
        attempts=1,
    )


# ----- main CLI -----

def run(args: argparse.Namespace) -> int:
    # CLI > CHEATER_LLM_* > LLM_* > defaults
    base_url = (
        args.base_url
        or os.environ.get("CHEATER_LLM_BASE_URL")
        or os.environ.get("LLM_BASE_URL")
        or DEFAULT_BASE_URL
    )
    model = (
        args.model
        or os.environ.get("CHEATER_LLM_MODEL")
        or os.environ.get("LLM_MODEL")
        or DEFAULT_MODEL
    )
    api_key = (
        args.api_key
        or os.environ.get("CHEATER_LLM_API_KEY")
        or os.environ.get("DASHSCOPE_API_KEY")
        or os.environ.get("CHEATER_API_KEY")
        or ""
    )
    # max_tokens: CLI > env > default
    max_tokens = args.max_tokens
    if max_tokens is None:
        env_val = os.environ.get("CHEATER_LLM_MAX_TOKENS")
        if env_val:
            try:
                max_tokens = int(env_val)
            except ValueError:
                max_tokens = DEFAULT_MAX_TOKENS
        else:
            max_tokens = DEFAULT_MAX_TOKENS
    # max_concurrent: CLI > env > default
    max_concurrent = args.max_concurrent
    if max_concurrent is None:
        env_val = os.environ.get("CHEATER_LLM_MAX_CONCURRENT")
        if env_val:
            try:
                max_concurrent = int(env_val)
            except ValueError:
                max_concurrent = DEFAULT_MAX_CONCURRENT
        else:
            max_concurrent = DEFAULT_MAX_CONCURRENT
    # trim_input: CLI bool flag > env > default
    trim_input = bool(args.trim_input)
    if not args.trim_input_set:
        env_val = os.environ.get("CHEATER_LLM_TRIM_INPUT")
        if env_val is not None and env_val != "":
            trim_input = env_val not in ("0", "false", "False", "no", "NO")
        else:
            trim_input = DEFAULT_TRIM_INPUT

    in_path = Path(args.cards)
    out_path = Path(args.output)
    if not in_path.is_file():
        sys.stderr.write(f"Input file not found: {in_path}\n")
        return 2

    if not api_key:
        sys.stderr.write(
            "WARNING: no API key provided. Set DASHSCOPE_API_KEY, "
            "CHEATER_LLM_API_KEY, or pass --api-key.\n"
        )
    if not api_key and "localhost" not in base_url and "127.0.0.1" not in base_url:
        sys.stderr.write(
            f"WARNING: no API key and base_url={base_url!r} is not local. The call will likely 401.\n"
        )

    if args.dry_run:
        sys.stdout.write(
            f"DRY RUN: would compact {in_path} -> {out_path}\n"
            f"  base_url:      {base_url}\n"
            f"  model:         {model}\n"
            f"  api_key:       {'set (' + api_key[:4] + '...)' if api_key else 'MISSING'}\n"
            f"  max_tokens:    {max_tokens}\n"
            f"  max_concurrent:{max_concurrent}\n"
            f"  trim_input:    {trim_input}\n"
            f"  limit:         {args.limit}\n"
            f"  resume:        {args.resume}\n"
        )
        # Count input cards so the user can sanity-check
        n = sum(1 for _ in _stream_cards(in_path))
        sys.stdout.write(f"  input:         {n} cards\n")
        return 0

    out_path.parent.mkdir(parents=True, exist_ok=True)
    existing_ids = _load_existing_ids(out_path) if args.resume else set()

    # Concurrency
    max_workers = max(1, int(max_concurrent))

    summary = CompactionSummary()
    start_time = time.time()
    lock = threading.Lock()
    out_fh = out_path.open("a", encoding="utf-8")
    out_fh_lock = threading.Lock()

    def on_result(res: CompactionResult) -> None:
        with lock:
            summary.attempts = summary.attempts + res.attempts
            summary.elapsed = time.time() - start_time
            if res.error and "below_quality_min" in res.error:
                # Treated as "compacted but rejected"
                summary.compacted += 1
                summary.low_quality += 1
                return
            if res.error:
                summary.failed += 1
                key = res.error.split(":", 1)[0]
                summary.failures_by_reason[key] = summary.failures_by_reason.get(key, 0) + 1
                return
            if not res.output_card:
                summary.failed += 1
                return
            summary.compacted += 1
            tier = res.output_card.get("quality_tier", "?")
            summary.quality_tiers[tier] = summary.quality_tiers.get(tier, 0) + 1
            # Persist
            with out_fh_lock:
                out_fh.write(json.dumps(res.output_card, ensure_ascii=False) + "\n")
                out_fh.flush()

    def producer() -> Iterable[dict[str, Any]]:
        nonlocal summary  # type: ignore[misc]
        for c in _stream_cards(in_path):
            with lock:
                if summary.total >= args.limit:
                    return
                summary.total += 1
            cid = c.get("id")
            if args.resume and isinstance(cid, str) and cid in existing_ids:
                with lock:
                    summary.skipped_already_present += 1
                continue
            yield c

    sys.stderr.write(
        f"Compacting {in_path} -> {out_path}\n"
        f"  base_url:      {base_url}\n"
        f"  model:         {model}\n"
        f"  max_tokens:    {max_tokens}\n"
        f"  max_concurrent:{max_workers}\n"
        f"  trim_input:    {trim_input}\n"
        f"  limit:         {args.limit}\n"
        f"  resume:        {args.resume}\n"
        f"  quality_min:   {args.quality_min}\n"
    )
    sys.stderr.flush()

    done = 0
    progress_every = max(1, args.progress_every)
    if max_workers == 1:
        for c in producer():
            r = compact_one(
                c,
                base_url=base_url,
                api_key=api_key,
                model=model,
                timeout=args.timeout,
                max_retries=args.max_retries,
                temperature=args.temperature,
                max_tokens=max_tokens,
                quality_min=args.quality_min,
                trim_input=trim_input,
            )
            on_result(r)
            done += 1
            if done % progress_every == 0:
                with lock:
                    sys.stderr.write(
                        f"  progress: {summary.compacted}/{summary.total} compacted, "
                        f"{summary.failed} failed, {summary.skipped_already_present} skipped"
                        f"  ({summary.elapsed:.0f}s)\n"
                    )
                    sys.stderr.flush()
    else:
        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            futures = []
            for c in producer():
                fut = ex.submit(
                    compact_one,
                    c,
                    base_url=base_url,
                    api_key=api_key,
                    model=model,
                    timeout=args.timeout,
                    max_retries=args.max_retries,
                    temperature=args.temperature,
                    max_tokens=max_tokens,
                    quality_min=args.quality_min,
                    trim_input=trim_input,
                )
                futures.append(fut)
            for fut in as_completed(futures):
                r = fut.result()
                on_result(r)
                done += 1
                if done % progress_every == 0:
                    with lock:
                        sys.stderr.write(
                            f"  progress: {summary.compacted}/{summary.total} compacted, "
                            f"{summary.failed} failed, {summary.skipped_already_present} skipped"
                            f"  ({summary.elapsed:.0f}s)\n"
                        )
                        sys.stderr.flush()
    out_fh.close()

    if args.json:
        sys.stdout.write(json.dumps(summary.to_dict(), indent=2, ensure_ascii=False))
        sys.stdout.write("\n")
    else:
        sys.stdout.write("\n=== Compaction summary ===\n")
        sys.stdout.write(json.dumps(summary.to_dict(), indent=2, ensure_ascii=False))
        sys.stdout.write("\n")
    return 0 if summary.failed == 0 else 1


def build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="cheater-llm-compact",
        description=(
            "Compact a v1 memory-card JSONL using an OpenAI-compatible LLM. "
            "Default: Alibaba Cloud Model Studio + deepseek-v4-flash. "
            "Override via env (LLM_BASE_URL / LLM_MODEL / DASHSCOPE_API_KEY) "
            "or flags (--base-url / --model / --api-key)."
        ),
    )
    p.add_argument("--cards", required=True, help="Input v1 cards JSONL.")
    p.add_argument("--output", required=True, help="Output compacted v1 cards JSONL.")
    p.add_argument("--base-url", default=None,
                   help=f"OpenAI-compatible base URL. "
                        f"Default (env LLM_BASE_URL): {DEFAULT_BASE_URL}")
    p.add_argument("--model", default=None,
                   help=f"Model name. Default (env LLM_MODEL): {DEFAULT_MODEL}")
    p.add_argument("--api-key", default=None,
                   help="API key. Env: DASHSCOPE_API_KEY, CHEATER_LLM_API_KEY, CHEATER_API_KEY.")
    p.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    p.add_argument("--max-retries", type=int, default=DEFAULT_MAX_RETRIES)
    p.add_argument("--temperature", type=float, default=DEFAULT_TEMPERATURE)
    p.add_argument("--max-tokens", type=int, default=None,
                   help=f"Max output tokens per call (default: {DEFAULT_MAX_TOKENS}). "
                        f"Env: CHEATER_LLM_MAX_TOKENS.")
    p.add_argument("--limit", type=int, default=10**9, help="Stop after N input cards (default: all).")
    p.add_argument("--resume", action="store_true",
                   help="Skip ids already present in --output.")
    p.add_argument("--quality-min", type=float, default=0.0,
                   help="Drop compacted cards below this quality score (default: keep all).")
    p.add_argument("--max-concurrent", type=int, default=None,
                   help=f"Concurrent API calls (default: {DEFAULT_MAX_CONCURRENT}). "
                        f"Env: CHEATER_LLM_MAX_CONCURRENT. Lower if you see HTTP 429.")
    # BooleanOptionalAction is Python 3.9+; we require 3.10+ so it's safe.
    p.add_argument("--trim-input", dest="trim_input", action=argparse.BooleanOptionalAction,
                   default=None,
                   help=f"Trim the input card to the fields the model needs before sending "
                        f"(default: on). Default (env CHEATER_LLM_TRIM_INPUT): on. "
                        f"Disable with --no-trim-input if you see quality drop.")
    p.add_argument("--progress-every", type=int, default=10)
    p.add_argument("--dry-run", action="store_true",
                   help="Just print what would happen; do not call the API or write output.")
    p.add_argument("--json", action="store_true", help="Emit a JSON summary at the end.")
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_argparser()
    args = parser.parse_args(argv)
    # `args.trim_input` is None if the user did not pass --trim-input/--no-trim-input,
    # True if --trim-input, False if --no-trim-input.
    args.trim_input_set = args.trim_input is not None
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
