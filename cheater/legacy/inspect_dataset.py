import json
from datasets import load_dataset

ds = load_dataset("nebius/SWE-agent-trajectories", split="train")
row = ds[0]

for k, v in row.items():
    print("\n\n######## COLUMN:", k, "########")
    if isinstance(v, list):
        print("LIST LEN:", len(v))
        for i, item in enumerate(v[:5]):
            print(f"\n--- item {i} ---")
            print(json.dumps(item, ensure_ascii=False)[:1500])
    elif isinstance(v, dict):
        print(json.dumps(v, ensure_ascii=False)[:3000])
    else:
        print(str(v)[:3000])