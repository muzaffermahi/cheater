#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const source = resolve(arg("--source") ?? "dist");
const destination = resolve(arg("--destination") ?? "../desktop/bin/Release/net8.0-windows/win-x64/engine/dist");
if (!existsSync(source)) throw new Error(`Kitten engine source is missing: ${source}`);
rmSync(destination, { recursive: true, force: true });
mkdirSync(dirname(destination), { recursive: true });
cpSync(source, destination, { recursive: true, force: true });
console.log(`Synced Kitten engine: ${source} -> ${destination}`);
