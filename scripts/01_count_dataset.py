from __future__ import annotations

from datasets import load_dataset


DATASET_NAME = "nebius/SWE-agent-trajectories"


def safe_preview(value: object, limit: int = 2000) -> str:
    if value is None:
        return ""
    text = str(value)
    return text[:limit]


def main() -> None:
    print(f"Loading dataset: {DATASET_NAME}")
    ds = load_dataset(DATASET_NAME, split="train")

    total = len(ds)
    target_true = 0
    target_false = 0
    target_other = 0

    first_solved_index = None
    first_solved_row = None

    for i, row in enumerate(ds):
        target = row.get("target")
        if target is True:
            target_true += 1
            if first_solved_row is None:
                first_solved_index = i
                first_solved_row = row
        elif target is False:
            target_false += 1
        else:
            target_other += 1

    print("\n=== Dataset summary ===")
    print("total:", total)
    print("target true:", target_true)
    print("target false:", target_false)
    print("target other:", target_other)

    print("\n=== Columns ===")
    print(ds.column_names)

    if first_solved_row is None:
        print("\nNo solved rows found where target is True.")
        return

    row = first_solved_row
    print("\n=== First solved example ===")
    print("index:", first_solved_index)
    print("instance_id:", row.get("instance_id"))
    print("model_name:", row.get("model_name"))
    print("exit_status:", row.get("exit_status"))

    patch = row.get("generated_patch") or ""
    logs = row.get("eval_logs") or ""

    print("\n--- patch preview ---")
    print(safe_preview(patch, 2000))

    print("\n--- eval tail preview ---")
    print(logs[-2000:] if logs else "")


if __name__ == "__main__":
    main()
