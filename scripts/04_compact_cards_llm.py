from __future__ import annotations

import argparse
import itertools
import json
import os
import time
from pathlib import Path
from typing import Any, Iterator

from openai import OpenAI


DEFAULT_INPUT = "data/solved_bug_cards.jsonl"
DEFAULT_OUTPUT = "data/compact_bug_cards.jsonl"
DEFAULT_MODEL = "deepseek-v4-flash"

SCHEMA_FIELDS = {
    "id": "string",
    "title": "string",
    "language_or_framework": "string",
    "bug_type": "string",
    "error_signature": "string",
    "symptoms": ["string"],
    "root_cause": "string",
    "fix_pattern": "string",
    "changed_files": ["string"],
    "patch_essence": "string",
    "when_to_use": ["string"],
    "avoid": ["string"],
    "search_text": "string",
}

SYSTEM_PROMPT = """You turn a solved coding issue and its patch into a compact memory card for a small coding agent.
Return exactly one JSON object and no Markdown, commentary, or code fences.

Focus on the reusable pattern: failure/symptom -> root cause -> fix pattern -> patch essence.
Do not include benchmark instructions, terminal tips, unrelated logs, or huge code blocks.
If there is no literal exception, describe the observable wrong behavior in error_signature.
Do not invent facts that are not supported by the issue or patch.
Keep every field compact and useful for retrieval.
search_text must be one compact paragraph optimized for retrieval.

Use exactly this schema:
""" + json.dumps(SCHEMA_FIELDS, ensure_ascii=False, indent=2)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compact solved bug cards with an OpenAI-compatible LLM.")
    parser.add_argument("--input", default=DEFAULT_INPUT, help="Raw solved-card JSONL file.")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Append-only compact-card JSONL file.")
    parser.add_argument("--limit", type=int, default=None, help="Maximum number of new cards to attempt.")
    parser.add_argument(
        "--batch-size",
        type=int,
        default=10,
        help="Cards per checkpoint batch (default: 10).",
    )
    parser.add_argument("--sleep", type=float, default=0.0, help="Seconds to sleep after each API request.")
    parser.add_argument("--model", default=None, help="Model name (overrides LLM_MODEL).")
    parser.add_argument("--base-url", default=None, help="API base URL (overrides LLM_BASE_URL).")
    parser.add_argument("--api-key", default=None, help="API key (overrides LLM_API_KEY).")
    args = parser.parse_args()
    if args.limit is not None and args.limit < 0:
        parser.error("--limit must be zero or greater")
    if args.sleep < 0:
        parser.error("--sleep must be zero or greater")
    if args.batch_size < 1:
        parser.error("--batch-size must be at least 1")
    return args


def load_completed_ids(path: Path) -> set[str]:
    completed: set[str] = set()
    if not path.exists():
        return completed

    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                card = json.loads(line)
            except json.JSONDecodeError:
                print(f"[WARN] Ignoring invalid output JSON on line {line_number}.")
                continue
            card_id = card.get("id")
            if card_id is not None:
                completed.add(str(card_id))
    return completed


def slim_card(card: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": card.get("id"),
        "model_name": card.get("model_name"),
        "target": card.get("target"),
        "issue": str(card.get("issue") or "")[:5000],
        "error_excerpt": str(card.get("error_excerpt") or "")[:1500],
        "changed_files": card.get("changed_files") or [],
        "patch_summary": card.get("patch_summary") or "",
        "patch": str(card.get("patch") or "")[:7000],
    }


def parse_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()

    try:
        value = json.loads(cleaned)
        if not isinstance(value, dict):
            raise ValueError("LLM response is not a JSON object")
        return value
    except json.JSONDecodeError:
        pass

    # Recover the first balanced {...} block, while respecting braces in strings.
    for start, char in enumerate(cleaned):
        if char != "{":
            continue
        depth = 0
        in_string = False
        escaped = False
        for end in range(start, len(cleaned)):
            current = cleaned[end]
            if in_string:
                if escaped:
                    escaped = False
                elif current == "\\":
                    escaped = True
                elif current == '"':
                    in_string = False
                continue
            if current == '"':
                in_string = True
            elif current == "{":
                depth += 1
            elif current == "}":
                depth -= 1
                if depth == 0:
                    try:
                        value = json.loads(cleaned[start : end + 1])
                    except json.JSONDecodeError:
                        break
                    if isinstance(value, dict):
                        return value
                    break
    raise ValueError("Could not find a valid JSON object in the LLM response")


def as_string(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def as_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [as_string(item) for item in value if as_string(item)]


def normalize_card(generated: dict[str, Any], raw: dict[str, Any]) -> dict[str, Any]:
    raw_id = as_string(raw.get("id"))
    compact = {
        "id": raw_id,
        "title": as_string(generated.get("title")),
        "language_or_framework": as_string(generated.get("language_or_framework")),
        "bug_type": as_string(generated.get("bug_type")),
        "error_signature": as_string(generated.get("error_signature")),
        "symptoms": as_string_list(generated.get("symptoms")),
        "root_cause": as_string(generated.get("root_cause")),
        "fix_pattern": as_string(generated.get("fix_pattern")),
        "changed_files": as_string_list(generated.get("changed_files")),
        "patch_essence": as_string(generated.get("patch_essence")),
        "when_to_use": as_string_list(generated.get("when_to_use")),
        "avoid": as_string_list(generated.get("avoid")),
        "search_text": as_string(generated.get("search_text")),
        "source": raw.get("source"),
        "model_name": raw.get("model_name"),
        "target": raw.get("target"),
        "original_changed_files": raw.get("changed_files") or [],
        "patch": raw.get("patch") or "",
    }
    if not compact["changed_files"]:
        compact["changed_files"] = as_string_list(raw.get("changed_files"))
    return compact


def request_compact_card(client: OpenAI, model: str, raw: dict[str, Any]) -> dict[str, Any]:
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": "Create the compact card from this evidence:\n"
                + json.dumps(slim_card(raw), ensure_ascii=False),
            },
        ],
        temperature=0.1,
    )
    content = response.choices[0].message.content
    if not content:
        raise ValueError("LLM returned an empty response")
    return parse_json_object(content)


