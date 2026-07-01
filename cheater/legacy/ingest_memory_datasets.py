import json
import logging
import os
import re
import shutil
import sys
import time
import traceback
from dataclasses import asdict, is_dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Iterator, NamedTuple


from .memory_dataset_registry import DatasetRegistry
from .memory_normalizers import get_normalizer


# ============================================================

# CHEATER MEMORY INGEST CONFIG

# Edit these values instead of passing flags.

# ============================================================

# Ingest every memory dataset in this list in one run.

DATASETS_TO_INGEST = [
    "nebius/SWE-rebench-V2-PRs",
    "nebius/SWE-rebench-V2",
    "nebius/SWE-rebench",
    "ByteDance-Seed/Multi-SWE-bench",
    "somethingone/MULocBench",
]

# Output JSONL. Existing file is backed up by default.

OUTPUT_PATH = Path("memory_store/raw_normalized.jsonl")

# Limits. None means ingest the full dataset(s). CHUNK_SIZE is only for progress
# and checkpointing; it does not stop ingestion.

TOTAL_LIMIT: int | None = None
LIMIT_PER_DATASET: int | None = None
CHUNK_SIZE = 30_000

# Hugging Face behavior.

USE_STREAMING = True
CACHE_DIR: str | None = None
FALLBACK_SPLITS = ["train", "filtered", "test", "validation", "dev"]

# Long-run reliability. Streaming HTTP occasionally throws transient socket
# errors on Windows; reload and continue from the last row instead of failing.

LOAD_RETRIES = 5
ROW_STREAM_RETRIES = 20
RETRY_BASE_SLEEP_SECONDS = 2.0
RETRY_MAX_SLEEP_SECONDS = 120.0
QUIET_HF_RETRY_WARNINGS = True

# Safety: keep SWE-bench / Verified out of memory by default.

INCLUDE_QUARANTINED = False

# Existing output behavior.

RESUME_OUTPUT = True
APPEND_OUTPUT = False
BACKUP_EXISTING_OUTPUT = True

# Progress and memory guard.

PROGRESS_EVERY = 250
FLUSH_EVERY = 100
MANIFEST_EVERY = CHUNK_SIZE
MAX_RAM_MB: float | None = 6_000.0  # set None to disable

# Error reporting.

MAX_ERROR_EXAMPLES_PER_DATASET = 20
MAX_STREAM_SKIP_ERRORS = 1_000

# Manifest files.

MANIFEST_NAME = "ingest_manifest.json"
PARTIAL_MANIFEST_NAME = "ingest_manifest_partial.json"

# ============================================================

# Small utilities

# ============================================================

def configure_logging() -> None:
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

    if not QUIET_HF_RETRY_WARNINGS:
        return

    # Hugging Face / fsspec can emit noisy transient retry messages from lower
    # layers, including after a streaming iterator is abandoned at the limit.
    # This script prints its own retry progress, so keep library loggers quiet.
    for name in (
        "datasets",
        "fsspec",
        "huggingface_hub",
        "huggingface_hub.utils._http",
        "urllib3",
    ):
        logging.getLogger(name).setLevel(logging.ERROR)

    try:
        from datasets import logging as datasets_logging

        datasets_logging.set_verbosity_error()
    except Exception:
        pass

    try:
        from huggingface_hub.utils import logging as hf_logging

        hf_logging.set_verbosity_error()
    except Exception:
        pass

def now_stamp() -> str:
    return datetime.now().isoformat(timespec="seconds")


def filename_stamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def get_rss_mb() -> float | None:
    try:
        import psutil
        return psutil.Process().memory_info().rss / 1024 / 1024
    except Exception:
        pass

    if sys.platform != "win32":
        return None

    try:
        import ctypes
        from ctypes import wintypes

        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
        handle = ctypes.windll.kernel32.GetCurrentProcess()
        ok = ctypes.windll.psapi.GetProcessMemoryInfo(
            handle,
            ctypes.byref(counters),
            counters.cb,
        )
        if ok:
            return counters.WorkingSetSize / 1024 / 1024
    except Exception:
        return None

    return None


def format_rss() -> str:
    rss = get_rss_mb()
    if rss is None:
        return "ram=?"
    return f"ram={rss:.1f}MB"


