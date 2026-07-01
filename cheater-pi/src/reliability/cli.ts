import { compareReliabilityBenchmark, latestReliabilityBenchmark, runReliabilityBenchmark, saveReliabilityBenchmark, type ReliabilityVariant } from "./bench.js";
import type { CheaterConfig } from "../types.js";

export interface ReliabilityCliOptions {
  cwd: string;
  config: CheaterConfig;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export function runReliabilityCli(argv: string[], options: ReliabilityCliOptions): number {
  const sub = argv[0] ?? "help";
  if (sub === "run") {
    const variant = parseVariant(argv[1] ?? "B");
    const limit = Number(argv.find((arg) => /^\d+$/.test(arg)) ?? options.config.benchmarkDefaultTaskLimit ?? 10);
    const results = runReliabilityBenchmark({ cwd: options.cwd, variant, limit, config: options.config });
    const file = saveReliabilityBenchmark(options.cwd, results);
    out(options, compareReliabilityBenchmark(results));
    out(options, `saved: ${file}`);
    return 0;
  }
  if (sub === "report") {
    const results = latestReliabilityBenchmark(options.cwd);
    out(options, results.length ? compareReliabilityBenchmark(results) : "no reliability benchmark report found");
    return results.length ? 0 : 1;
  }
  if (sub === "compare") {
    const variants: ReliabilityVariant[] = ["A", "B", "C", "D", "E"];
    const results = variants.flatMap((variant) => runReliabilityBenchmark({ cwd: options.cwd, variant, limit: options.config.benchmarkDefaultTaskLimit, config: options.config }));
    const file = saveReliabilityBenchmark(options.cwd, results);
    out(options, compareReliabilityBenchmark(results));
    out(options, `saved: ${file}`);
    return 0;
  }
  out(options, [
    "Cheater Reliability Benchmark",
    "  cheater bench reliability run [A|B|C|D|E] [limit]",
    "  cheater bench reliability report",
    "  cheater bench reliability compare",
    "Variants: A=baseline, B=fresh-call/loop/stops, C=blueprint+commitlets, D=verification+test audit, E=constraint graph+impact+retrieval gate"
  ].join("\n"));
  return 0;
}

function parseVariant(value: string): ReliabilityVariant {
  return ["A", "B", "C", "D", "E"].includes(value) ? value as ReliabilityVariant : "B";
}

function out(options: ReliabilityCliOptions, text: string): void {
  if (options.stdout) options.stdout(text);
  else console.log(text);
}
