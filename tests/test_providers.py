"""Tests for cheater.providers (model provider layer)."""
from __future__ import annotations

import unittest

from cheater.providers import (
    ModelNotConfigured,
    NoModelProvider,
    OpenAIProvider,
    ProviderConfig,
    _extract_context_window,
    get_provider,
    is_model_configured,
    normalize_provider_name,
    redact_api_key,
)


class TestRedactApiKey(unittest.TestCase):
    def test_redacts_sk_key(self):
        s = "Authorization: sk-1234567890abcdef"
        out = redact_api_key(s)
        self.assertIn("REDACTED", out)
        self.assertNotIn("1234567890abcdef", out)

    def test_redacts_bearer(self):
        s = "Authorization: Bearer abcdef123456"
        out = redact_api_key(s)
        self.assertIn("REDACTED", out)
        self.assertNotIn("abcdef123456", out)

    def test_redacts_apikey_field(self):
        s = "api_key=secret_value_here"
        out = redact_api_key(s)
        self.assertIn("REDACTED", out)
        self.assertNotIn("secret_value_here", out)

    def test_empty(self):
        self.assertEqual(redact_api_key(""), "")
        self.assertEqual(redact_api_key(None), "")

    def test_plain_text_passes(self):
        s = "this is a normal log line"
        self.assertEqual(redact_api_key(s), s)


class TestProviderConfig(unittest.TestCase):
    def test_default_unconfigured(self):
        c = ProviderConfig()
        self.assertFalse(c.is_configured())
        self.assertEqual(c.provider, "none")

    def test_safe_dict_redacts(self):
        c = ProviderConfig(provider="openai", model="x", base_url="http://x", api_key="sk-1234567890")
        d = c.safe_dict()
        # api_key is not in safe_dict
        self.assertNotIn("api_key", d)
        self.assertEqual(d["provider"], "openai")

    def test_from_env(self, monkeypatch=None):
        import os
        old = {k: os.environ.get(k) for k in ("CHEATER_PROVIDER", "CHEATER_MODEL", "CHEATER_BASE_URL", "CHEATER_CONTEXT_WINDOW")}
        try:
            os.environ["CHEATER_PROVIDER"] = "openai"
            os.environ["CHEATER_MODEL"] = "test-model"
            os.environ["CHEATER_BASE_URL"] = "http://localhost:1234/v1"
            os.environ["CHEATER_CONTEXT_WINDOW"] = "65536"
            c = ProviderConfig.from_env()
            self.assertEqual(c.provider, "openai")
            self.assertEqual(c.model, "test-model")
            self.assertEqual(c.base_url, "http://localhost:1234/v1")
            self.assertEqual(c.context_window, 65536)
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


class TestNoModelProvider(unittest.TestCase):
    def test_chat_raises(self):
        p = NoModelProvider(ProviderConfig())
        with self.assertRaises(ModelNotConfigured):
            p.chat([{"role": "user", "content": "hi"}])

    def test_stream_raises(self):
        p = NoModelProvider(ProviderConfig())
        with self.assertRaises(ModelNotConfigured):
            list(p.stream_chat([{"role": "user", "content": "hi"}]))


class TestGetProvider(unittest.TestCase):
    def test_default_is_none(self):
        p = get_provider()
        self.assertIsInstance(p, NoModelProvider)

    def test_unknown_is_none(self):
        p = get_provider(ProviderConfig(provider="xyz"))
        self.assertIsInstance(p, NoModelProvider)

    def test_unconfigured_openai_is_none(self):
        p = get_provider(ProviderConfig(provider="openai", model="", base_url=""))
        self.assertIsInstance(p, NoModelProvider)

    def test_configured_openai(self):
        p = get_provider(ProviderConfig(provider="openai", model="x", base_url="http://localhost:1234/v1"))
        self.assertIsInstance(p, OpenAIProvider)

    def test_lm_studio_aliases_are_openai_compatible(self):
        for provider in ("lmstudio", "lm_studio", "lm-studio", "ollama", "nonelm_studios"):
            with self.subTest(provider=provider):
                self.assertEqual(normalize_provider_name(provider), "openai")
                p = get_provider(
                    ProviderConfig(
                        provider=provider,
                        model="qwen",
                        base_url="http://127.0.0.1:1234/v1",
                    )
                )
                self.assertIsInstance(p, OpenAIProvider)

    def test_unknown_with_model_and_base_url_is_openai_compatible(self):
        p = get_provider(
            ProviderConfig(
                provider="my_local_server",
                model="qwen",
                base_url="http://127.0.0.1:1234/v1",
            )
        )
        self.assertIsInstance(p, OpenAIProvider)

    def test_extracts_lm_studio_context_window_metadata(self):
        payload = {
            "data": [
                {"id": "other", "max_context_length": 4096},
                {"id": "qwen", "context_length": 131072}
            ]
        }
        self.assertEqual(_extract_context_window(payload, "qwen"), 131072)


class TestIsModelConfigured(unittest.TestCase):
    def test_returns_bool(self):
        # Just check that is_model_configured returns a bool (depends on env)
        r = is_model_configured()
        self.assertIsInstance(r, bool)


if __name__ == "__main__":
    unittest.main()
