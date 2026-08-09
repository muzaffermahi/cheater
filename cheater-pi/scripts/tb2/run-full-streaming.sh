#!/usr/bin/env bash
set -euo pipefail

# Resumable full Terminal-Bench 2 Kitten sweep.  Unlike run-cached.sh, this runner is allowed to
# pull a missing task image, but removes only that task's newly-created image after the trial.  The
# cache therefore stays bounded while the complete 89-task suite remains runnable on a nearly-full
# Docker disk.  Existing images are never removed.

ROOT="${TB2_ROOT:-/opt/tb2}"
TASKS="${TB2_TASKS:-$ROOT/tasks.txt}"
RESULTS="${TB2_RESULTS:-$ROOT/results-full-kitten}"
HARBOR="${HARBOR_BIN:-$ROOT/venv/bin/harbor}"
PYTHONPATH="${TB2_PYTHONPATH:-/mnt/c/Users/LENOVO/Desktop/cheater/cheater-pi/scripts/tb2:/mnt/c/Users/LENOVO/Desktop/tbench-run/pi-terminal-bench/src}"
IMAGE_PREFIX="${TB2_IMAGE_PREFIX:-alexgshaw}"
IMAGE_TAG="${TB2_IMAGE_TAG:-20251031}"
LOG="${TB2_FULL_LOG:-$ROOT/full-kitten.log}"
CONTAINER_LOGS="${TB2_CONTAINER_LOGS:-$ROOT/full-kitten-container-logs}"

export PYTHONPATH
# The caller may explicitly allow registry access for a recovery run, but the
# benchmark default is offline: a missing image must fail instead of pulling.
export TB2_OFFLINE="${TB2_OFFLINE:-1}" KITTEN_WEB_ACCESS=off KITTEN_PERSISTENT_MEMORY=off
export TB2_MODEL_HOST="${TB2_MODEL_HOST:-192.168.16.1}"
export TB2_HOST_GATEWAY="${TB2_HOST_GATEWAY:-192.168.16.1}"
export TB2_MAIN_PORT="${TB2_MAIN_PORT:-11435}"
export TB2_MAIN_MODEL="${TB2_MAIN_MODEL:-kat-coder-v2.5-dev-apex-mtp}"
export TB2_CONTEXT_TOKENS="${TB2_CONTEXT_TOKENS:-65536}"
# Keep Kitten's own budget below the Harbor ceiling while leaving enough time for
# long-context KAT runs to finish and flush their durable result.
export TB2_KITTEN_CEILING_MS="${TB2_KITTEN_CEILING_MS:-1680000}"
# Keep the model name explicit for the Kitten process as well as the benchmark
# wrapper.  This is intentionally benchmark-only; product defaults are untouched.
export KITTEN_MAIN_MODEL="${KITTEN_MAIN_MODEL:-$TB2_MAIN_MODEL}"
export KITTEN_BENCH_PROFILE="${KITTEN_BENCH_PROFILE:-full}"
TIMEOUT_SECONDS="${TB2_TIMEOUT_SECONDS:-1800}"
TIMEOUT_MULTIPLIER="${TB2_TIMEOUT_MULTIPLIER:-2}"
KEEP_IMAGES="${TB2_KEEP_IMAGES:-1}"
if ! [[ "$TB2_CONTEXT_TOKENS" =~ ^[0-9]+$ ]] || (( TB2_CONTEXT_TOKENS < 65536 )); then
  echo "TB2_CONTEXT_TOKENS must be an integer >= 65536" >&2
  exit 2
fi

mkdir -p "$RESULTS/kitten" "$CONTAINER_LOGS"

if [[ ! -f "$TASKS" ]]; then
  echo "missing task list: $TASKS" >&2
  exit 2
fi

