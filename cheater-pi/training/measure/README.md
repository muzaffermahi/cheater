# Kitten Ascent — measurement rig (Part D)

Three deliverables, all oracle-grounded (a real test in a clean env, never self-report — so the
benchmark number and the user-value number are the same number):

- **D1 curves** — `pass@1` (raw first try), `pass@k` (any of k solves, the oracle ceiling), `Best@1`
  (the verifier's single pick solves, what we ship). The **Best@1→pass@k gap is the verifier's report
  card**; shrinking it phase over phase is the core progress metric.
- **D2 held-out transfer** — every lift must reproduce on a set the machinery never touched (registered
  in the disjointness firewall so no store/skill/web can reach it). A lift that doesn't transfer is
  leakage; revert it (Law 6).
- **D3 ablation ledger** — each lever's marginal Best@1 on held-out (leave-one-out). Tells you which
  mechanisms are real and which to cut.

## Dry run (no model — proves the aggregation shapes)

```bash
cd cheater-pi && npm run build
node training/measure/dry_run.mjs        # ILLUSTRATIVE synthetic curve + ablation + transfer (committed: dry_run.out)
```

This proves the rig produces the right shapes: a flat `pass@1` (~a 35B's ~24% on hard tasks), a rising
`pass@k`, and `Best@1` tracking `pass@k` with a verifier gap that the ORM closes as k grows. **The
numbers are synthetic — not a capability claim.**

## Real curves (needs a model + oracles — the user's post-session validation)

`tasks.json` — one entry per task:
```json
[{ "taskId": "json_query", "task": "<the natural prompt>",
   "workspaceDir": "/abs/path/to/template",           // copied fresh per run
   "oracleCmd": "python _accept.py" }]                 // exit 0 = solved (behavior, not stdout format)
```

```bash
# Local ornith (LM Studio):
node training/measure/run_curve.mjs --tasks tasks.json --ks 1,4,16 --out samples.jsonl

# Cloud-burst (the SAME weights, parallel — the throughput unlock for large N):
export KITTEN_CLOUD_BASE_URL="https://ws-...maas.aliyuncs.com/compatible-mode/v1"
export KITTEN_CLOUD_API_KEY="sk-..."
node training/measure/run_curve.mjs --tasks tasks.json --ks 1,4,16,50 --cloud

# With the trained ORM ranking (Part B3):
export KITTEN_ORM_CHECKPOINT="$PWD/training/orm/pol-ckpt.json"   # or KITTEN_ORM_MODEL=<served 2B checkpoint>
```

### The three task sets to run (reproduce every number)

1. **local-battery** — `~/Desktop/tbench-run/local-battery` (10 hidden-behavior single-function tasks;
   `_accept.py` per task is the oracle). Fast; the first curve to run.
2. **SWE-bench-Verified subset** — the primary target (80–85 Best@1 from ~73 pass@1). `oracleCmd` = the
   instance's `run_tests`. Pass the full Verified instance-id list to `--swe-manifest` so the disjointness
   firewall registers it (nothing in the store/skills/web may overlap it).
3. **Terminal-Bench 2 subset** — the stretch (target 45–60 from ~24). Drive via the `harbor` rig at
   `~/Desktop/tbench-run`; `oracleCmd` = the task's Docker test suite. Cloud-burst with
   `--model qwen3.6-35b-a3b` (ornith's exact cloud twin).

## Ablation (held-out, leave-one-out)

```bash
node training/measure/run_ablation.mjs --tasks heldout.json --ks 16 [--cloud]
```

`heldout.json` is the **held-out** set (D2) — same schema as `tasks.json`, but these tasks are curated to
be absent from the experience store, the skills, and web-reachable solutions. `run_ablation` registers
them in the firewall, then runs all-on + one-lever-off per lever and prints the marginal-Best@1 ledger.

## What "done" looks like (honest targets — §3 of the plan)

- **SWE-Verified subset ≥ 80 at Best@1** (from ~73 pass@1) — reachable, the headline.
- **TB2 subset materially above ~24** (target 45–60) — the honest 35B ceiling; a chunk of TB2 (MIPS
  interpreter, GPT-2 golf) is beyond a 35B at ANY compute, so we do NOT claim 80–90 on TB2.
- Both **confirmed to transfer on the held-out set**. A gain that only shows on the eval's own repos is
  leakage and gets reverted.
