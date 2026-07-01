from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse


LOCAL_QWEN_SETUP = (
    "No loaded local Qwen 3.5 9B endpoint was found. Start LM Studio's local server "
    "(`lms server start`), then load a Qwen 3.5 9B model with a stable identifier, "
    "for example `lms load <local-model-key> --identifier qwen3.5-9b-cheater "
    "--context-length 32768 -y`. Cheater only accepts loopback URLs."
)


@dataclass(frozen=True)
class LocalQwenConfig:
    base_url: str = "http://127.0.0.1:1234/v1"
    model: str = ""
    max_turns: int = 30
    request_timeout: float = 3600.0
    temperature: float = 0.0
    max_tokens: int = 4096
    seed: int = 0
    action_rescue: bool = False
    failure_critic: bool = False
    evidence_turn_budget: int = 0
    repair_focus: bool = False


@dataclass
class LocalQwenResult:
    success: bool
    exit_code: int
    status: str
    last_assistant_text: str
    event_count: int
    model: str | None = None
    error: str = ""


class LocalQwenError(RuntimeError):
    pass


def _failure_signature(output: str) -> str:
    normalized = re.sub(r"\s+", " ", output).strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest() if normalized else ""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def validate_loopback_url(base_url: str) -> str:
    parsed = urlparse(base_url)
    host = (parsed.hostname or "").casefold()
    if parsed.scheme not in {"http", "https"} or host not in {
        "127.0.0.1",
        "localhost",
        "::1",
    }:
        raise LocalQwenError(
            "Qwen base URL must be an explicit loopback HTTP(S) endpoint; "
            f"refusing: {base_url}"
        )
    return base_url.rstrip("/")


