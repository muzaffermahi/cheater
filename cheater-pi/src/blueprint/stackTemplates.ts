// Optional per-stack ACCELERATOR for from-scratch builds (Phase A: cut boilerplate decode).
//
// Cheater's scaffold engine (blueprint/scaffold.ts) is deliberately stack-agnostic - the MODEL
// proposes the file list and authors every file. That is correct for coverage, but it makes the
// local 35B decode ~260s of pure BOILERPLATE on every Vite+React+TS build (build config, the
// standard entry, a Tailwind index.css, a localStorage hook) that needs zero model intelligence.
//
// This module recognizes a KNOWN stack from the goal + the model's OWN proposed file list and,
// when both agree, stamps that stack's INVARIANT files to disk deterministically (the harness
// writes them; the 35B never decodes them). It is purely additive: an unrecognized stack yields
// null and the from-scratch path runs exactly as before. scaffold.ts never imports this module,
// so its stack-agnostic contract is preserved.
//
// Safety doctrine: templates are advisory PRE-FILLS, not the gate. A scaffold phase is satisfied
// by a file's presence on disk (kernel.ts), and the final `npm run build` is the only real gate,
// so a stamped file that drifts from the model's structure is caught there - degrading to "the
// model writes it", never worse. Every stamped file is a real human-authored template, never
// model-generated (that is Phase B, gated separately).

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface TemplateCtx {
  /** npm-safe package name derived from the goal. */
  appName: string;
  usesTailwind: boolean;
  /** The default-exported root component the entry mounts. Convention: "./App". */
  entryComponent: string;
}

/** One invariant file a stack profile can stamp. `render` is pure; `exportsSummary` is shown to
 *  the model so it imports the real shape instead of recreating the file. `group` gates stamping. */
export interface TemplateFile {
  path: string;
  render: (ctx: TemplateCtx) => string;
  /** One-line contract shown in the "files that already exist" note (empty = not app-imported). */
  exportsSummary: string;
  //  structural: always stamped.  styling: only when usesTailwind.  entry: only when the model's
  //  entry matches the convention (it did not pick its own index.tsx).  optional: only when the
  //  model actually planned a file of that basename.
  group: "structural" | "styling" | "entry" | "optional";
}

export interface StackProfile {
  id: string;
  label: string;
  detect: (goal: string, plannedPaths: string[]) => boolean;
  invariantFiles: TemplateFile[];
}

export interface StampedFile { path: string; exportsSummary: string; }

// ---- vite-react-ts templates ---------------------------------------------------------------

const pkgJson = (ctx: TemplateCtx): string => {
  const dependencies: Record<string, string> = { react: "^18.3.1", "react-dom": "^18.3.1" };
  const devDependencies: Record<string, string> = {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    typescript: "^5.6.3",
    vite: "^5.4.11",
    vitest: "^2.1.8",
    jsdom: "^25.0.1"
  };
  if (ctx.usesTailwind) {
    devDependencies.tailwindcss = "^3.4.15";
    devDependencies.postcss = "^8.4.49";
    devDependencies.autoprefixer = "^10.4.20";
  }
  return JSON.stringify({
    name: ctx.appName,
    private: true,
    version: "0.1.0",
    type: "module",
    scripts: { dev: "vite", build: "tsc && vite build", preview: "vite preview", test: "vitest run" },
    dependencies,
    devDependencies
  }, null, 2) + "\n";
};

const viteConfig = (): string => `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { port: 3000 },
  build: { outDir: "dist", sourcemap: false }
});
`;

// Lenient-but-strict on purpose: \`strict\` catches real type bugs, but noUnusedLocals/Parameters are
// deliberately OFF - a stricter tsconfig than the model would have written only ADDS build-fix cycles
// on otherwise-fine generated code, which would make this a net loss.
const tsconfig = (): string => JSON.stringify({
  compilerOptions: {
    target: "ES2020",
    useDefineForClassFields: true,
    lib: ["ES2020", "DOM", "DOM.Iterable"],
    module: "ESNext",
    skipLibCheck: true,
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    isolatedModules: true,
    noEmit: true,
    jsx: "react-jsx",
    strict: true
  },
  include: ["src"],
  references: [{ path: "./tsconfig.node.json" }]
}, null, 2) + "\n";

const tsconfigNode = (): string => JSON.stringify({
  compilerOptions: {
    composite: true,
    skipLibCheck: true,
    module: "ESNext",
    moduleResolution: "bundler",
    allowSyntheticDefaultImports: true,
    strict: true
  },
  include: ["vite.config.ts"]
}, null, 2) + "\n";

const postcssConfig = (): string => `export default {
  plugins: { tailwindcss: {}, autoprefixer: {} }
};
`;

const tailwindConfig = (): string => `/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: []
};
`;

const indexHtml = (ctx: TemplateCtx): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${ctx.appName}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const viteEnv = (): string => `/// <reference types="vite/client" />\n`;

const mainTsx = (ctx: TemplateCtx): string => `import React from "react";
import { createRoot } from "react-dom/client";
import App from "${ctx.entryComponent}";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;

const indexCss = (ctx: TemplateCtx): string => ctx.usesTailwind
  ? `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n/* Add your own component classes below. */\n`
  : `:root { color-scheme: light dark; }\n*, *::before, *::after { box-sizing: border-box; }\nbody { margin: 0; font-family: system-ui, -apple-system, sans-serif; }\n`;

const useLocalStorageHook = (): string => `import { useEffect, useState } from "react";

