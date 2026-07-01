# mine_bug_cards.py
import json, re
from datasets import load_dataset

ERROR_PATTERNS = [
    "Traceback", "AssertionError", "TypeError", "ValueError",
    "ImportError", "ModuleNotFoundError", "FAIL", "FAILED",
    "pytest", "Exception", "Error:", "test failed"
]

def textify(x):
    if isinstance(x, str):
        return x
    return json.dumps(x, ensure_ascii=False)

def has_bug_signal(text):
    return any(p in text for p in ERROR_PATTERNS)

def extract_error_lines(text, max_lines=30):
    lines = text.splitlines()
    hits = []
    for i, line in enumerate(lines):
        if any(p in line for p in ERROR_PATTERNS):
            start = max(0, i - 3)
            end = min(len(lines), i + 8)
            hits.extend(lines[start:end])
    seen = []
    for line in hits:
        if line not in seen:
            seen.append(line)
    return "\n".join(seen[:max_lines])

ds = load_dataset("nebius/SWE-agent-trajectories", split="train")

cards = []
for idx, row in enumerate(ds):
    full = "\n".join(f"{k}:\n{textify(v)}" for k, v in row.items())
    if not has_bug_signal(full):
        continue

    card = {
        "id": f"swe_agent_{idx}",
        "source": "nebius/SWE-agent-trajectories",
        "error_excerpt": extract_error_lines(full),
        "raw_preview": full[:6000],
    }
    cards.append(card)

    if len(cards) % 1000 == 0:
        print("cards:", len(cards))

with open("bug_cards_raw.jsonl", "w", encoding="utf-8") as f:
    for c in cards:
        f.write(json.dumps(c, ensure_ascii=False) + "\n")

print("DONE:", len(cards))