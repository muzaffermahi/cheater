from __future__ import annotations

import json
import queue
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .cheater_core import write_text
from .cheater_config import resolve_real_pi_command


@dataclass
class PiRpcResult:
    success: bool
    exit_code: int
    status: str
    last_assistant_text: str
    event_count: int
    error: str = ""


class PiRpcClient:
    def __init__(self, repo: Path, run_dir: Path, *, name: str) -> None:
        self.repo = repo.resolve()
        self.run_dir = run_dir.resolve()
        self.name = name
        self.process: subprocess.Popen[str] | None = None
        self.events: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self.stderr_chunks: list[str] = []
        self.event_count = 0
        self.raw_log = self.run_dir / "pi_rpc_events.jsonl"
        self.agent_log = self.run_dir / "pi_stdout.log"

    def start(self) -> None:
        pi_command = resolve_real_pi_command(Path(__file__).resolve().parent)
        if not pi_command:
            raise RuntimeError(
                "Pi not detected. Run python 12_test_pi_detection.py or set "
                "CHEATER_REAL_PI_COMMAND."
            )
        command = [
            *pi_command,
            "--mode",
            "rpc",
            "--session-dir",
            str(self.run_dir / "pi_sessions"),
            "--name",
            self.name,
        ]
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.process = subprocess.Popen(
            command,
            cwd=str(self.repo),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        with self.raw_log.open("a", encoding="utf-8") as raw:
            for line in self.process.stdout:
                raw.write(line)
                raw.flush()
                try:
                    event = json.loads(line.rstrip("\n").rstrip("\r"))
                except json.JSONDecodeError:
                    event = {"type": "protocol_error", "raw": line.rstrip()}
                self.events.put(event)
        self.events.put(None)

    def _read_stderr(self) -> None:
        assert self.process is not None and self.process.stderr is not None
        for line in self.process.stderr:
            self.stderr_chunks.append(line)

    def send(self, command: dict[str, Any]) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("Pi RPC process is not running.")
        self.process.stdin.write(json.dumps(command, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def prompt_and_wait(self, prompt: str, timeout: float = 7200.0) -> PiRpcResult:
        self.send({"id": "cheater-prompt-1", "type": "prompt", "message": prompt})
        started = time.monotonic()
        text_chunks: list[str] = []
        readable_chunks: list[str] = []
        agent_ended = False
        error = ""

        while time.monotonic() - started < timeout:
            try:
                event = self.events.get(timeout=0.5)
            except queue.Empty:
                if self.process is not None and self.process.poll() is not None:
                    error = f"Pi RPC exited early with code {self.process.returncode}."
                    break
                continue
            if event is None:
                error = "Pi RPC output closed before agent_end."
                break
            self.event_count += 1
            event_type = str(event.get("type") or "")
            if event_type == "message_update":
                update = event.get("assistantMessageEvent") or {}
                if update.get("type") == "text_delta":
                    delta = str(update.get("delta") or "")
                    print(delta, end="", flush=True)
                    text_chunks.append(delta)
                    readable_chunks.append(delta)
            elif event_type == "tool_execution_start":
                tool = event.get("toolName") or event.get("name") or "tool"
                line = f"\n[Pi tool] {tool}\n"
                print(line, end="", flush=True)
                readable_chunks.append(line)
            elif event_type == "tool_execution_end":
                line = "[Pi tool complete]\n"
                print(line, end="", flush=True)
                readable_chunks.append(line)
            elif event_type == "extension_error":
                line = f"\n[Pi extension error] {event}\n"
                print(line, end="", flush=True)
                readable_chunks.append(line)
            elif event_type == "response" and event.get("success") is False:
                error = str(event.get("error") or event)
                break
            elif event_type == "agent_end":
                agent_ended = True
                print()
                break

        if not agent_ended and not error:
            error = f"Pi RPC timed out after {timeout:.0f} seconds."
        if self.stderr_chunks:
            readable_chunks.append("\n[Pi stderr]\n" + "".join(self.stderr_chunks))
        write_text(self.agent_log, "".join(readable_chunks))
        exit_code = 0 if agent_ended else 1
        return PiRpcResult(
            success=agent_ended,
            exit_code=exit_code,
            status="completed" if agent_ended else "rpc_failed",
            last_assistant_text="".join(text_chunks),
            event_count=self.event_count,
            error=error,
        )

    def close(self) -> None:
        if self.process is None:
            return
        if self.process.stdin:
            try:
                self.process.stdin.close()
            except OSError:
                pass
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)

    def __enter__(self) -> "PiRpcClient":
        self.start()
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.close()


def run_pi_rpc(
    repo: Path,
    prompt: str,
    run_dir: Path,
    *,
    name: str,
    timeout: float = 7200.0,
) -> PiRpcResult:
    try:
        with PiRpcClient(repo, run_dir, name=name) as client:
            return client.prompt_and_wait(prompt, timeout=timeout)
    except (OSError, RuntimeError) as exc:
        message = str(exc)
        write_text(run_dir / "agent_stdout.log", message + "\n")
        return PiRpcResult(False, 127, "rpc_start_failed", "", 0, message)
