import test from "node:test";
import assert from "node:assert/strict";
import { parseTextToolCalls, stripTextToolCalls } from "../src/core/textToolCalls.js";

test("a tool call written as prose is recovered", () => {
  // Verbatim from a live run: the model dropped out of native tool-calling after an oversized write
  // failed to parse, and every turn afterwards looked like this. The agent counted them as "produced
  // text, took no action", nudged once, and ended the run — with the model still trying to work.
  const text = `I'll check the current state of the repository.

<tool_call>
<function=read_file>
<function=tool>
<parameter=path>
/home/user/repo
</parameter>
</function>
</tool_call>`;
  const calls = parseTextToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "read_file");
  assert.equal(calls[0].args.path, "/home/user/repo");
  // And the markup leaves the prose, so the transcript shows the action once, as a tool card.
  assert.equal(stripTextToolCalls(text), "I'll check the current state of the repository.");
});

test("multi-parameter calls keep their values byte for byte", () => {
  // File content must survive untouched — no JSON parsing, no unescaping, no trimming of interior
  // whitespace. Corrupting a write is worse than missing it.
  const text = `<tool_call>
<function=write>
<parameter=path>
src/a.py
</parameter>
<parameter=content>
def f():
    return "  spaced  "
</parameter>
</function>
</tool_call>`;
  const calls = parseTextToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "write");
  assert.equal(calls[0].args.path, "src/a.py");
  assert.equal(calls[0].args.content, 'def f():\n    return "  spaced  "');
});

test("a fenced JSON call is recovered too", () => {
  const text = 'Let me look.\n\n```json\n{"name": "bash", "arguments": {"command": "ls -la"}}\n```';
  const calls = parseTextToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "bash");
  assert.equal(calls[0].args.command, "ls -la");
  assert.equal(stripTextToolCalls(text), "Let me look.");
});

test("ordinary prose and ordinary code blocks are never mistaken for calls", () => {
  assert.deepEqual(parseTextToolCalls("I will read the file next."), []);
  assert.deepEqual(parseTextToolCalls(""), []);
  // A code block that happens to be JSON is not a tool call.
  const codeBlock = 'Here is the config:\n\n```json\n{"port": 8080, "debug": true}\n```';
  assert.deepEqual(parseTextToolCalls(codeBlock), []);
  assert.equal(stripTextToolCalls(codeBlock), codeBlock, "and it is left in the transcript untouched");
  // Markup with no function name is not actionable.
  assert.deepEqual(parseTextToolCalls("<tool_call>\n</tool_call>"), []);
});

test("several calls in one turn all come back", () => {
  const text = `<tool_call><function=read_file><parameter=path>a.py</parameter></function></tool_call>
<tool_call><function=read_file><parameter=path>b.py</parameter></function></tool_call>`;
  const calls = parseTextToolCalls(text);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.args.path), ["a.py", "b.py"]);
  assert.notEqual(calls[0].id, calls[1].id, "ids must be distinct so results pair correctly");
});
