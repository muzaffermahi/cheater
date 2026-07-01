"""Tests for cheater.parser (forgiving tool-call parser). NO network."""
from __future__ import annotations

import unittest

from cheater.parser import (
    parse_json_loose,
    parse_tool_call,
    repair_json,
)


class TestParseJsonLoose(unittest.TestCase):
    def test_plain_json(self):
        v, err = parse_json_loose('{"a": 1}')
        self.assertEqual(v, {"a": 1})
        self.assertEqual(err, "")

    def test_fenced(self):
        v, _ = parse_json_loose('```json\n{"a": 1}\n```')
        self.assertEqual(v, {"a": 1})

    def test_with_prose(self):
        v, _ = parse_json_loose('Here is the call: {"a": 1} -- end')
        self.assertEqual(v, {"a": 1})

    def test_unbalanced(self):
        v, err = parse_json_loose('{"a": 1')
        self.assertIsNone(v)
        self.assertTrue(err)  # any error message is fine

    def test_empty(self):
        v, err = parse_json_loose("")
        self.assertIsNone(v)


class TestRepairJson(unittest.TestCase):
    def test_python_booleans(self):
        self.assertEqual(repair_json('{"a": True, "b": False, "c": None}'),
                         '{"a": true, "b": false, "c": null}')

    def test_single_quotes(self):
        self.assertEqual(repair_json("{'a': 1}"), '{"a": 1}')

    def test_trailing_comma(self):
        self.assertEqual(repair_json('{"a": 1, "b": 2,}'), '{"a": 1, "b": 2}')

    def test_unquoted_keys(self):
        self.assertEqual(repair_json('{foo: 1, bar: 2}'), '{"foo": 1, "bar": 2}')


class TestParseToolCallJson(unittest.TestCase):
    def test_plain(self):
        action, err = parse_tool_call('{"action": "read_file", "args": {"path": "x.py"}}')
        self.assertEqual(err, "")
        self.assertEqual(action, {"action": "read_file", "args": {"path": "x.py"}})

    def test_with_prose(self):
        action, _ = parse_tool_call('Here: {"action": "finish", "args": {}}')
        self.assertIsNotNone(action)
        self.assertEqual(action["action"], "finish")

    def test_repair_python_booleans(self):
        action, _ = parse_tool_call('{"action": "read_file", "args": {"path": "x.py", "verbose": True}}')
        self.assertIsNotNone(action)
        self.assertEqual(action["args"]["verbose"], True)

    def test_empty(self):
        action, err = parse_tool_call("")
        self.assertIsNone(action)
        self.assertEqual(err, "empty response")


class TestParseToolCallYaml(unittest.TestCase):
    def test_basic(self):
        text = "action: read_file\npath: x.py"
        action, _ = parse_tool_call(text)
        self.assertIsNotNone(action)
        self.assertEqual(action["action"], "read_file")
        self.assertEqual(action["args"]["path"], "x.py")

    def test_with_args_section(self):
        text = "action: read_file\nargs:\n  path: x.py\n  line_range: 1-50"
        action, _ = parse_tool_call(text)
        self.assertIsNotNone(action)
        self.assertEqual(action["action"], "read_file")
        self.assertEqual(action["args"]["path"], "x.py")
        self.assertEqual(action["args"]["line_range"], "1-50")

    def test_yaml_list_action(self):
        text = "- action: search_code\n  query: score_card"
        action, _ = parse_tool_call(text)
        self.assertIsNotNone(action)
        self.assertEqual(action["action"], "search_code")

    def test_yaml_bool_coercion(self):
        text = "action: read_file\nargs:\n  path: x.py\n  verbose: yes"
        action, _ = parse_tool_call(text)
        self.assertIsNotNone(action)
        self.assertEqual(action["args"]["verbose"], True)


class TestParseToolCallXml(unittest.TestCase):
    def test_basic(self):
        text = '<tool name="read_file"><arg name="path">x.py</arg></tool>'
        action, _ = parse_tool_call(text)
        self.assertIsNotNone(action)
        self.assertEqual(action["action"], "read_file")
        self.assertEqual(action["args"]["path"], "x.py")

    def test_multiple_args(self):
        text = '<tool name="read_file"><arg name="path">x.py</arg><arg name="line_range">1-50</arg></tool>'
        action, _ = parse_tool_call(text)
        self.assertIsNotNone(action)
        self.assertEqual(action["args"]["line_range"], "1-50")


class TestParseToolCallHermes(unittest.TestCase):
    def test_basic(self):
        text = '<|tool_call|>{"name": "read_file", "arguments": {"path": "x.py"}}<|/tool_call|>'
        action, _ = parse_tool_call(text)
        self.assertIsNotNone(action)
        self.assertEqual(action["action"], "read_file")
        self.assertEqual(action["args"]["path"], "x.py")

    def test_no_close_tag(self):
        text = '<|tool_call|>{"name": "search_code", "arguments": {"query": "foo"}}'
        action, _ = parse_tool_call(text)
        self.assertIsNotNone(action)
        self.assertEqual(action["action"], "search_code")


class TestParseToolCallPlainVerb(unittest.TestCase):
    def test_simple(self):
        action, _ = parse_tool_call('read_file(path="x.py")')
        self.assertIsNotNone(action)
        self.assertEqual(action["action"], "read_file")
        self.assertEqual(action["args"]["path"], "x.py")

    def test_multiple_args(self):
        action, _ = parse_tool_call('read_file(path="x.py", line_range="1-50")')
        self.assertIsNotNone(action)
        self.assertEqual(action["args"]["line_range"], "1-50")


class TestParseToolCallCategory(unittest.TestCase):
    def test_category_format(self):
        text = '{"category": "read"}'
        action, _ = parse_tool_call(text)
        self.assertIsNotNone(action)
        self.assertEqual(action.get("category"), "read")


class TestParseToolCallFallback(unittest.TestCase):
    def test_unparseable_returns_none(self):
        action, err = parse_tool_call("this is just plain text without structure")
        self.assertIsNone(action)
        self.assertIn("could not parse", err)


if __name__ == "__main__":
    unittest.main()
