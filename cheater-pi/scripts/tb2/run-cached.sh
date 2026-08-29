#!/usr/bin/env bash
set -euo pipefail
# Sequential, resumable cached TB2 campaign. No image pull is ever performed by this script.

ROOT="${TB2_ROOT:-/opt/tb2}"
MANIFEST="${TB2_MANIFEST:-$ROOT/tb2-campaign.v1.json}"
RESULTS="${TB2_RESULTS:-$ROOT/results-v1}"
HARBOR="${HARBOR_BIN:-$ROOT/venv/bin/harbor}"
PYTHONPATH="${TB2_PYTHONPATH:-/mnt/c/Users/LENOVO/Desktop/cheater/cheater-pi/scripts/tb2:/mnt/c/Users/LENOVO/Desktop/tbench-run/pi-terminal-bench/src}"
export PYTHONPATH TB2_OFFLINE=1 KITTEN_WEB_ACCESS=off KITTEN_PERSISTENT_MEMORY=off
mkdir -p "$RESULTS"

if [[ ! -f "$MANIFEST" ]]; then echo "missing frozen manifest: $MANIFEST" >&2; exit 2; fi
python3 - "$MANIFEST" <<'PY'
import json, subprocess, sys
m=json.load(open(sys.argv[1]))
if m.get("budgets",{}).get("ceilingSeconds") != 900: raise SystemExit("manifest ceiling is not 900 seconds")
if m.get("budgets",{}).get("maxModalUsd", 0) > 20: raise SystemExit("manifest exceeds $20 cap")
if m.get("budgets",{}).get("maxTransferBytes", 0) > 250*1024*1024: raise SystemExit("manifest exceeds transfer cap")
for t in m["tasks"]:
    p=subprocess.run(["docker","image","inspect",t["image"]],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if p.returncode: raise SystemExit(f"cached image absent; refusing pull: {t['image']}")
PY

have_result() {
  find "$RESULTS/$1" -maxdepth 3 -type f -name result.json -path "*/${2}__*/*" -print -quit 2>/dev/null | grep -q .
}
run_one() {
  local agent="$1" task="$2" cls="$3"
  if have_result "$agent" "$task"; then echo "[resume] $agent/$task"; return; fi
  mkdir -p "$RESULTS/$agent"
  echo "[$(date -Is)] $agent/$task"
  # Harbor can leave a compose container behind when its verifier or a child process ignores the
  # outer timeout. Record pre-existing exact-task containers, then remove only new ones after the
  # trial; this prevents an interrupted run from pinning gigabytes of writable layers.
  local before after id old
  before=$(docker ps -aq --filter "name=^${task}__" 2>/dev/null || true)
  local rc=0
  timeout --foreground --kill-after=30s 900 "$HARBOR" run -d terminal-bench@2.0 --agent-import-path "$cls" -t "$task" -k 1 -n 1 -o "$RESULTS/$agent" --no-force-build || rc=$?
  after=$(docker ps -aq --filter "name=^${task}__" 2>/dev/null || true)
  for id in $after; do
    old=0
    for prior in $before; do [[ "$id" == "$prior" ]] && old=1 && break; done
    [[ "$old" == 1 ]] || docker rm -f "$id" >/dev/null 2>&1 || true
  done
  echo "[$(date -Is)] $agent/$task harbor_rc=$rc"
}

for agent in kitten opencode omp; do
  case "$agent" in
    kitten) cls="pi_terminal_bench:KittenAgent"; export KITTEN_BENCH_PROFILE="full"; ;;
    opencode) cls="pi_terminal_bench:OpencodeAgent"; unset KITTEN_BENCH_PROFILE; ;;
    omp) cls="omp_agent:OmpAgent"; export KITTEN_BENCH_PROFILE="minimal"; ;;
  esac
  mapfile -t order < <(python3 - "$MANIFEST" "$agent" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); print("\n".join(m["executionOrder"][sys.argv[2]]))
PY
)
  for task in "${order[@]}"; do [[ -n "$task" ]] && run_one "$agent" "$task" "$cls"; done
done

if [[ "${TB2_CLEANUP_STALE:-0}" == 1 ]]; then
  # Exact, previously-exported disposable containers only. Never touch images, volumes, or VHDs.
  stale=(cobol-modernization__pbabsmj-main-1 code-from-image__gcdicyp-main-1 adaptive-rejection-sampler__wuucwk7-main-1 bn-fit-modify__bz2tzzu-main-1 sanitize-git-repo__enwjeve-main-1)
  mkdir -p "$ROOT/stale-container-logs"
  for c in "${stale[@]}"; do
    docker inspect "$c" >/dev/null 2>&1 || continue
    docker logs "$c" > "$ROOT/stale-container-logs/$c.log" 2>&1 || true
    docker inspect "$c" --format '{{.State.Status}}' | grep -qx exited || { echo "refusing cleanup of running container $c" >&2; exit 3; }
    docker rm "$c"
  done
fi
