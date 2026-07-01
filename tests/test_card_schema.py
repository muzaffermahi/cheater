from __future__ import annotations

import unittest

from cheater.schema import (
    normalize_and_validate,
    normalize_card,
    stable_id,
    validate_card,
)


def _good_card() -> dict:
    return {
        "id": "test__good-1",
        "source": "test/source",
        "repo": "test/repo",
        "language": "Python",
        "bug_type": "TypeError",
        "symptom": "Parser rejects a valid alias with TypeError",
        "root_cause": "alias token classified as keyword",
        "fix_pattern": "accept alias token in the keyword branch",
        "failed_approaches": ["adding a regex hack"],
        "key_files": ["parser.py"],
        "test_signal": "test_parse_valid_alias",
        "search_keywords": ["parser", "alias", "TypeError"],
        "embedding_text": "parser TypeError alias keyword branch fix",
        "usable": True,
    }


class TestCardSchema(unittest.TestCase):
    def test_valid_usable_card_passes(self) -> None:
        card, result = normalize_and_validate(_good_card())
        self.assertTrue(result.ok, result.errors)
        self.assertTrue(card["usable"])
        self.assertEqual(card["schema_version"], "v1")
        self.assertEqual(card["failed_approaches"], ["adding a regex hack"])

    def test_missing_required_id_fails(self) -> None:
        raw = _good_card()
        raw.pop("id")
        _, result = normalize_and_validate(raw)
        self.assertFalse(result.ok)
        self.assertIn("missing required field: id", result.errors)

    def test_usable_true_requires_symptom_fix_pattern_embedding_text(self) -> None:
        raw = _good_card()
        raw["symptom"] = ""
        raw["fix_pattern"] = ""
        raw["embedding_text"] = ""
        _, result = normalize_and_validate(raw)
        self.assertFalse(result.ok)
        fields = {e.split(":", 1)[1].strip() for e in result.errors if "usable=true" in e}
        self.assertEqual(fields, {"symptom", "fix_pattern", "embedding_text"})

    def test_unusable_card_with_missing_optional_passes(self) -> None:
        raw = {"id": "test__bad-1", "source": "test", "usable": False}
        card, result = normalize_and_validate(raw)
        self.assertTrue(result.ok, result.errors)
        self.assertFalse(card["usable"])
        self.assertIsNone(card["repo"])
        self.assertEqual(card["failed_approaches"], [])
        self.assertEqual(card["search_keywords"], [])

    def test_missing_optional_normalized_to_null_or_empty(self) -> None:
        raw = {"id": "x", "source": "s", "usable": True,
               "symptom": "s", "fix_pattern": "f", "embedding_text": "e"}
        card = normalize_card(raw)
        self.assertIsNone(card["repo"])
        self.assertIsNone(card["language"])
        self.assertEqual(card["key_files"], [])
        self.assertEqual(card["search_keywords"], [])

    def test_stable_id_is_deterministic(self) -> None:
        a = stable_id("src", "inst-1")
        b = stable_id("src", "inst-1")
        self.assertEqual(a, b)
        self.assertTrue(a.startswith("card_"))

    def test_usable_string_coerced_to_bool(self) -> None:
        raw = _good_card()
        raw["usable"] = "true"
        card, _ = normalize_and_validate(raw)
        self.assertTrue(card["usable"])

    def test_search_keywords_list_accepts_string(self) -> None:
        raw = _good_card()
        raw["search_keywords"] = "parser alias"
        card, _ = normalize_and_validate(raw)
        self.assertEqual(card["search_keywords"], ["parser alias"])


if __name__ == "__main__":
    unittest.main()