def ensure_append_boundary(path: Path) -> None:
    if not path.exists() or path.stat().st_size == 0:
        return
    with path.open("rb+") as handle:
        handle.seek(-1, 2)
        if handle.read(1) not in (b"\n", b"\r"):
            handle.seek(0, 2)
            handle.write(b"\n")


def count_pending_cards(path: Path, completed_ids: set[str]) -> tuple[int, int]:
    pending_ids: set[str] = set()
    existing = 0
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(raw, dict):
                continue
            card_id = as_string(raw.get("id"))
            if not card_id:
                continue
            if card_id in completed_ids:
                existing += 1
            else:
                pending_ids.add(card_id)
    return len(pending_ids), existing


def iter_pending_cards(path: Path, completed_ids: set[str]) -> Iterator[dict[str, Any]]:
    seen: set[str] = set()
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"[WARN] Input line {line_number} is invalid JSON: {exc}")
                continue
            if not isinstance(raw, dict):
                print(f"[WARN] Input line {line_number} is not a JSON object; skipping.")
                continue
            card_id = as_string(raw.get("id"))
            if not card_id:
                print(f"[WARN] Input line {line_number} has no id; skipping.")
                continue
            if card_id in completed_ids or card_id in seen:
                continue
            seen.add(card_id)
            yield raw


def take_batch(iterator: Iterator[dict[str, Any]], size: int) -> list[dict[str, Any]]:
    return list(itertools.islice(iterator, size))


def format_duration(seconds: float) -> str:
    seconds = max(0, round(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {seconds:02d}s"
    if minutes:
        return f"{minutes}m {seconds:02d}s"
    return f"{seconds}s"


def main() -> None:
    args = parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)
    if not input_path.exists():
        raise SystemExit(f"Input file not found: {input_path}. Run 02_build_solved_bug_cards.py first.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    completed_ids = load_completed_ids(output_path)
    ensure_append_boundary(output_path)
    total_pending, skipped = count_pending_cards(input_path, completed_ids)
    planned_total = total_pending
    if args.limit is not None:
        planned_total = min(planned_total, args.limit)

    print(f"Found {len(completed_ids)} completed IDs and {total_pending} remaining cards.")
    if planned_total == 0:
        print(f"Nothing to do. Output: {output_path.resolve()}")
        return

    api_key = args.api_key or os.getenv("LLM_API_KEY") or os.getenv("DASHSCOPE_API_KEY")
    base_url = args.base_url or os.getenv("LLM_BASE_URL")
    model = args.model or os.getenv("LLM_MODEL") or DEFAULT_MODEL
    if not api_key:
        raise SystemExit("Missing API key. Set LLM_API_KEY (or DASHSCOPE_API_KEY), or pass --api-key.")

    client_args: dict[str, Any] = {"api_key": api_key}
    if base_url:
        client_args["base_url"] = base_url
    client = OpenAI(**client_args)

    attempted = 0
    written = 0
    request_seconds = 0.0
    interrupted = False
    cards = iter_pending_cards(input_path, completed_ids)
    batch_count = (planned_total + args.batch_size - 1) // args.batch_size

    try:
        with output_path.open("a", encoding="utf-8") as destination:
            for batch_number in range(1, batch_count + 1):
                batch_size = min(args.batch_size, planned_total - attempted)
                batch = take_batch(cards, batch_size)
                if not batch:
                    break
                print(
                    f"\n[BATCH] {batch_number}/{batch_count} - "
                    f"cards {attempted + 1}-{attempted + len(batch)} of {planned_total}"
                )

                for raw in batch:
                    card_id = as_string(raw.get("id"))
                    request_started = time.perf_counter()
                    attempted += 1
                    try:
                        generated = request_compact_card(client, model, raw)
                        compact = normalize_card(generated, raw)
                        destination.write(json.dumps(compact, ensure_ascii=False) + "\n")
                        destination.flush()
                        completed_ids.add(card_id)
                        written += 1
                        status = f"[OK] {attempted}/{planned_total}: {card_id} - {compact['title'] or '(untitled)'}"
                    except (ValueError, IndexError, KeyError, TypeError) as exc:
                        status = f"[ERROR] {attempted}/{planned_total}: {card_id}: {exc}"
                    except Exception as exc:
                        status = f"[ERROR] {attempted}/{planned_total}: {card_id}: API request failed: {exc}"

                    request_seconds += time.perf_counter() - request_started
                    remaining = planned_total - attempted
                    average_seconds = request_seconds / attempted + args.sleep
                    eta = format_duration(average_seconds * remaining)
                    print(f"{status} | remaining={remaining} | ETA={eta}")

                    if args.sleep and remaining:
                        time.sleep(args.sleep)

                destination.flush()
                os.fsync(destination.fileno())
                print(f"[CHECKPOINT] Batch {batch_number} saved. Safe to stop and resume.")
    except KeyboardInterrupt:
        interrupted = True
        print("\n[STOPPED] Progress already written. Run the same command to resume.")

    print(
        f"Done. Attempted {attempted}, wrote {written}, skipped {skipped} existing cards. "
        f"Output: {output_path.resolve()}"
    )
    if interrupted:
        raise SystemExit(130)


if __name__ == "__main__":
    main()
