"""Budgeted Modal proof runner for the frozen SWE-bench Verified slice.

This file is intentionally a remote runner: the local machine uploads only the compressed bundles and
manifest. Dataset checkout, repository clones, tests, trajectories, and official grading stay in Modal.
It is safe to import without Modal installed; the CLI fails with an actionable message instead of
falling back to a local download.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import subprocess
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path

MAX_USD = 20.0
MAX_TRANSFER = 250 * 1024 * 1024
TASK_COUNT = 20
WSL_DISTRO = os.environ.get("TB2_WSL_DISTRO", "Ubuntu-24.04")
WSL_PYTHON = os.environ.get("TB2_WSL_PYTHON", "/home/lenovo/swebench-venv/bin/python")


def _wsl_path(path: Path) -> str:
    """Convert a Windows path to the mounted path visible to Ubuntu WSL."""
    value = str(path)
    if os.name != "nt":
        return value
    drive, tail = os.path.splitdrive(value)
    if not drive:
        return value.replace("\\", "/")
    return f"/mnt/{drive[0].lower()}{tail.replace('\\', '/')}"


def official_evaluator_command(dataset: Path, predictions: Path, run_id: str) -> list[str]:
    """Build the official SWE-bench Modal evaluator command for this host."""
    args = [
        "-m",
        "swebench.harness.run_evaluation",
        "--dataset_name",
        _wsl_path(dataset),
        "--split",
        "test",
        "--predictions_path",
        _wsl_path(predictions),
        "--run_id",
        run_id,
        "--max_workers",
        "1",
        "--modal",
        "true",
    ]
    if os.name == "nt":
        if shutil.which("wsl.exe") is None:
            raise RuntimeError("WSL is required for the official SWE-bench evaluator on Windows")
        return ["wsl.exe", "-d", WSL_DISTRO, "--", WSL_PYTHON, *args]
    return [sys.executable, *args]


def official_evaluator_environment() -> dict[str, str]:
    """Pass host Modal credentials to the WSL evaluator without printing or persisting them."""
    environment = os.environ.copy()
    if os.name != "nt":
        return environment
    candidates = [
        Path(os.environ.get("USERPROFILE", "")) / ".modal" / "credentials.json",
        Path(os.environ.get("APPDATA", "")) / "modal" / "credentials.json",
    ]
    for candidate in candidates:
        try:
            data = json.loads(candidate.read_text(encoding="utf8"))
        except (OSError, json.JSONDecodeError):
            continue
        token_id = data.get("token_id") or data.get("tokenId")
        token_secret = data.get("token_secret") or data.get("tokenSecret")
        if token_id and token_secret:
            environment.update({"MODAL_TOKEN_ID": str(token_id), "MODAL_TOKEN_SECRET": str(token_secret)})
            break
    return environment


@dataclass
class BudgetGuard:
    usd: float = 0.0
    transferred: int = 0

    def charge(self, usd: float, transferred: int = 0) -> None:
        if self.usd + usd > MAX_USD:
            raise RuntimeError("Modal compute cap reached; no further trials scheduled")
        if self.transferred + transferred > MAX_TRANSFER:
            raise RuntimeError("local-transfer cap reached; no further uploads/downloads scheduled")
        self.usd += usd
        self.transferred += transferred


def select_verified_instances(rows: list[dict], revision: str) -> list[dict]:
    """Deterministic selection performed after the dataset is loaded in Modal."""
    ordered = sorted(rows, key=lambda row: hashlib.sha256(f"{revision}:{row['instance_id']}".encode()).hexdigest())
    selected: list[dict] = []
    repos: dict[str, int] = {}
    for row in ordered:
        repo = str(row.get("repo", ""))
        if repos.get(repo, 0) >= 2:
            continue
        # The remote worker runs the official environment setup smoke before admitting a task.
        if not row.get("setup_smoke_passed", False):
            continue
        selected.append(row)
        repos[repo] = repos.get(repo, 0) + 1
        if len(selected) == TASK_COUNT:
            return selected
    raise RuntimeError(f"only {len(selected)} SWE-bench environments passed the frozen smoke filter")


try:
    import modal  # type: ignore
except ImportError:  # pragma: no cover - local validation does not require Modal
    modal = None


if modal is not None:
    app = modal.App("kitten-swebench-proof")
    # Git is needed for the pinned repository clone and setup smoke check.  Install the
    # executable from apt; the PyPI package named ``git`` is not the Git client.
    image = modal.Image.debian_slim(python_version="3.11").apt_install("git").pip_install("datasets", "swebench")

    # The three compressed agent bundles are mounted into the worker image. This keeps the
    # function signature CLI-friendly (Modal's CLI rejects a raw ``bytes`` annotation) while
    # still uploading only the pinned bundles, never repositories or task images.
    payload_dir = Path(os.environ.get("TB2_MODAL_PAYLOAD_DIR", r"C:\Users\LENOVO\Desktop\tbench-run\tb2-bakeoff\payload"))
    bundle_paths = {
        "kitten": payload_dir / "kitten-bundle.tgz",
        "opencode": payload_dir / "opencode-bundle.tgz",
        "omp": payload_dir / "omp-linux-x64.gz",
    }
    for name, local_path in bundle_paths.items():
        if local_path.is_file():
            image = image.add_local_file(local_path, f"/opt/kitten-bundles/{local_path.name}")

    @app.function(image=image, timeout=3600, cpu=2, memory=4096)
    def freeze(revision: str) -> dict:
        from datasets import load_dataset  # type: ignore
        # The revision is pinned by the caller; no floating `main` is accepted.
        if not revision or revision in {"main", "master", "latest"}:
            raise ValueError("SWE-bench dataset revision must be an immutable commit/tag")
        ds = load_dataset("princeton-nlp/SWE-bench_Verified", revision=revision, split="test")
        rows = [dict(row) for row in ds]
        selected = []
        repos: dict[str, int] = {}
        ordered = sorted(rows, key=lambda row: hashlib.sha256(f"{revision}:{row['instance_id']}".encode()).hexdigest())
        for row in ordered:
            repo = str(row.get("repo", ""))
            if not row.get("base_commit") or not repo or repos.get(repo, 0) >= 2:
                continue
            # Setup smoke is remote and read-only: verify the pinned base commit is reachable before
            # freezing the task. No repository is cloned locally.
            url = f"https://github.com/{repo}.git"
            smoke = subprocess.run(["git", "ls-remote", "--exit-code", url, str(row["base_commit"])], capture_output=True, timeout=45, check=False)
            row["setup_smoke_passed"] = smoke.returncode == 0
            if not row["setup_smoke_passed"]:
                continue
            selected.append(row)
            repos[repo] = repos.get(repo, 0) + 1
            if len(selected) == TASK_COUNT:
                break
        if len(selected) != TASK_COUNT:
            raise RuntimeError(f"only {len(selected)} SWE-bench environments passed the frozen smoke filter")
        return {"revision": revision, "instances": selected, "sha256": hashlib.sha256(json.dumps(selected, sort_keys=True).encode()).hexdigest()}

    secret_name = os.environ.get("MODAL_SECRET_NAME")
    secret = modal.Secret.from_name(secret_name) if secret_name else None

    @app.function(image=image, timeout=900, cpu=2, memory=4096, secrets=[secret] if secret else [])
    def trial(instance_json: str, agent: str, model: str) -> dict:
        """Clone one pinned instance, run one adapter, and return only a patch/summary."""
        import http.client
        import http.server
        import socket
        instance = json.loads(instance_json)
        repo = str(instance["repo"])
        base = str(instance["base_commit"])
        problem = str(instance.get("problem_statement", ""))
        with tempfile.TemporaryDirectory(prefix="swebench-") as tmp:
            work = os.path.join(tmp, "repo")
            clone = subprocess.run(["git", "clone", "--quiet", f"https://github.com/{repo}.git", work], capture_output=True, text=True, timeout=180, check=False)
            if clone.returncode:
                return {"instance_id": instance["instance_id"], "agent": agent, "status": "clone_failed", "failureExcerpt": clone.stderr[-4000:]}
            checkout = subprocess.run(["git", "-C", work, "checkout", "--quiet", base], capture_output=True, text=True, timeout=60, check=False)
            if checkout.returncode:
                return {"instance_id": instance["instance_id"], "agent": agent, "status": "checkout_failed", "failureExcerpt": checkout.stderr[-4000:]}
            env = os.environ.copy()
            env.update({"KITTEN_BENCH_PROFILE": "minimal", "KITTEN_WEB_ACCESS": "off", "KITTEN_APPROVAL_POLICY": "auto-allow", "NO_PROXY": "127.0.0.1,localhost"})
            upstream = os.environ.get("MODEL_ENDPOINT", "")
            api_key = os.environ.get("MAAS_API_KEY", "")

            class Proxy(http.server.BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    return

                def _forward(self):
                    length = int(self.headers.get("Content-Length", "0"))
                    body = self.rfile.read(length) if length else None
                    urlparse = __import__("urllib.parse", fromlist=["urlsplit"])
                    base = urlparse.urlsplit(upstream)
                    requested = urlparse.urlsplit(self.path)
                    request = requested.path if requested.path.startswith("/") else "/" + requested.path
                    base_path = base.path.rstrip("/")
                    if base_path.endswith("/v1") and request.startswith("/v1"):
                        request = request[3:]
                    parsed = base._replace(path=base_path + request, query=requested.query)
                    conn = http.client.HTTPSConnection(parsed.hostname, parsed.port, timeout=900) if parsed.scheme == "https" else http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=900)
                    headers = {k: v for k, v in self.headers.items() if k.lower() not in {"authorization", "x-api-key", "host", "content-length"}}
                    headers["Authorization"] = f"Bearer {api_key}"
                    conn.request(self.command, parsed.path + (("?" + parsed.query) if parsed.query else ""), body=body, headers=headers)
                    response = conn.getresponse()
                    self.send_response(response.status)
                    for key, value in response.getheaders():
                        if key.lower() not in {"connection", "transfer-encoding", "content-length"}:
                            self.send_header(key, value)
                    self.end_headers()
                    while True:
                        chunk = response.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    conn.close()

                do_POST = _forward
                do_GET = _forward

            proxy = None
            if upstream and api_key:
                proxy = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
                import threading
                threading.Thread(target=proxy.serve_forever, daemon=True).start()
                endpoint = f"http://127.0.0.1:{proxy.server_address[1]}/v1"
            else:
                endpoint = "http://model-proxy/v1"
            env.update({"KITTEN_BASE_URL": endpoint, "KITTEN_API_KEY": "loopback-only", "OPENAI_API_KEY": "loopback-only", "OPENCODE_API_KEY": "loopback-only"})
            mounted_bundle = {
                "kitten": "/opt/kitten-bundles/kitten-bundle.tgz",
                "opencode": "/opt/kitten-bundles/opencode-bundle.tgz",
                "omp": "/opt/kitten-bundles/omp-linux-x64.gz",
            }.get(agent)
            if not mounted_bundle or not os.path.isfile(mounted_bundle):
                return {"instance_id": instance["instance_id"], "agent": agent, "status": "bundle_missing"}
            agent_bundle = Path(mounted_bundle).read_bytes()
            if agent == "omp":
                binary = os.path.join(tmp, "omp")
                raw = agent_bundle
                if raw[:2] == b"\x1f\x8b":
                    import gzip
                    raw = gzip.decompress(raw)
                Path(binary).write_bytes(raw)
                os.chmod(binary, 0o755)
                home = os.path.join(tmp, "omp-home")
                Path(home).mkdir()
                Path(home, "models.yml").write_text(f"providers:\n  loopback:\n    baseUrl: {endpoint}\n    api: openai-completions\n    auth: none\n    models:\n      - id: {model}\n        name: qwen\n", encoding="utf8")
                env["PI_CODING_AGENT_DIR"] = home
                command = [binary, "-p", "--mode", "text", "--auto-approve", "--no-session", "--max-time", "780", "--no-pty", "--model", f"loopback/{model}", problem]
            else:
                bundle_dir = os.path.join(tmp, agent)
                Path(bundle_dir).mkdir()
                with tarfile.open(fileobj=__import__("io").BytesIO(agent_bundle), mode="r:gz") as archive:
                    archive.extractall(bundle_dir)
                if agent == "kitten":
                    env.update({"KITTEN_BASE_URL": endpoint, "KITTEN_MAIN_MODEL": model, "KITTEN_HOME": os.path.join(tmp, "kitten-home")})
                    command = [os.path.join(bundle_dir, "node", "bin", "node"), os.path.join(bundle_dir, "kitten", "dist", "src", "core", "kitten.js"), "run", problem, "--cwd", work, "--model", model, "--dangerous", "--effort", "balanced"]
                else:
                    config_dir = os.path.join(tmp, "opencode-home", ".config", "opencode")
                    Path(config_dir).mkdir(parents=True)
                    Path(config_dir, "opencode.json").write_text(json.dumps({"provider": {"maas": {"name": "MAAS Cloud", "npm": "@ai-sdk/openai-compatible", "options": {"baseURL": endpoint}, "models": {model: {"name": model}}}}}), encoding="utf8")
                    env["HOME"] = os.path.join(tmp, "opencode-home")
                    command = [os.path.join(bundle_dir, "opencode", "bin", "opencode"), "run", "--dir", work, "--format", "json", "--dangerously-skip-permissions", "-m", f"maas/{model}", problem]
            run = subprocess.run(command, cwd=work, env=env, capture_output=True, text=True, timeout=780, check=False)
            if proxy is not None:
                proxy.shutdown()
            patch = subprocess.run(["git", "-C", work, "diff", "--binary"], capture_output=True, text=True, timeout=30, check=False).stdout
            return {"instance_id": instance["instance_id"], "agent": agent, "model": model, "status": "completed" if run.returncode == 0 else "agent_failed", "returncode": run.returncode, "patch": patch, "summary": run.stdout[-4000:], "failureExcerpt": run.stderr[-4000:]}

    @app.local_entrypoint()
    def campaign(revision: str, model: str = "qwen3.6-35b-a3b", output: str = "modal-swebench-summary.json") -> None:
        """Freeze 20 instances, run the three adapters, then grade remotely.

        Only compact trial records and patches cross back to the workstation. The guard stops before
        the declared transfer/compute ceilings; it never downloads repositories or trajectories.
        """
        missing = [str(path) for path in bundle_paths.values() if not path.is_file()]
        if missing:
            raise RuntimeError(f"missing local compressed agent bundle(s): {', '.join(missing)}")
        frozen = freeze.remote(revision)
        records: list[dict] = []
        guard = BudgetGuard()
        guard.charge(0, sum(path.stat().st_size for path in bundle_paths.values() if path.is_file()))
        for agent in ("kitten", "opencode", "omp"):
            for instance in frozen["instances"]:
                guard.charge(0.25)
                record = trial.remote(json.dumps(instance, sort_keys=True), agent, model)
                encoded = json.dumps(record, ensure_ascii=False).encode("utf8")
                guard.charge(0, len(encoded))
                records.append(record)
        if os.name == "nt":
            probe = subprocess.run(
                ["wsl.exe", "-d", WSL_DISTRO, "--", WSL_PYTHON, "-c", "import swebench"],
                text=True,
                capture_output=True,
                check=False,
            )
            if probe.returncode:
                raise RuntimeError(
                    f"install swebench==4.1.0 in WSL distro {WSL_DISTRO} before running campaign: {probe.stderr.strip()}"
                )
        else:
            try:
                import swebench  # type: ignore  # noqa: F401
            except ImportError as exc:
                raise RuntimeError("install the pinned official SWE-bench package before running campaign") from exc

        # The official evaluator's Modal backend is invoked from the local entrypoint. This
        # keeps Docker/test environments in Modal and avoids an unsupported Docker-in-Docker
        # arrangement inside a nested Modal function. Grade each adapter separately so instance
        # IDs are never duplicated across competitors.
        grades: dict[str, dict] = {}
        with tempfile.TemporaryDirectory(prefix="kitten-swebench-campaign-") as temp:
            dataset_path = Path(temp) / "frozen-instances.json"
            dataset_path.write_text(json.dumps(frozen["instances"], sort_keys=True), encoding="utf8")
            for agent in ("kitten", "opencode", "omp"):
                guard.charge(1.0)
                predictions = [
                    {"instance_id": row["instance_id"], "model_name_or_path": agent, "model_patch": row.get("patch", "")}
                    for row in records
                    if row.get("agent") == agent
                ]
                predictions_path = Path(temp) / f"{agent}-predictions.json"
                predictions_path.write_text(json.dumps(predictions), encoding="utf8")
                run_id = f"kitten-proof-{agent}-{frozen['sha256'][:12]}"
                command = official_evaluator_command(dataset_path, predictions_path, run_id)
                completed = subprocess.run(command, text=True, capture_output=True, check=False, timeout=3600, env=official_evaluator_environment())
                summary = {"revision": revision, "agent": agent, "runId": run_id, "returncode": completed.returncode, "stdout": completed.stdout[-16000:], "stderr": completed.stderr[-16000:]}
                encoded = json.dumps(summary, ensure_ascii=False).encode("utf8")
                guard.charge(0, len(encoded))
                grades[agent] = summary
        Path(output).write_text(json.dumps({"frozen": frozen, "records": records, "grades": grades}, indent=2) + "\n", encoding="utf8")
        print(json.dumps({"output": output, "records": len(records), "grades": list(grades), "budget": guard.__dict__}, indent=2))

    globals().update({"app": app, "freeze": freeze, "trial": trial})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--bundle", action="append", default=[])
    args = parser.parse_args()
    for path in args.bundle:
        if not Path(path).is_file():
            raise SystemExit(f"missing local compressed bundle: {path}")
    # Local side only records upload size; all task selection and repositories remain remote.
    guard = BudgetGuard()
    size = sum(Path(path).stat().st_size for path in args.bundle)
    guard.charge(0, size)
    Path(args.manifest).write_text(json.dumps({"datasetRevision": args.revision, "bundleBytes": size, "maxUsd": MAX_USD, "maxTransferBytes": MAX_TRANSFER}, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"ok": True, "bundleBytes": size, "remoteOnly": True, "caps": {"usd": MAX_USD, "transferBytes": MAX_TRANSFER}}))
    return 0


if __name__ == "__main__":
    main()