def check_memory_guard() -> None:
    if MAX_RAM_MB is None:
        return
    rss = get_rss_mb()
    if rss is None:
        return
    if rss > MAX_RAM_MB:
        raise MemoryError(
            f"RAM guard triggered: process RSS is {rss:.1f}MB, "
            f"limit is {MAX_RAM_MB:.1f}MB. Partial output is already written."
        )


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def resolve_output_path(path: Path) -> Path:
    expanded = path.expanduser()
    if expanded.is_absolute():
        return expanded.resolve()
    return (Path(__file__).resolve().parent / expanded).resolve()


def backup_existing_output(path: Path) -> None:
    if RESUME_OUTPUT:
        print(f"Resume enabled; keeping existing output in place: {path}")
        return
    if not path.exists() or APPEND_OUTPUT:
        return
    if BACKUP_EXISTING_OUTPUT:
        backup = path.with_suffix(path.suffix + f".bak_{filename_stamp()}")
        shutil.move(str(path), str(backup))
        print(f"Existing output backed up to: {backup}")
    else:
        path.unlink()
        print(f"Existing output removed: {path}")


def to_plain_dict(obj: Any) -> dict[str, Any]:
    if obj is None:
        return {}

    if hasattr(obj, "to_dict") and callable(getattr(obj, "to_dict")):
        out = obj.to_dict()
        if isinstance(out, dict):
            return out

    if is_dataclass(obj):
        out = asdict(obj)
        if isinstance(out, dict):
            return out

    if isinstance(obj, dict):
        return obj

    raise TypeError(f"Cannot serialize object of type {type(obj).__name__}")


def write_jsonl(handle, obj: dict[str, Any]) -> None:
    handle.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")


def shorten_error(exc: BaseException) -> str:
    return "".join(traceback.format_exception_only(type(exc), exc)).strip()


def retry_sleep(attempt: int) -> None:
    delay = min(
        RETRY_MAX_SLEEP_SECONDS,
        RETRY_BASE_SLEEP_SECONDS * (2 ** max(0, attempt - 1)),
    )
    print(f"  retrying in {delay:.0f}s [attempt {attempt}]")
    time.sleep(delay)


class OutputResumeState(NamedTuple):
    counts: dict[str, int]
    next_row_indexes: dict[str, int]
    total_records: int


