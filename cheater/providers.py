"""Model provider abstraction for Cheater.

Goal: Cheater can run without an LLM (deterministic mode), but if a provider
is configured, it can do natural-language patch drafting and chat.

Supported providers:
  - none:        deterministic only, no LLM calls
  - openai:      OpenAI-compatible (works with OpenAI, LM Studio, Ollama /v1, etc.)

Env variables (overridden by config):
  CHEATER_MODEL
  CHEATER_BASE_URL
  CHEATER_API_KEY
  CHEATER_PROVIDER

Public API:
  get_provider(config=None) -> BaseProvider
  NoModelProvider            -- deterministic (raises ModelNotConfigured)
  OpenAIProvider             -- OpenAI-compatible
  redact_api_key(s)          -- for safe logging

Safe redaction: API keys are NEVER logged in plaintext.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Iterator


class ProviderError(Exception):
    """Base error for provider failures."""


class ModelNotConfigured(ProviderError):
    """No model is configured. The caller should fall back to deterministic mode."""


class ProviderTimeout(ProviderError):
    """Request timed out."""


class ProviderHTTPError(ProviderError):
    """HTTP error from the upstream provider."""

    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"HTTP {status}: {body[:200]}")
        self.status = status
        self.body = body


def redact_api_key(s: str) -> str:
    """Redact API keys for safe logging. Replaces anything that looks like sk-... or
    key=<token> with ***REDACTED***.
    """
    if not s:
        return ""
    import re
    # Replace bearer tokens and sk-... style keys
    s = re.sub(r"sk-[A-Za-z0-9_-]{8,}", "sk-***REDACTED***", s)
    s = re.sub(r"Bearer\s+[A-Za-z0-9._-]{6,}", "Bearer ***REDACTED***", s, flags=re.IGNORECASE)
    s = re.sub(r"api[_-]?key[=:\s]+[A-Za-z0-9._-]{6,}", "api_key=***REDACTED***", s, flags=re.IGNORECASE)
    s = re.sub(r"token[=:\s]+[A-Za-z0-9._-]{6,}", "token=***REDACTED***", s, flags=re.IGNORECASE)
    return s


@dataclass
class ProviderConfig:
    """Configuration for a model provider."""
    provider: str = "none"           # none | openai
    model: str = ""                  # model name
    base_url: str = ""                # e.g. http://localhost:1234/v1
    api_key: str = ""                 # API key (will not be logged)
    timeout: float = 60.0
    max_retries: int = 2
    temperature: float = 0.2
    max_tokens: int = 1024
    context_window: int = 0
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "ProviderConfig":
        return cls(
            provider=os.environ.get("CHEATER_PROVIDER", "none"),
            model=os.environ.get("CHEATER_MODEL", ""),
            base_url=os.environ.get("CHEATER_BASE_URL", ""),
            api_key=os.environ.get("CHEATER_API_KEY", ""),
            context_window=_env_int("CHEATER_CONTEXT_WINDOW") or _env_int("CHEATER_MAX_CONTEXT_TOKENS") or 0,
        )

    def is_configured(self) -> bool:
        return normalize_provider_name(self.provider) != "none" and bool(self.model) and bool(self.base_url)

    def safe_dict(self) -> dict[str, Any]:
        """Return a dict safe for logging (no api_key)."""
        return {
            "provider": normalize_provider_name(self.provider),
            "raw_provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
            "timeout": self.timeout,
            "max_retries": self.max_retries,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "context_window": self.context_window,
            "configured": self.is_configured(),
        }


def normalize_provider_name(provider: str | None) -> str:
    """Normalize user-facing provider names to backend provider IDs.

    Cheater talks to LM Studio, Ollama, llama.cpp servers, and OpenAI through
    the same OpenAI-compatible endpoint. The TUI should not punish users for
    typing the friendly tool name instead of the internal provider id.
    """
    raw = (provider or "").strip().lower()
    key = raw.replace("-", "_").replace(" ", "_")
    aliases = {
        "": "none",
        "none": "none",
        "off": "none",
        "disabled": "none",
        "no_model": "none",
        "openai": "openai",
        "openai_compatible": "openai",
        "openai_compat": "openai",
        "compatible": "openai",
        "lmstudio": "openai",
        "lm_studio": "openai",
        "lms": "openai",
        "ollama": "openai",
        "llamacpp": "openai",
        "llama_cpp": "openai",
        # Common typo / bad setting observed in the TUI.
        "nonelm_studios": "openai",
    }
    return aliases.get(key, key)


class BaseProvider:
    """Abstract base for all providers."""

    name = "base"

    def __init__(self, config: ProviderConfig) -> None:
        self.config = config

    def chat(self, messages: list[dict[str, str]], **opts: Any) -> str:
        """Synchronous chat completion. Returns the assistant message text."""
        raise NotImplementedError

    def stream_chat(self, messages: list[dict[str, str]], **opts: Any) -> Iterator[str]:
        """Stream chat completion. Yields text chunks."""
        # Default: just yield the full response
        yield self.chat(messages, **opts)

    def get_context_window(self) -> int | None:
        """Return the provider/model context window when known."""
        if self.config.context_window > 0:
            return self.config.context_window
        return None


class NoModelProvider(BaseProvider):
    """Deterministic provider. Raises ModelNotConfigured if asked to chat."""

    name = "none"

    def chat(self, messages: list[dict[str, str]], **opts: Any) -> str:
        raise ModelNotConfigured(
            "No model configured. Cheater can still search memory, run benchmarks, "
            "explore repos, and run safe commands. To enable chat/patch drafting, "
            "set CHEATER_PROVIDER, CHEATER_MODEL, CHEATER_BASE_URL, and (if needed) "
            "CHEATER_API_KEY, or run `cheater init` to use the wizard."
        )

    def stream_chat(self, messages: list[dict[str, str]], **opts: Any) -> Iterator[str]:
        raise ModelNotConfigured(self.chat(messages, **opts))


class OpenAIProvider(BaseProvider):
    """OpenAI-compatible provider (works with OpenAI, LM Studio, Ollama /v1, etc.).

    No external deps; uses urllib only.
    """

    name = "openai"

    def __init__(self, config: ProviderConfig) -> None:
        super().__init__(config)
        self._context_window_cache: int | None | bool = False

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        url = self.config.base_url.rstrip("/") + path
        headers = {"Content-Type": "application/json"}
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"
        data = json.dumps(body).encode("utf-8")
        last_err: Exception | None = None
        for attempt in range(self.config.max_retries + 1):
            try:
                req = urllib.request.Request(url, data=data, headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=self.config.timeout) as resp:
                    payload = resp.read().decode("utf-8")
                    return json.loads(payload)
            except urllib.error.HTTPError as e:
                body = ""
                try:
                    body = e.read().decode("utf-8", errors="ignore")
                except Exception:
                    pass
                raise ProviderHTTPError(e.code, body) from e
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last_err = e
                if attempt >= self.config.max_retries:
                    break
        raise ProviderTimeout(f"Request to {url} failed: {last_err}")

    def _get(self, path: str) -> dict[str, Any]:
        url = self.config.base_url.rstrip("/") + path
        headers = {"Content-Type": "application/json"}
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"
        last_err: Exception | None = None
        for attempt in range(self.config.max_retries + 1):
            try:
                req = urllib.request.Request(url, headers=headers, method="GET")
                with urllib.request.urlopen(req, timeout=self.config.timeout) as resp:
                    payload = resp.read().decode("utf-8")
                    return json.loads(payload)
            except urllib.error.HTTPError as e:
                body = ""
                try:
                    body = e.read().decode("utf-8", errors="ignore")
                except Exception:
                    pass
                raise ProviderHTTPError(e.code, body) from e
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last_err = e
                if attempt >= self.config.max_retries:
                    break
        raise ProviderTimeout(f"Request to {url} failed: {last_err}")

    def get_context_window(self) -> int | None:
        if self.config.context_window > 0:
            return self.config.context_window
        if self._context_window_cache is not False:
            return self._context_window_cache
        try:
            payload = self._get("/models")
            self._context_window_cache = _extract_context_window(payload, self.config.model)
        except Exception:
            self._context_window_cache = None
        return self._context_window_cache

    def chat(self, messages: list[dict[str, str]], **opts: Any) -> str:
        if not self.config.is_configured():
            raise ModelNotConfigured("OpenAI provider not fully configured (need model + base_url)")
        body = {
            "model": self.config.model,
            "messages": messages,
            "temperature": opts.get("temperature", self.config.temperature),
            "max_tokens": opts.get("max_tokens", self.config.max_tokens),
        }
        if "stop" in opts:
            body["stop"] = opts["stop"]
        if "response_format" in opts:
            body["response_format"] = opts["response_format"]
        resp = self._post("/chat/completions", body)
        try:
            return resp["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError) as e:
            raise ProviderError(f"Unexpected response shape: {resp}") from e


def get_provider(config: ProviderConfig | None = None) -> BaseProvider:
    """Return a provider based on config. Defaults to NoModelProvider."""
    cfg = config or ProviderConfig.from_env()
    provider = normalize_provider_name(cfg.provider)
    if provider == "openai":
        if not cfg.is_configured():
            return NoModelProvider(cfg)
        return OpenAIProvider(cfg)
    if provider == "none":
        return NoModelProvider(cfg)
    if cfg.model and cfg.base_url:
        # Be generous: any unknown provider with an OpenAI-style model+base_url
        # is almost certainly a local OpenAI-compatible server.
        cfg.provider = "openai"
        return OpenAIProvider(cfg)
    # Unknown provider: treat as none
    return NoModelProvider(cfg)


def is_model_configured() -> bool:
    """True if a model provider is configured (and likely to work)."""
    return ProviderConfig.from_env().is_configured()


def _env_int(name: str) -> int | None:
    raw = os.environ.get(name)
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def _extract_context_window(payload: Any, model: str) -> int | None:
    """Best-effort OpenAI-compatible /models context-window extraction.

    LM Studio and other local servers expose this under different names, so we
    search both the matching model object and the full payload for common keys.
    """
    keys = {
        "context_length",
        "max_context_length",
        "context_window",
        "max_context_window",
        "n_ctx",
        "num_ctx",
        "token_limit",
        "max_position_embeddings",
        "max_sequence_length",
    }

    def find_number(value: Any) -> int | None:
        if isinstance(value, dict):
            for key, item in value.items():
                lower = str(key).lower()
                if lower in keys:
                    try:
                        number = int(item)
                    except (TypeError, ValueError):
                        number = 0
                    if number > 0:
                        return number
                nested = find_number(item)
                if nested:
                    return nested
        elif isinstance(value, list):
            for item in value:
                nested = find_number(item)
                if nested:
                    return nested
        return None

    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and str(item.get("id") or "") == model:
                found = find_number(item)
                if found:
                    return found
    return find_number(payload)