if [[ "$TB2_OFFLINE" == 1 ]]; then
  missing=()
  while read -r task; do
    [[ -z "$task" ]] && continue
    image="${IMAGE_PREFIX}/${task}:${IMAGE_TAG}"
    docker image inspect "$image" >/dev/null 2>&1 || missing+=("$image")
  done < "$TASKS"
  if (( ${#missing[@]} )); then
    printf 'offline preflight: required cached image(s) absent; refusing to pull:\n' >&2
    printf '  %s\n' "${missing[@]}" >&2
    exit 3
  fi
fi

have_result() {
  find "$RESULTS/kitten" -maxdepth 3 -type f -name result.json -path "*/${1}__*/*" -print -quit 2>/dev/null | grep -q .
}

image_lines() {
  docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' "${IMAGE_PREFIX}/${1}" 2>/dev/null || true
}

cleanup_new_containers() {
  local task="$1" before="$2" after id old status
  after=$(docker ps -aq --filter "name=^${task}__" 2>/dev/null || true)
  for id in $after; do
    old=0
    for prior in $before; do [[ "$id" == "$prior" ]] && old=1 && break; done
    [[ "$old" == 1 ]] && continue
    status=$(docker inspect "$id" --format '{{.State.Status}}' 2>/dev/null || echo unknown)
    if [[ "$status" != running ]]; then
      docker logs "$id" > "$CONTAINER_LOGS/${task}__${id}.log" 2>&1 || true
    fi
    docker rm -f "$id" >/dev/null 2>&1 || true
  done
}

cleanup_task_networks() {
  local task="$1" id containers
  # Harbor creates one random-suffixed network per trial. Containers are already
  # removed above; remove only empty networks whose names belong to this task.
  for id in $(docker network ls -q --filter "name=^${task}__" 2>/dev/null || true); do
    containers=$(docker network inspect "$id" --format '{{json .Containers}}' 2>/dev/null || echo '{}')
    [[ "$containers" == "{}" ]] && docker network rm "$id" >/dev/null 2>&1 || true
  done
}

remove_new_images() {
  local task="$1" before="$2" after ref id old
  after=$(image_lines "$task")
  while read -r ref id; do
    [[ -z "${ref:-}" ]] && continue
    old=0
    while read -r bref bid; do
      [[ "$id" == "$bid" ]] && old=1 && break
    done <<< "$before"
    [[ "$old" == 1 ]] && continue
    # Remove only the exact task image reference introduced by this trial. Shared layers remain.
    docker image rm "$ref" >/dev/null 2>&1 || true
  done <<< "$after"
}

run_one() {
  local task="$1" cls="pi_terminal_bench:KittenAgent" before_images before_containers rc
  if have_result "$task"; then
    echo "[$(date -Is)] resume-skip kitten/$task" | tee -a "$LOG"
    return 0
  fi

  before_images=$(image_lines "$task")
  before_containers=$(docker ps -aq --filter "name=^${task}__" 2>/dev/null || true)
  cleanup_task_networks "$task"
  echo "[$(date -Is)] START kitten/$task image=${IMAGE_PREFIX}/${task}:${IMAGE_TAG}" | tee -a "$LOG"
  rc=0
  timeout --foreground --kill-after=60s "$TIMEOUT_SECONDS" "$HARBOR" run \
    -d terminal-bench@2.0 \
    --agent-import-path "$cls" \
    --timeout-multiplier "$TIMEOUT_MULTIPLIER" \
    -t "$task" -k 1 -n 1 \
    -o "$RESULTS/kitten" \
    $([[ "$KEEP_IMAGES" == 1 ]] && printf '%s' '--no-delete' || printf '%s' '--delete') \
    --no-force-build >> "$LOG" 2>&1 || rc=$?
  cleanup_new_containers "$task" "$before_containers"
  cleanup_task_networks "$task"
  [[ "$KEEP_IMAGES" == 1 ]] || remove_new_images "$task" "$before_images"
  echo "[$(date -Is)] DONE kitten/$task harbor_rc=$rc" | tee -a "$LOG"
}

total=$(wc -l < "$TASKS")
i=0
while read -r task; do
  [[ -z "$task" ]] && continue
  i=$((i + 1))
  echo "[$(date -Is)] PROGRESS $i/$total $task" | tee -a "$LOG"
  run_one "$task"
done < "$TASKS"

echo "[$(date -Is)] FULL KITTEN TB2 COMPLETE $total tasks" | tee -a "$LOG"
