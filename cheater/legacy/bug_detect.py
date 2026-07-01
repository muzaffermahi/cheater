# inspect_dataset.py
from datasets import load_dataset

ds = load_dataset("nebius/SWE-agent-trajectories", split="train")
print(ds)
print(ds.column_names)
print(ds[0].keys())

for k, v in ds[0].items():
    print("\n---", k, type(v))
    print(str(v)[:1000])