def load_json_file(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as f:
            value = json.load(f)
        return value if isinstance(value, dict) else None
    except Exception as exc:
        print(f"Could not read JSON file {path}: {shorten_error(exc)}")
        return None


def load_resume_manifest(output_path: Path) -> dict[str, Any] | None:
    partial = output_path.parent / PARTIAL_MANIFEST_NAME
    final = output_path.parent / MANIFEST_NAME
    return load_json_file(partial) or load_json_file(final)


def scan_existing_output(path: Path) -> OutputResumeState:
    counts: dict[str, int] = {}
    max_row_indexes: dict[str, int] = {}
    total_records = 0
    bad_lines = 0

    if not path.exists() or path.stat().st_size == 0:
        return OutputResumeState(counts, {}, 0)

    print(f"Scanning existing output for resume: {path}")
    with path.open("r", encoding="utf-8") as f:
        for line_number, line in enumerate(f, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except Exception:
                bad_lines += 1
                if bad_lines <= 5:
                    print(f"  ignoring invalid JSONL line {line_number}")
                continue

            dataset_id = str(record.get("source_dataset") or "")
            if not dataset_id:
                continue

            total_records += 1
            counts[dataset_id] = counts.get(dataset_id, 0) + 1

            try:
                row_index = int(record.get("source_row_index"))
            except Exception:
                row_index = counts[dataset_id] - 1
            max_row_indexes[dataset_id] = max(
                max_row_indexes.get(dataset_id, -1),
                row_index,
            )

            if total_records % CHUNK_SIZE == 0:
                print(f"  scanned {total_records} records...")

    next_row_indexes = {
        dataset_id: max_row_index + 1
        for dataset_id, max_row_index in max_row_indexes.items()
    }
    print(f"Resume scan complete: {total_records} records found")
    if bad_lines:
        print(f"Invalid JSONL lines ignored during scan: {bad_lines}")
    return OutputResumeState(counts, next_row_indexes, total_records)


def infer_completed_datasets_from_output(
    selected: list[Any],
    resume_state: OutputResumeState,
) -> set[str]:
    counted_ids = [
        getattr(ds, "dataset_id", str(ds))
        for ds in selected
        if resume_state.counts.get(getattr(ds, "dataset_id", str(ds)), 0) > 0
    ]
    if len(counted_ids) <= 1:
        return set()
    # If there is no usable manifest, assume the last dataset with output is the
    # interrupted one and earlier datasets with output are complete.
    return set(counted_ids[:-1])

# ============================================================

# Dataset resolution

# ============================================================

def load_registry() -> DatasetRegistry:
    project_root = Path(__file__).resolve().parent
    registry_path = project_root / "memory_datasets.json"

    if not registry_path.exists():
        raise FileNotFoundError(f"Missing dataset registry: {registry_path}")

    return DatasetRegistry.load(registry_path)


def resolve_selected_datasets(registry: DatasetRegistry) -> tuple[list[Any], list[str]]:
    """
    Uses the existing DatasetRegistry API from your project.

    Expected existing methods:
    - resolve_ids(ids, all_enabled=False, include_quarantined=False)
    - quarantined()
    """
    try:
        selected = registry.resolve_ids(
            DATASETS_TO_INGEST,
            all_enabled=False,
            include_quarantined=INCLUDE_QUARANTINED,
        )
    except Exception as exc:
        print("Could not resolve DATASETS_TO_INGEST through DatasetRegistry.")
        print(f"Error: {exc}")
        print("\nCheck memory_datasets.json and make sure these names exist:")
        for item in DATASETS_TO_INGEST:
            print(f"  - {item}")
        raise

    quarantined_skipped: list[str] = []

    if not INCLUDE_QUARANTINED:
        filtered = []
        for ds in selected:
            if getattr(ds, "quarantined", False):
                quarantined_skipped.append(getattr(ds, "dataset_id", str(ds)))
            else:
                filtered.append(ds)
        selected = filtered

    try:
        for ds in registry.quarantined():
            ds_id = getattr(ds, "dataset_id", str(ds))
            if ds_id not in quarantined_skipped:
                quarantined_skipped.append(ds_id)
    except Exception:
        pass

    return selected, quarantined_skipped


# ============================================================

# Hugging Face loading

# ============================================================

def load_multiswebench_raw_rows(hf_name: str, split: str) -> tuple[Iterable[dict[str, Any]], str]:
    try:
        from huggingface_hub import HfApi, hf_hub_download
    except ImportError as exc:
        raise RuntimeError(
            "Missing dependency: huggingface_hub. Install with: "
            "python -m pip install huggingface_hub"
        ) from exc

    def iter_rows() -> Iterator[dict[str, Any]]:
        api = HfApi()
        files = sorted(
            path
            for path in api.list_repo_files(hf_name, repo_type="dataset")
            if path.endswith(".jsonl")
        )
        if not files:
            raise RuntimeError(f"No JSONL files found in HF dataset: {hf_name}")

        for repo_file in files:
            local_path: str | None = None
            last_exc: BaseException | None = None
            for attempt in range(1, LOAD_RETRIES + 1):
                try:
                    local_path = hf_hub_download(
                        repo_id=hf_name,
                        repo_type="dataset",
                        filename=repo_file,
                        cache_dir=CACHE_DIR,
                    )
                    break
                except KeyboardInterrupt:
                    raise
                except Exception as exc:
                    last_exc = exc
                    print(f"Download failed for {repo_file}: {shorten_error(exc)}")
                    if attempt >= LOAD_RETRIES:
                        raise
                    retry_sleep(attempt)

            if local_path is None:
                assert last_exc is not None
                raise last_exc

            print(f"Reading cached HF JSONL file: {repo_file}")
            with open(local_path, "r", encoding="utf-8") as f:
                for line_index, line in enumerate(f, start=1):
                    if not line.strip():
                        continue
                    try:
                        row = json.loads(line)
                    except Exception as exc:
                        raise ValueError(
                            f"Invalid JSON in {repo_file} line {line_index}: "
                            f"{shorten_error(exc)}"
                        ) from exc
                    if isinstance(row, dict):
                        row.setdefault("source_file", repo_file)
                        row.setdefault("split", split)
                        yield row
                    else:
                        yield {"value": row, "source_file": repo_file, "split": split}

    print(f"Loading HF dataset as raw JSONL files: {hf_name}")
    print(f"Split label: {split}")
    return iter_rows(), split


def parse_available_splits(message: str) -> list[str]:
    match = re.search(r"Available splits:\s*\[(.*?)\]", message)
    if not match:
        return []
    return re.findall(r"['\"]([^'\"]+)['\"]", match.group(1))


def split_candidates(preferred_split: str) -> list[str]:
    out: list[str] = []
    for split in [preferred_split, *FALLBACK_SPLITS]:
        if split and split not in out:
            out.append(split)
    return out


def load_hf_rows(hf_name: str, split: str) -> tuple[Iterable[dict[str, Any]], str]:
    if hf_name == "ByteDance-Seed/Multi-SWE-bench":
        return load_multiswebench_raw_rows(hf_name, split)

    try:
        from datasets import load_dataset
    except ImportError as exc:
        raise RuntimeError(
            "Missing dependency: datasets. Install with: python -m pip install datasets"
        ) from exc

    print(f"Loading HF dataset: {hf_name}")
    print(f"Preferred split: {split}")
    print(f"Streaming: {USE_STREAMING}")

    last_exc: BaseException | None = None
    candidates = split_candidates(split)
    tried: set[str] = set()
    candidate_index = 0

    while candidate_index < len(candidates):
        current_split = candidates[candidate_index]
        candidate_index += 1
        if current_split in tried:
            continue
        tried.add(current_split)

        for attempt in range(1, LOAD_RETRIES + 1):
            try:
                print(f"Trying split: {current_split}")
                if USE_STREAMING:
                    # Important: streaming avoids materializing the full Arrow table into RAM.
                    return (
                        load_dataset(
                            hf_name,
                            split=current_split,
                            cache_dir=CACHE_DIR,
                            streaming=True,
                        ),
                        current_split,
                    )

                # Non-streaming fallback. Still safe as long as we do NOT call list(dataset).
                return (
                    load_dataset(
                        hf_name,
                        split=current_split,
                        cache_dir=CACHE_DIR,
                        download_mode="reuse_dataset_if_exists",
                    ),
                    current_split,
                )
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                last_exc = exc
                message = shorten_error(exc)
                available_splits = parse_available_splits(message)
                if available_splits:
                    for available_split in available_splits:
                        if available_split not in tried and available_split not in candidates:
                            candidates.append(available_split)
                    print(
                        f"Split {current_split!r} unavailable; available splits: "
                        f"{available_splits}"
                    )
                    break

                print(f"Load failed: {message}")
                if attempt >= LOAD_RETRIES:
                    break
                retry_sleep(attempt)

    assert last_exc is not None
    raise last_exc


def close_rows(rows: Any) -> None:
    for attr in ("close",):
        method = getattr(rows, attr, None)
        if callable(method):
            try:
                method()
            except Exception:
                pass


def skip_rows(iterator: Iterator[Any], count: int) -> None:
    for _ in range(count):
        next(iterator)


# ============================================================

# Manifest

# ============================================================

def build_manifest(
    *,
    status: str,
    started_at: str,
    output_path: Path,
    dataset_counts: dict[str, int],
    skipped_counts: dict[str, int],
    error_counts: dict[str, int],
    error_examples: dict[str, list[str]],
    quarantined_skipped: list[str],
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    manifest = {
        "status": status,
        "started_at": started_at,
        "finished_at": now_stamp(),
        "command": " ".join(sys.argv),
        "config": {
            "datasets_to_ingest": DATASETS_TO_INGEST,
            "output_path": str(output_path),
            "total_limit": TOTAL_LIMIT,
            "limit_per_dataset": LIMIT_PER_DATASET,
            "chunk_size": CHUNK_SIZE,
            "use_streaming": USE_STREAMING,
            "cache_dir": CACHE_DIR,
            "load_retries": LOAD_RETRIES,
            "row_stream_retries": ROW_STREAM_RETRIES,
            "retry_base_sleep_seconds": RETRY_BASE_SLEEP_SECONDS,
            "retry_max_sleep_seconds": RETRY_MAX_SLEEP_SECONDS,
            "quiet_hf_retry_warnings": QUIET_HF_RETRY_WARNINGS,
            "resume_output": RESUME_OUTPUT,
            "include_quarantined": INCLUDE_QUARANTINED,
            "append_output": APPEND_OUTPUT,
            "backup_existing_output": BACKUP_EXISTING_OUTPUT,
            "progress_every": PROGRESS_EVERY,
            "flush_every": FLUSH_EVERY,
            "manifest_every": MANIFEST_EVERY,
            "max_ram_mb": MAX_RAM_MB,
        },
        "dataset_counts": dataset_counts,
        "skipped_counts": skipped_counts,
        "error_counts": error_counts,
        "error_examples": error_examples,
        "quarantined_skipped": quarantined_skipped,
    }

    if extra:
        manifest["extra"] = extra

    return manifest


def save_manifest(path: Path, manifest: dict[str, Any], partial: bool = False) -> None:
    manifest_path = path.parent / (PARTIAL_MANIFEST_NAME if partial else MANIFEST_NAME)
    with manifest_path.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False, default=str)
    print(f"Manifest saved to: {manifest_path}")

# ============================================================

# Ingestion

# ============================================================

def ingest_dataset(
    *,
    ds: Any,
    output_handle,
    output_path: Path,
    total_written_so_far: int,
    started_at: str,
    dataset_counts: dict[str, int],
    skipped_counts: dict[str, int],
    error_counts: dict[str, int],
    error_examples: dict[str, list[str]],
    quarantined_skipped: list[str],
    resume_row_index: int = 0,
    existing_written_count: int = 0,
) -> tuple[int, int, int, list[str]]:
    ds_id = getattr(ds, "dataset_id", None) or getattr(ds, "hf_name", None) or str(ds)
    hf_name = getattr(ds, "hf_name", ds_id)
    split = getattr(ds, "default_split", "train")
    role = getattr(ds, "role", "unknown")

    print("\n" + "=" * 72)
    print(f"Dataset: {ds_id}")
    print(f"HF name: {hf_name}")
    print(f"Role: {role}")
    print("=" * 72)
    print(f"Before load: {format_rss()}")

    normalizer = get_normalizer(ds_id)

    written = existing_written_count
    skipped = 0
    errors: list[str] = []
    row_index = resume_row_index
    stream_retry_count = 0
    last_manifest_total = total_written_so_far
    actual_split = split

    rows: Iterable[dict[str, Any]] | None = None
    iterator: Iterator[Any] | None = None

    while True:
        if LIMIT_PER_DATASET is not None and written >= LIMIT_PER_DATASET:
            print(f"Reached LIMIT_PER_DATASET={LIMIT_PER_DATASET}")
            break

        if TOTAL_LIMIT is not None and total_written_so_far + written >= TOTAL_LIMIT:
            print(f"Reached TOTAL_LIMIT={TOTAL_LIMIT}")
            break

        if iterator is None:
            rows, actual_split = load_hf_rows(hf_name, split)
            iterator = iter(rows)

            if row_index:
                print(f"Resuming stream at row_index={row_index}")
                try:
                    skip_rows(iterator, row_index)
                except KeyboardInterrupt:
                    raise
                except Exception as exc:
                    close_rows(rows)
                    rows = None
                    iterator = None
                    stream_retry_count += 1
                    if len(errors) < MAX_ERROR_EXAMPLES_PER_DATASET:
                        errors.append(
                            f"resume at row {row_index}: {shorten_error(exc)}"
                        )
                    print(f"Stream resume failed: {shorten_error(exc)}")
                    if stream_retry_count >= ROW_STREAM_RETRIES:
                        raise RuntimeError(
                            f"Stream failed {stream_retry_count} times while "
                            f"resuming {ds_id} at row {row_index}"
                        ) from exc
                    retry_sleep(stream_retry_count)
                    continue

            print(f"After load: {format_rss()}")

        try:
            row = next(iterator)
        except StopIteration:
            break
        except KeyboardInterrupt:
            raise
        except Exception as exc:
            if rows is not None:
                close_rows(rows)
            rows = None
            iterator = None
            stream_retry_count += 1
            skipped += 1

            if len(errors) < MAX_ERROR_EXAMPLES_PER_DATASET:
                errors.append(f"stream at row {row_index}: {shorten_error(exc)}")

            print(
                f"Stream read failed at row_index={row_index}: "
                f"{shorten_error(exc)}"
            )
            if stream_retry_count >= ROW_STREAM_RETRIES:
                raise RuntimeError(
                    f"Stream failed {stream_retry_count} times while reading "
                    f"{ds_id} at row {row_index}"
                ) from exc
            retry_sleep(stream_retry_count)
            continue

        try:
            check_memory_guard()

            # Hugging Face streaming rows should already be dict-like.
            if not isinstance(row, dict):
                try:
                    row = dict(row)
                except Exception:
                    raise TypeError(f"HF row is not dict-like: {type(row).__name__}")

            row.setdefault("split", actual_split)
            record = normalizer.normalize(row, row_index)

            if record is None:
                skipped += 1
                continue

            write_jsonl(output_handle, to_plain_dict(record))
            written += 1

            if written % FLUSH_EVERY == 0:
                output_handle.flush()

            if written % PROGRESS_EVERY == 0:
                print(
                    f"  progress: written={written}, skipped={skipped}, "
                    f"row_index={row_index}, {format_rss()}"
                )

            current_total = total_written_so_far + written
            if MANIFEST_EVERY and current_total - last_manifest_total >= MANIFEST_EVERY:
                output_handle.flush()
                dataset_counts[ds_id] = written
                skipped_counts[ds_id] = skipped
                error_counts[ds_id] = len(errors)
                error_examples[ds_id] = errors
                save_manifest(
                    output_path,
                    build_manifest(
                        status="running",
                        started_at=started_at,
                        output_path=output_path,
                        dataset_counts=dataset_counts,
                        skipped_counts=skipped_counts,
                        error_counts=error_counts,
                        error_examples=error_examples,
                        quarantined_skipped=quarantined_skipped,
                        extra={
                            "current_dataset": ds_id,
                            "current_row_index": row_index,
                            "total_written_so_far": current_total,
                            "chunk_size": CHUNK_SIZE,
                        },
                    ),
                    partial=True,
                )
                last_manifest_total = current_total

        except KeyboardInterrupt:
            raise
        except Exception as exc:
            skipped += 1
            if len(errors) < MAX_ERROR_EXAMPLES_PER_DATASET:
                errors.append(f"row {row_index}: {shorten_error(exc)}")

            if (skipped + len(errors)) % PROGRESS_EVERY == 0:
                print(
                    f"  progress: written={written}, skipped={skipped}, "
                    f"row_index={row_index}, {format_rss()}"
                )
        finally:
            row_index += 1

    if rows is not None:
        close_rows(rows)

    output_handle.flush()

    print(f"\nFinished dataset: {ds_id}")
    print(f"  written: {written}")
    print(f"  skipped: {skipped}")
    print(f"  errors captured: {len(errors)}")
    print(f"  stream retries: {stream_retry_count}")
    print(f"  final memory: {format_rss()}")

    if errors:
        print("  first errors:")
        for err in errors[:5]:
            print(f"   - {err}")

    return written, skipped, len(errors), errors


def main() -> int:
    configure_logging()

    started_at = now_stamp()

    output_path = resolve_output_path(OUTPUT_PATH)
    ensure_parent(output_path)
    backup_existing_output(output_path)

    print("Cheater memory dataset ingestion")
    print(f"Started: {started_at}")
    print(f"Output: {output_path}")
    print(f"Datasets: {DATASETS_TO_INGEST}")
    print(f"TOTAL_LIMIT={TOTAL_LIMIT if TOTAL_LIMIT is not None else 'ALL'}")
    print(
        "LIMIT_PER_DATASET="
        f"{LIMIT_PER_DATASET if LIMIT_PER_DATASET is not None else 'ALL'}"
    )
    print(f"CHUNK_SIZE={CHUNK_SIZE}")
    print(f"USE_STREAMING={USE_STREAMING}")
    print(f"Start memory: {format_rss()}")

    registry = load_registry()
    selected, quarantined_skipped = resolve_selected_datasets(registry)

    if not selected:
        print("No datasets selected after quarantine filtering.")
        return 0

    resume_manifest = load_resume_manifest(output_path) if RESUME_OUTPUT else None
    resume_state = scan_existing_output(output_path) if RESUME_OUTPUT else OutputResumeState({}, {}, 0)
    completed_from_manifest = set()
    if resume_manifest:
        manifest_status = resume_manifest.get("status")
        manifest_counts = resume_manifest.get("dataset_counts")
        if isinstance(manifest_counts, dict):
            completed_from_manifest.update(str(dataset_id) for dataset_id in manifest_counts)
        print(
            f"Resume manifest found: status={manifest_status}, "
            f"completed_datasets={sorted(completed_from_manifest)}"
        )
    elif RESUME_OUTPUT and resume_state.total_records:
        completed_from_manifest.update(
            infer_completed_datasets_from_output(selected, resume_state)
        )
        if completed_from_manifest:
            print(
                "No resume manifest found; inferred completed datasets from "
                f"existing output: {sorted(completed_from_manifest)}"
            )

    dataset_counts: dict[str, int] = dict(resume_state.counts)
    skipped_counts: dict[str, int] = {}
    error_counts: dict[str, int] = {}
    error_examples: dict[str, list[str]] = {}

    total_written = resume_state.total_records
    total_skipped = 0
    total_errors = 0

    status = "success"
    extra: dict[str, Any] = {}

    try:
        with output_path.open("a", encoding="utf-8") as output_handle:
            for ds in selected:
                if TOTAL_LIMIT is not None and total_written >= TOTAL_LIMIT:
                    break

                ds_id = getattr(ds, "dataset_id", str(ds))
                existing_count = resume_state.counts.get(ds_id, 0)
                resume_row_index = resume_state.next_row_indexes.get(ds_id, 0)

                if RESUME_OUTPUT and ds_id in completed_from_manifest:
                    print(
                        f"\nSkipping completed dataset from resume manifest: "
                        f"{ds_id} ({existing_count} records already in output)"
                    )
                    dataset_counts[ds_id] = existing_count
                    continue

                if RESUME_OUTPUT and existing_count:
                    print(
                        f"\nResuming dataset {ds_id}: "
                        f"{existing_count} existing records, "
                        f"next row_index={resume_row_index}"
                    )

                written, skipped, err_count, errors = ingest_dataset(
                    ds=ds,
                    output_handle=output_handle,
                    output_path=output_path,
                    total_written_so_far=total_written - existing_count,
                    started_at=started_at,
                    dataset_counts=dataset_counts,
                    skipped_counts=skipped_counts,
                    error_counts=error_counts,
                    error_examples=error_examples,
                    quarantined_skipped=quarantined_skipped,
                    resume_row_index=resume_row_index,
                    existing_written_count=existing_count,
                )

                dataset_counts[ds_id] = written
                skipped_counts[ds_id] = skipped
                error_counts[ds_id] = err_count
                error_examples[ds_id] = errors

                total_written += written - existing_count
                total_skipped += skipped
                total_errors += err_count

                if TOTAL_LIMIT is not None and total_written >= TOTAL_LIMIT:
                    print(f"\nReached global TOTAL_LIMIT={TOTAL_LIMIT}")
                    break

    except KeyboardInterrupt:
        status = "interrupted"
        extra["reason"] = "KeyboardInterrupt"
        print("\nInterrupted by user. Partial output is already saved.")

    except MemoryError as exc:
        status = "memory_guard_stopped"
        extra["reason"] = str(exc)
        print(f"\n{exc}")
        print("Partial output is already saved.")

    except Exception as exc:
        status = "error"
        extra["reason"] = shorten_error(exc)
        extra["traceback"] = traceback.format_exc()
        print("\nFatal ingestion error:")
        print(extra["reason"])
        print(extra["traceback"])

    manifest = build_manifest(
        status=status,
        started_at=started_at,
        output_path=output_path,
        dataset_counts=dataset_counts,
        skipped_counts=skipped_counts,
        error_counts=error_counts,
        error_examples=error_examples,
        quarantined_skipped=quarantined_skipped,
        extra=extra,
    )

    save_manifest(output_path, manifest, partial=(status != "success"))

    print("\n" + "=" * 72)
    print("INGEST SUMMARY")
    print("=" * 72)
    print(f"Status: {status}")
    print(f"Total written: {total_written}")
    print(f"Total skipped: {total_skipped}")
    print(f"Total errors captured: {total_errors}")
    print(f"Quarantined skipped: {quarantined_skipped}")
    print(f"Output: {output_path}")
    print(f"End memory: {format_rss()}")

    return 0 if status in {"success", "interrupted", "memory_guard_stopped"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
