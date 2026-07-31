// Assemble a native Kitten desktop payload after the Avalonia publish step.
// This script never opens a browser and refuses to silently ship an engine without its dependencies.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const publish = resolve(arg("--publish", "../artifacts/kitten-desktop"));
const output = resolve(arg("--out", "../artifacts/kitten-desktop-bundle"));
const nodeExe = arg("--node", process.env.KITTEN_NODE_EXE);
const engineDist = resolve("dist");
if (!existsSync(publish)) throw new Error(`desktop publish directory does not exist: ${publish}`);
if (!existsSync(engineDist)) throw new Error("build the TypeScript engine first (dist is missing)");
if (!nodeExe || !existsSync(nodeExe)) throw new Error("provide --node <bundled node.exe>; shipping an app without a private runtime is unsafe");

mkdirSync(output, { recursive: true });
cpSync(publish, output, { recursive: true, force: true });
const engine = join(output, "engine");
mkdirSync(engine, { recursive: true });
// The desktop app only needs the standalone Kitten engine. Keep the legacy Pi launcher, extension,
// providers, sidecar UI, and browser assets out of the native payload even though TypeScript still
// compiles them for maintainer-facing compatibility tests.
const productionEngineEntries = [
  "src/core",
  "src/config.js", "src/config.d.ts",
  "src/autopilot/classifier.js", "src/autopilot/classifier.d.ts",
  "src/autopilot/types.js", "src/autopilot/types.d.ts",
  "src/blueprint/config.js", "src/blueprint/config.d.ts",
  "src/commitlet/config.js", "src/commitlet/config.d.ts",
  "src/reliability", "src/runstate", "src/runtime", "src/ui",
  "src/types.js", "src/types.d.ts",
];
const engineOut = join(engine, "dist");
mkdirSync(engineOut, { recursive: true });
for (const entry of productionEngineEntries) {
  const source = join(engineDist, entry);
  if (!existsSync(source)) throw new Error(`production engine entry is missing: ${source}`);
  cpSync(source, join(engineOut, entry), { recursive: true, force: true });
}
// `core/` is shared with the maintainer CLI, so remove its optional terminal/browser entry points
// from the native payload after copying the common engine closure.
for (const forbidden of [
  "src/core/kitten.js", "src/core/kitten.d.ts", "src/core/tui.js", "src/core/tui.d.ts",
  "src/core/repl.js", "src/core/repl.d.ts", "src/core/web.js", "src/core/web.d.ts",
  "src/core/web", "src/core/serve.js", "src/core/serve.d.ts", "src/core/app-launch.js", "src/core/app-launch.d.ts",
  "src/core/mascot.js", "src/core/mascot.d.ts", "src/core/cli.js", "src/core/cli.d.ts",
  "src/core/commands.js", "src/core/commands.d.ts", "src/core/client.js", "src/core/client.d.ts",
  "src/reliability/cli.js", "src/reliability/cli.d.ts",
  "src/reliability/commands.js", "src/reliability/commands.d.ts", "src/ui",
]) rmSync(join(engineOut, forbidden), { recursive: true, force: true });

// Fail closed if a future shared-core change reintroduces a browser, terminal, or TUI surface.
// The native release contract is stronger than deleting today's known entry points: the payload
// must remain app-only even as the maintainer-facing compatibility tree evolves.
function collectFiles(directory, relative = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const next = relative ? join(relative, entry.name) : entry.name;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(absolute, next));
    else files.push(next.replaceAll("\\", "/"));
  }
  return files;
}
const forbiddenSurface = /(?:^|\/)\b(?:tui|repl|terminal|browser|webview|cli|commands)\b|(?:^|\/)web(?:\/|\.|$)|\.html?$/i;
cpSync(nodeExe, join(engine, basename(nodeExe)), { force: true });
const forbiddenPayloadFiles = collectFiles(output).filter((file) => forbiddenSurface.test(file));
if (forbiddenPayloadFiles.length) throw new Error(`native payload contains forbidden UI surface: ${forbiddenPayloadFiles.slice(0, 12).join(", ")}`);

// The native engine is a closed local-IPC application, not a distributable Node package. Keep only
// the actual static import closure of the desktop entrypoint; copying the whole maintainer tree would
// silently reintroduce unused CLI, browser, TUI, and experimental surfaces into the shipped payload.
const engineSourceRoot = join(engineOut, "src");
const desktopEntry = join(engineSourceRoot, "core", "desktopEngine.js");
if (!existsSync(desktopEntry)) throw new Error(`native desktop entry is missing: ${desktopEntry}`);
const reachable = new Set();
function resolveLocalImport(from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const candidate = resolve(dirname(from), specifier);
  const withExtension = candidate.endsWith(".js") ? candidate : `${candidate}.js`;
  return existsSync(withExtension) ? withExtension : null;
}
function visitModule(file) {
  if (reachable.has(file)) return;
  reachable.add(file);
  const source = readFileSync(file, "utf8");
  const imports = /(?:from|import)\s*["'](\.[^"']+)["']/g;
  for (const match of source.matchAll(imports)) {
    const dependency = resolveLocalImport(file, match[1]);
    if (!dependency) throw new Error(`native engine has an unresolved local import: ${file} -> ${match[1]}`);
    visitModule(dependency);
  }
}
visitModule(desktopEntry);
for (const file of collectFiles(engineSourceRoot)) {
  const absolute = join(engineSourceRoot, file);
  if (file.endsWith(".d.ts") || (file.endsWith(".js") && !reachable.has(absolute))) rmSync(absolute, { force: true });
}
const remainingReachability = collectFiles(engineSourceRoot);
if (!remainingReachability.includes("core/desktopEngine.js")) throw new Error("native payload closure removed desktopEngine.js");
const forbiddenAfterClosure = collectFiles(output).filter((file) => forbiddenSurface.test(file));
if (forbiddenAfterClosure.length) throw new Error(`native payload contains forbidden path after closure: ${forbiddenAfterClosure.slice(0, 12).join(", ")}`);
const manifest = {
  product: "Kitten",
  protocolVersion: 1,
  engine: "engine/dist/src/core/desktopEngine.js",
  runtime: `engine/${basename(nodeExe)}`,
  nativeOnly: true,
  browserFallback: false,
  noBrowserFallback: true,
};
writeFileSync(join(output, "kitten-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Packaged native Kitten desktop bundle: ${output}`);