def _request_json(
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    timeout: float,
) -> dict[str, Any]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload else None
    request = urllib.request.Request(
        url,
        data=data,
        method="POST" if payload is not None else "GET",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer lm-studio",
        },
    )
    try:
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            _NoRedirect(),
        )
        with opener.open(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise LocalQwenError(f"Local Qwen HTTP {exc.code}: {body[:2000]}") from exc
    except (OSError, urllib.error.URLError) as exc:
        raise LocalQwenError(f"Could not reach local Qwen endpoint: {exc}") from exc
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise LocalQwenError(f"Local Qwen returned invalid JSON: {raw[:1000]}") from exc
    if not isinstance(value, dict):
        raise LocalQwenError("Local Qwen response was not a JSON object.")
    return value


def discover_local_qwen(config: LocalQwenConfig) -> tuple[str | None, list[str], str]:
    try:
        base_url = validate_loopback_url(config.base_url)
        response = _request_json(f"{base_url}/models", timeout=min(config.request_timeout, 5.0))
    except LocalQwenError as exc:
        return None, [], f"{exc} {LOCAL_QWEN_SETUP}"
    rows = response.get("data")
    model_ids = [
        str(item.get("id"))
        for item in rows
        if isinstance(rows, list) and isinstance(item, dict) and item.get("id")
    ] if isinstance(rows, list) else []
    requested = config.model.strip()
    if requested:
        for model_id in model_ids:
            if model_id.casefold() == requested.casefold():
                return model_id, model_ids, ""
        return (
            None,
            model_ids,
            f"Requested local model '{requested}' is not loaded. Loaded: "
            f"{', '.join(model_ids) or '(none)'}. {LOCAL_QWEN_SETUP}",
        )
    candidates = [
        model_id
        for model_id in model_ids
        if (
            "qwen3.5" in model_id.casefold()
            or "qwen-3.5" in model_id.casefold()
            or "qwopus3.5" in model_id.casefold()
        )
        and "9b" in model_id.casefold()
    ]
    if candidates:
        candidates.sort(
            key=lambda model_id: (
                "coder" not in model_id.casefold(),
                "qwopus" not in model_id.casefold(),
                model_id.casefold(),
            )
        )
        return candidates[0], model_ids, ""
    return (
        None,
        model_ids,
        "No loaded model ID clearly identifies Qwen 3.5 9B. Loaded: "
        f"{', '.join(model_ids) or '(none)'}. {LOCAL_QWEN_SETUP}",
    )


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class RepoTools:
    _ignored_dirs = {
        ".git",
        ".cheater",
        ".hg",
        ".svn",
        ".venv",
        "venv",
        "node_modules",
        "__pycache__",
        ".mypy_cache",
        ".pytest_cache",
    }

    def __init__(
        self,
        repo: Path,
        run_dir: Path,
        *,
        test_runner: Callable[[Path], tuple[int, str]] | None = None,
        diff_reader: Callable[[], str] | None = None,
    ) -> None:
        self.repo = repo.resolve()
        self.run_dir = run_dir.resolve()
        self.test_runner = test_runner
        self.diff_reader = diff_reader
        self.test_count = 0

    def _path(self, relative: str, *, allow_missing: bool = False) -> Path:
        path = Path(relative)
        if path.is_absolute():
            raise LocalQwenError("Tool paths must be relative to the repository.")
        candidate = (self.repo / path).resolve(strict=not allow_missing)
        try:
            inside = candidate.relative_to(self.repo)
        except ValueError as exc:
            raise LocalQwenError("Path escapes the repository.") from exc
        if any(part.casefold() in self._ignored_dirs for part in inside.parts):
            raise LocalQwenError("Access to repository metadata/cache directories is blocked.")
        return candidate

    def list_files(self, path: str = ".", glob: str = "*", limit: int = 1000) -> dict[str, Any]:
        root = self._path(path)
        if not root.is_dir():
            raise LocalQwenError(f"Not a directory: {path}")
        files: list[str] = []
        for current, dirs, names in os.walk(root):
            dirs[:] = [name for name in dirs if name.casefold() not in self._ignored_dirs]
            current_path = Path(current)
            for name in names:
                # A linked Git worktree exposes `.git` as a file. Exclude metadata
                # names from files as well as directories so root searches skip them.
                if name.casefold() in self._ignored_dirs:
                    continue
                relative = (current_path / name).relative_to(self.repo).as_posix()
                root_pattern = glob[3:] if glob.startswith("**/") else glob
                if (
                    fnmatch.fnmatch(relative, glob)
                    or fnmatch.fnmatch(relative, root_pattern)
                    or fnmatch.fnmatch(name, glob)
                ):
                    files.append(relative)
                    if len(files) >= max(1, min(limit, 5000)):
                        return {"files": files, "truncated": True}
        return {"files": files, "truncated": False}

    def read_file(self, path: str, start_line: int = 1, end_line: int = 400) -> dict[str, Any]:
        target = self._path(path)
        data = target.read_bytes()
        if b"\0" in data[:4096]:
            raise LocalQwenError(f"Binary file cannot be read as text: {path}")
        text = data.decode("utf-8", errors="replace")
        lines = text.splitlines()
        start = max(1, start_line)
        end = max(start, min(end_line, start + 999))
        selected = lines[start - 1 : min(end, len(lines))]
        return {
            "path": target.relative_to(self.repo).as_posix(),
            "sha256": _sha256(data),
            "line_count": len(lines),
            "start_line": start,
            "end_line": min(end, len(lines)),
            "content": "\n".join(selected),
        }

    def search_text(
        self,
        pattern: str,
        path: str = ".",
        glob: str = "*",
        limit: int = 200,
    ) -> dict[str, Any]:
        try:
            regex = re.compile(pattern)
        except re.error as exc:
            raise LocalQwenError(f"Invalid regular expression: {exc}") from exc
        listed = self.list_files(path, glob, limit=5000)["files"]
        matches: list[str] = []
        for relative in listed:
            target = self._path(relative)
            try:
                if target.stat().st_size > 2_000_000:
                    continue
                data = target.read_bytes()
                if b"\0" in data[:4096]:
                    continue
                text = data.decode("utf-8", errors="replace")
            except OSError:
                continue
            for number, line in enumerate(text.splitlines(), start=1):
                if regex.search(line):
                    matches.append(f"{relative}:{number}:{line[:500]}")
                    if len(matches) >= max(1, min(limit, 1000)):
                        return {"matches": matches, "truncated": True}
        return {"matches": matches, "truncated": False}

    def write_file(self, path: str, content: str, expected_sha256: str) -> dict[str, Any]:
        target = self._path(path, allow_missing=True)
        if len(content.encode("utf-8")) > 2_000_000:
            raise LocalQwenError("Refusing to write a file larger than 2 MB.")
        if target.exists():
            current = target.read_bytes()
            if expected_sha256 != _sha256(current):
                raise LocalQwenError(
                    "File changed or was not read first; expected_sha256 does not match."
                )
        elif expected_sha256 != "NEW":
            raise LocalQwenError("Use expected_sha256='NEW' when creating a file.")
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("w", encoding="utf-8", newline="") as handle:
            handle.write(content)
        return {
            "path": target.relative_to(self.repo).as_posix(),
            "sha256": _sha256(target.read_bytes()),
            "bytes": target.stat().st_size,
        }

    def replace_text(
        self,
        path: str,
        old_text: str,
        new_text: str,
        expected_sha256: str,
    ) -> dict[str, Any]:
        """Replace one exact text block in an existing UTF-8 file.

        The content hash and single-match requirement make this a small, auditable edit
        primitive rather than an unrestricted patch or shell tool.
        """
        target = self._path(path)
        current_bytes = target.read_bytes()
        if expected_sha256 != _sha256(current_bytes):
            raise LocalQwenError(
                "File changed or was not read first; expected_sha256 does not match."
            )
        if b"\0" in current_bytes[:4096]:
            raise LocalQwenError(f"Binary file cannot be edited as text: {path}")
        current = current_bytes.decode("utf-8")
        newline = "\r\n" if "\r\n" in current else "\n"
        normalized = current.replace("\r\n", "\n")
        normalized_old = old_text.replace("\r\n", "\n")
        normalized_new = new_text.replace("\r\n", "\n")
        matches = normalized.count(normalized_old)
        if matches != 1:
            raise LocalQwenError(
                f"old_text must match exactly once; found {matches} occurrences."
            )
        updated = normalized.replace(normalized_old, normalized_new, 1)
        if newline == "\r\n":
            updated = updated.replace("\n", "\r\n")
        if len(updated.encode("utf-8")) > 2_000_000:
            raise LocalQwenError("Refusing to write a file larger than 2 MB.")
        with target.open("w", encoding="utf-8", newline="") as handle:
            handle.write(updated)
        return {
            "path": target.relative_to(self.repo).as_posix(),
            "sha256": _sha256(target.read_bytes()),
            "replacements": 1,
        }

    def run_tests(self) -> dict[str, Any]:
        if not self.test_runner:
            raise LocalQwenError("No test command is configured for this task.")
        self.test_count += 1
        log_path = self.run_dir / f"qwen_test_{self.test_count}.log"
        exit_code, output = self.test_runner(log_path)
        return {
            "exit_code": exit_code,
            "output_tail": output[-12000:],
            "log_file": str(log_path),
        }

    def git_diff(self) -> dict[str, Any]:
        diff = self.diff_reader() if self.diff_reader else ""
        return {"diff": diff[-30000:], "truncated": len(diff) > 30000}

    def execute(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        methods = {
            "list_files": self.list_files,
            "read_file": self.read_file,
            "search_text": self.search_text,
            "write_file": self.write_file,
            "replace_text": self.replace_text,
            "run_tests": self.run_tests,
            "git_diff": self.git_diff,
        }
        method = methods.get(name)
        if not method:
            return {"ok": False, "error": f"Unknown tool: {name}"}
        try:
            return {"ok": True, "result": method(**arguments)}
        except (LocalQwenError, OSError, TypeError, UnicodeError) as exc:
            return {"ok": False, "error": str(exc)}


TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "List repository files recursively.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "default": "."},
                    "glob": {"type": "string", "default": "*"},
                    "limit": {"type": "integer", "default": 1000},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read raw source lines and obtain the SHA-256 required for safe edits.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "start_line": {"type": "integer", "default": 1},
                    "end_line": {"type": "integer", "default": 400},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_text",
            "description": "Regex search across repository text files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"},
                    "path": {"type": "string", "default": "."},
                    "glob": {"type": "string", "default": "*"},
                    "limit": {"type": "integer", "default": 200},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Replace/create one UTF-8 file. Existing files require the SHA from read_file; new files use NEW.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                    "expected_sha256": {"type": "string"},
                },
                "required": ["path", "content", "expected_sha256"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "replace_text",
            "description": "Safely replace one exact source block. Prefer this for small edits; requires the current SHA from read_file and refuses zero or multiple matches.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_text": {"type": "string"},
                    "new_text": {"type": "string"},
                    "expected_sha256": {"type": "string"},
                },
                "required": ["path", "old_text", "new_text", "expected_sha256"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_tests",
            "description": "Run only the evaluator-configured test command and return its output.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "git_diff",
            "description": "Inspect the current patch relative to the captured base commit.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


def run_local_qwen_agent(
    repo: Path,
    prompt: str,
    run_dir: Path,
    *,
    config: LocalQwenConfig,
    test_runner: Callable[[Path], tuple[int, str]] | None = None,
    diff_reader: Callable[[], str] | None = None,
    initial_failure_output: str = "",
) -> LocalQwenResult:
    model, loaded_models, error = discover_local_qwen(config)
    if not model:
        return LocalQwenResult(False, 127, "qwen_unavailable", "", 0, None, error)
    base_url = validate_loopback_url(config.base_url)
    run_dir.mkdir(parents=True, exist_ok=True)
    tools = RepoTools(
        repo,
        run_dir,
        test_runner=test_runner,
        diff_reader=diff_reader,
    )
    system_prompt = (
        "You are a focused repair continuation. A previous coding attempt already "
        "changed the repository and failed its configured test. The user prompt contains "
        "the latest failure and current patch. Do not restart repository discovery or list "
        "the whole tree. Inspect the current diff or the smallest affected source region, "
        "correct the existing patch, then call run_tests. Preserve useful prior edits. "
        "Never claim success unless run_tests returned exit_code 0."
        if config.repair_focus
        else (
            "You are a local coding agent operating through constrained repository tools. "
            "Inspect before editing. Make the smallest correct change. Never claim tests "
            "passed unless run_tests returned exit_code 0. Do not access the network, delete "
            "files, or touch repository metadata. read_file returns raw source without line "
            "number prefixes. After search_text identifies a path, read that exact file once. "
            "Prefer replace_text for a small source edit; use write_file only when replacing "
            "the entire file is genuinely necessary. Never reread content already returned "
            "in full. Keep private reasoning brief enough to leave room for the required "
            "tool call. Finish with a concise factual summary."
        )
    )
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": system_prompt,
        },
        {"role": "user", "content": prompt},
    ]
    task_reminder = prompt[:6000].strip()
    event_log = run_dir / "qwen_events.jsonl"
    assistant_chunks: list[str] = []
    event_count = 0
    last_tool_signature = ""
    repeated_tool_batches = 0
    last_single_read_path = ""
    last_read_path_any = ""
    repeated_single_read_turns = 0
    consecutive_evidence_turns = 0
    empty_completion_turns = 0
    require_tool_next_turn = config.repair_focus
    action_rescue_used = False
    action_rescue_active = False
    failure_critic_used = False
    failure_critic_active = False
    failure_critic_needs_evidence = False
    initial_failure_signature = _failure_signature(initial_failure_output)
    latest_checkpoint = ""

    def activate_action_rescue(turn: int, trigger_reason: str) -> None:
        nonlocal action_rescue_used, action_rescue_active
        nonlocal empty_completion_turns, require_tool_next_turn, messages, event_count
        action_rescue_used = True
        action_rescue_active = True
        empty_completion_turns = 0
        require_tool_next_turn = True
        messages = [
            {
                "role": "system",
                "content": (
                    "You are the bounded action phase of a local coding agent. "
                    "Do not restart broad analysis or restate the task. Convert the "
                    "provided analysis checkpoint into the smallest justified "
                    "repository action. Use only the constrained tools. Writes remain "
                    "hash-guarded. After editing, call run_tests. Never claim success "
                    "without exit_code 0."
                ),
            },
            {
                "role": "user",
                "content": (
                    "# Original task\n\n"
                    + task_reminder
                    + "\n\n# Rescue trigger\n\n"
                    + trigger_reason
                    + "\n\n# Analysis checkpoint\n\n"
                    + (latest_checkpoint or "No usable checkpoint was produced.")
                    + "\n\n# Last source path read\n\n"
                    + (last_read_path_any or "Unknown")
                    + "\n\nCall exactly one tool now. If the checkpoint supports "
                    "a source edit, use replace_text. Otherwise obtain exactly one "
                    "missing piece of evidence."
                ),
            },
        ]
        with event_log.open("a", encoding="utf-8") as log:
            log.write(
                json.dumps(
                    {
                        "turn": turn,
                        "type": "action_rescue",
                        "trigger_reason": trigger_reason,
                        "checkpoint_chars": len(latest_checkpoint),
                        "last_read_path": last_read_path_any or None,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
        event_count += 1

    for turn in range(1, config.max_turns + 1):
        if failure_critic_needs_evidence:
            available_tools = [
                tool
                for tool in TOOLS
                if tool.get("function", {}).get("name")
                in {"read_file", "search_text", "git_diff"}
            ]
        elif action_rescue_active:
            available_tools = [
                tool
                for tool in TOOLS
                if tool.get("function", {}).get("name")
                in {"replace_text", "write_file", "run_tests", "git_diff"}
            ]
        else:
            available_tools = (
                [
                    tool
                    for tool in TOOLS
                    if tool.get("function", {}).get("name") != "list_files"
                ]
                if config.repair_focus
                else TOOLS
            )
        requested_tool_choice = "required" if require_tool_next_turn else "auto"
        payload = {
            "model": model,
            "messages": messages,
            "tools": available_tools,
            "tool_choice": requested_tool_choice,
            "temperature": config.temperature,
            "max_tokens": config.max_tokens,
            "seed": config.seed,
            "parallel_tool_calls": False,
        }
        try:
            response = _request_json(
                f"{base_url}/chat/completions",
                payload=payload,
                timeout=config.request_timeout,
            )
            choices = response.get("choices")
            choice = choices[0] if isinstance(choices, list) and choices else None
            message = choice.get("message") if isinstance(choice, dict) else None
            if not isinstance(message, dict):
                raise LocalQwenError(f"Missing assistant message: {str(response)[:1000]}")
        except (LocalQwenError, KeyError, IndexError, TypeError) as exc:
            return LocalQwenResult(
                False,
                1,
                "qwen_agent_error",
                "\n".join(assistant_chunks),
                event_count,
                model,
                str(exc),
            )

        content = str(message.get("content") or "")
        reasoning_content = str(message.get("reasoning_content") or "")
        if reasoning_content:
            latest_checkpoint = reasoning_content[-5000:]
        finish_reason = str(choice.get("finish_reason") or "") if isinstance(choice, dict) else ""
        if content:
            assistant_chunks.append(content)
        tool_calls = message.get("tool_calls")
        normalized_message: dict[str, Any] = {"role": "assistant", "content": content or None}
        if isinstance(tool_calls, list) and tool_calls:
            normalized_message["tool_calls"] = tool_calls
        messages.append(normalized_message)
        with event_log.open("a", encoding="utf-8") as log:
            log.write(
                json.dumps(
                    {
                        "turn": turn,
                        "type": "assistant",
                        "message": normalized_message,
                        "reasoning_content": reasoning_content or None,
                        "finish_reason": finish_reason or None,
                        "requested_tool_choice": requested_tool_choice,
                        "available_tools": [
                            tool.get("function", {}).get("name") for tool in available_tools
                        ],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
        event_count += 1

        if not isinstance(tool_calls, list) or not tool_calls:
            if finish_reason == "length" or not content.strip():
                empty_completion_turns += 1
                checkpoint_parts = []
                if reasoning_content:
                    checkpoint_parts.append(reasoning_content[-4000:])
                if content:
                    checkpoint_parts.append(content[-1000:])
                if checkpoint_parts:
                    latest_checkpoint = "\n".join(checkpoint_parts)[-5000:]
                    # Preserve the full response in the event log, but carry only a bounded
                    # analysis checkpoint forward so the model does not restart from scratch.
                    messages[-1] = {
                        "role": "assistant",
                        "content": "Analysis checkpoint from the incomplete turn:\n"
                        + latest_checkpoint,
                    }
                if empty_completion_turns >= 3:
                    if config.action_rescue and not action_rescue_used:
                        activate_action_rescue(
                            turn,
                            "Three consecutive assistant turns exhausted their response "
                            "without completing a tool action.",
                        )
                        continue
                    return LocalQwenResult(
                        False,
                        1,
                        "qwen_stalled",
                        "\n".join(assistant_chunks),
                        event_count,
                        model,
                        "Local Qwen returned three incomplete turns without a tool call.",
                    )
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "The original coding task below is still active; this is a recovery "
                            "continuation, not a new or incomplete user request.\n\n"
                            + task_reminder
                            + "\n\nContinue from the bounded analysis checkpoint immediately "
                            "above. Your last turn exhausted its response without completing an "
                            "action. Stop restarting the analysis and call exactly one repository tool "
                            "now. If you already identified a small source fix, call "
                            "replace_text; otherwise call the single tool that obtains the "
                            "missing evidence."
                        ),
                    }
                )
                require_tool_next_turn = bool(reasoning_content or finish_reason == "length")
                continue
            (run_dir / "qwen_model.txt").write_text(model + "\n", encoding="utf-8")
            (run_dir / "agent_stdout.log").write_text(
                "\n".join(assistant_chunks), encoding="utf-8"
            )
            return LocalQwenResult(
                True,
                0,
                "completed",
                "\n".join(assistant_chunks),
                event_count,
                model,
            )
        empty_completion_turns = 0
        require_tool_next_turn = False

        signature_parts: list[tuple[str, str]] = []
        turn_read_paths: set[str] = set()
        turn_mutated = False
        turn_ran_tests = False
        turn_tests_passed = False
        turn_tool_names: set[str] = set()
        pending_failure_critic: dict[str, Any] | None = None
        for call in tool_calls:
            if not isinstance(call, dict):
                continue
            function = call.get("function") if isinstance(call.get("function"), dict) else {}
            signature_parts.append(
                (str(function.get("name") or ""), str(function.get("arguments") or "{}"))
            )
        tool_signature = json.dumps(signature_parts, sort_keys=True)
        if tool_signature == last_tool_signature:
            repeated_tool_batches += 1
        else:
            repeated_tool_batches = 0
            last_tool_signature = tool_signature

        for call in tool_calls:
            if not isinstance(call, dict):
                continue
            call_id = str(call.get("id") or f"tool-{turn}-{event_count}")
            function = call.get("function") if isinstance(call.get("function"), dict) else {}
            name = str(function.get("name") or "")
            turn_tool_names.add(name)
            raw_arguments = function.get("arguments") or "{}"
            try:
                arguments = json.loads(raw_arguments) if isinstance(raw_arguments, str) else raw_arguments
                if not isinstance(arguments, dict):
                    raise ValueError("tool arguments must be an object")
                if name == "read_file" and isinstance(arguments.get("path"), str):
                    last_read_path_any = str(arguments["path"])
                    turn_read_paths.add(last_read_path_any)
                if name in {"replace_text", "write_file"}:
                    turn_mutated = True
                tool_result = tools.execute(name, arguments)
                if name == "run_tests":
                    turn_ran_tests = True
                    test_result = (
                        tool_result.get("result")
                        if isinstance(tool_result.get("result"), dict)
                        else {}
                    )
                    turn_tests_passed = bool(
                        tool_result.get("ok") and test_result.get("exit_code") == 0
                    )
                    if (
                        tool_result.get("ok")
                        and test_result.get("exit_code") != 0
                        and config.failure_critic
                        and not failure_critic_used
                    ):
                        failure_output = str(test_result.get("output_tail") or "")
                        failure_signature = _failure_signature(failure_output)
                        pending_failure_critic = {
                            "failure_output": failure_output,
                            "failure_signature": failure_signature,
                            "failure_unchanged": (
                                failure_signature == initial_failure_signature
                                if initial_failure_signature
                                else None
                            ),
                            "current_diff": diff_reader() if diff_reader else "",
                        }
            except (json.JSONDecodeError, ValueError) as exc:
                tool_result = {"ok": False, "error": f"Invalid tool arguments: {exc}"}
            tool_message = {
                "role": "tool",
                "tool_call_id": call_id,
                "content": json.dumps(tool_result, ensure_ascii=False),
            }
            messages.append(tool_message)
            with event_log.open("a", encoding="utf-8") as log:
                log.write(
                    json.dumps(
                        {
                            "turn": turn,
                            "type": "tool",
                            "tool": name,
                            "result": tool_result,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
            event_count += 1

        if pending_failure_critic:
            failure_critic_used = True
            failure_critic_active = True
            failure_critic_needs_evidence = True
            require_tool_next_turn = True
            empty_completion_turns = 0
            messages = [
                {
                    "role": "system",
                    "content": (
                        "You are the one-shot failure-localization critic for a local coding "
                        "agent. The last edit did not pass the configured test. Challenge the "
                        "current localization before allowing another edit. On this first turn, "
                        "editing and test tools are intentionally unavailable: call exactly one "
                        "evidence tool. Do not claim success."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        "# Original task\n\n"
                        + task_reminder
                        + "\n\n# Failure comparison\n\n"
                        + (
                            "The failure signature is unchanged from preflight. The current "
                            "edit likely did not affect the failing path."
                            if pending_failure_critic["failure_unchanged"] is True
                            else "The failure signature changed or no preflight signature was "
                            "available; inspect the new evidence before another edit."
                        )
                        + "\n\n# Latest failure\n\n"
                        + str(pending_failure_critic["failure_output"])[-5000:]
                        + "\n\n# Current diff\n\n```diff\n"
                        + str(pending_failure_critic["current_diff"])[-5000:]
                        + "\n```\n\n# Prior analysis checkpoint\n\n"
                        + latest_checkpoint[-3000:]
                        + "\n\nCall one evidence tool now. Prefer git_diff to inspect the "
                        "failed patch, or read/search a caller or assembly function if the diff "
                        "already shows the current hypothesis."
                    ),
                },
            ]
            with event_log.open("a", encoding="utf-8") as log:
                log.write(
                    json.dumps(
                        {
                            "turn": turn,
                            "type": "failure_critic",
                            "failure_signature": pending_failure_critic["failure_signature"],
                            "preflight_failure_signature": initial_failure_signature or None,
                            "failure_unchanged": pending_failure_critic["failure_unchanged"],
                            "diff_chars": len(str(pending_failure_critic["current_diff"])),
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
            event_count += 1
            continue

        evidence_tools = {"list_files", "read_file", "search_text", "git_diff"}
        if turn_tool_names and turn_tool_names <= evidence_tools:
            consecutive_evidence_turns += 1
        else:
            consecutive_evidence_turns = 0
        if (
            config.action_rescue
            and config.evidence_turn_budget > 0
            and consecutive_evidence_turns >= config.evidence_turn_budget
            and not action_rescue_used
        ):
            activate_action_rescue(
                turn,
                f"The agent spent {consecutive_evidence_turns} consecutive turns on "
                "read/search/diff tools without editing or testing.",
            )
            continue

        if failure_critic_needs_evidence and turn_tool_names:
            failure_critic_needs_evidence = False
            require_tool_next_turn = True
        elif action_rescue_active or failure_critic_active:
            require_tool_next_turn = not (turn_ran_tests and turn_tests_passed)

        if not turn_mutated and len(turn_read_paths) == 1:
            single_read_path = next(iter(turn_read_paths))
            if single_read_path == last_single_read_path:
                repeated_single_read_turns += 1
            else:
                last_single_read_path = single_read_path
                repeated_single_read_turns = 1
        else:
            last_single_read_path = ""
            repeated_single_read_turns = 0

        if repeated_single_read_turns >= 2:
            messages.append(
                {
                    "role": "user",
                    "content": (
                        f"You have repeatedly read {last_single_read_path} without editing. "
                        "The relevant source is already in context. Diagnose the stated failure, "
                        "use replace_text for the smallest justified change, run tests, or finish "
                        "truthfully. Do not read that file again."
                    ),
                }
            )
        if repeated_single_read_turns >= 5:
            return LocalQwenResult(
                False,
                1,
                "qwen_stalled",
                "\n".join(assistant_chunks),
                event_count,
                model,
                f"Local Qwen repeatedly reread {last_single_read_path} without editing.",
            )

        if repeated_tool_batches:
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "You repeated the same tool call without progress. Do not call it again. "
                        "Use the returned path with read_file, make a justified edit, run tests, "
                        "or finish truthfully."
                    ),
                }
            )
        if repeated_tool_batches >= 2:
            return LocalQwenResult(
                False,
                1,
                "qwen_stalled",
                "\n".join(assistant_chunks),
                event_count,
                model,
                "Local Qwen repeated an identical tool batch three times.",
            )

    return LocalQwenResult(
        False,
        1,
        "qwen_max_turns",
        "\n".join(assistant_chunks),
        event_count,
        model,
        f"Local Qwen exceeded {config.max_turns} tool turns.",
    )