// Persist a JSON-serializable value in localStorage. Guards \`window\` so it is preview/SSR-safe.
export function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T) => void] {
  const [stored, setStored] = useState<T>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
      return raw ? (JSON.parse(raw) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(stored));
    } catch {
      // ignore quota / serialization failures
    }
  }, [key, stored]);
  return [stored, setStored];
}
`;

export const VITE_REACT_TS: StackProfile = {
  id: "vite-react-ts",
  label: "Vite + React + TypeScript",
  detect: (goal, plannedPaths) => {
    const g = (goal ?? "").toLowerCase();
    const goalOk = /\bvite\b/.test(g) && /\breact\b/.test(g) && /\btypescript\b|\btsx?\b/.test(g);
    const paths = (plannedPaths ?? []).map((p) => p.toLowerCase());
    // The model's OWN file list is the authoritative signal: it decided to build a Vite React TS app.
    const filesOk = paths.some((p) => basename(p) === "package.json")
      && paths.some((p) => /(^|\/)vite\.config\.[jt]s$/.test(p))
      && paths.some((p) => p.endsWith(".tsx"));
    return goalOk && filesOk;
  },
  invariantFiles: [
    { path: "package.json", render: pkgJson, group: "structural", exportsSummary: "manifest - react, react-dom + vite/typescript/vitest devDeps are already declared; run `npm install` ONCE and do NOT install vitest/jsdom separately" },
    { path: "vite.config.ts", render: viteConfig, group: "structural", exportsSummary: "" },
    { path: "tsconfig.json", render: tsconfig, group: "structural", exportsSummary: "" },
    { path: "tsconfig.node.json", render: tsconfigNode, group: "structural", exportsSummary: "" },
    { path: "src/vite-env.d.ts", render: viteEnv, group: "structural", exportsSummary: "" },
    { path: "postcss.config.js", render: postcssConfig, group: "styling", exportsSummary: "" },
    { path: "tailwind.config.js", render: tailwindConfig, group: "styling", exportsSummary: "" },
    { path: "index.html", render: indexHtml, group: "entry", exportsSummary: "" },
    { path: "src/main.tsx", render: mainTsx, group: "entry", exportsSummary: "app entry - mounts <App/> from \"./App\" into #root; create src/App.tsx with a DEFAULT export" },
    { path: "src/index.css", render: indexCss, group: "entry", exportsSummary: "global stylesheet, imported by main.tsx - add your own classes here; do not recreate it" },
    { path: "src/hooks/useLocalStorage.ts", render: useLocalStorageHook, group: "optional", exportsSummary: "exports useLocalStorage<T>(key, initialValue): [T, (value: T) => void]" }
  ]
};

export const STACK_PROFILES: StackProfile[] = [VITE_REACT_TS];

/** The recognized stack for this goal+file-list, or null (an unrecognized stack stamps nothing and
 *  the model-authored path is unchanged). `allowedStacks` (config) restricts eligible profiles. */
export function detectStackProfile(goal: string, plannedPaths: string[], allowedStacks?: string[]): StackProfile | null {
  const pool = allowedStacks?.length ? STACK_PROFILES.filter((profile) => allowedStacks.includes(profile.id)) : STACK_PROFILES;
  return pool.find((profile) => {
    try { return profile.detect(goal, plannedPaths); } catch { return false; }
  }) ?? null;
}

/** An npm-safe kebab package name from the goal (`... called FounderOS` -> `founder-os`); "app" otherwise. */
export function deriveAppName(goal: string): string {
  const named = /\b(?:called|named)\s+([A-Za-z][\w-]{1,40})/i.exec(goal ?? "");
  const raw = named?.[1] ?? "app";
  const kebab = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab || "app";
}

function resolveTarget(templatePath: string, plannedPaths: string[]): string {
  // Stamp at the model's OWN planned path when it planned this basename (respect its structure);
  // otherwise the template's canonical path.
  const b = basename(templatePath).toLowerCase();
  const match = plannedPaths.find((p) => basename(p).toLowerCase() === b);
  return match ?? templatePath;
}

/**
 * Stamp a profile's invariant files to disk, honoring the model's structural choices. Returns the
 * files actually written (with their export contracts) for the "already exists" note. Best-effort:
 * a single file that fails to write is skipped (the model writes it), never aborting the rest.
 */
export function stampProfile(cwd: string, profile: StackProfile, ctx: TemplateCtx, plannedPaths: string[]): StampedFile[] {
  const planned = plannedPaths ?? [];
  const plannedBase = new Set(planned.map((p) => basename(p).toLowerCase()));
  // Entry files (index.html + main.tsx + index.css are a coupled set: index.html points at main.tsx
  // which imports ./index.css). Only stamp them when the model did NOT choose its own entry name.
  const entryOk = plannedBase.has("main.tsx") || !plannedBase.has("index.tsx");
  const stamped: StampedFile[] = [];
  for (const file of profile.invariantFiles) {
    if (file.group === "styling" && !ctx.usesTailwind) continue;
    if (file.group === "entry" && !entryOk) continue;
    if (file.group === "optional" && !plannedBase.has(basename(file.path).toLowerCase())) continue;
    const target = resolveTarget(file.path, planned);
    try {
      const abs = join(cwd, target);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.render(ctx), "utf8");
      stamped.push({ path: target, exportsSummary: file.exportsSummary });
    } catch {
      // skip this file; the model will author it (net-neutral)
    }
  }
  return stamped;
}
