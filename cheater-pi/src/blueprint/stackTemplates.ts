// Optional per-stack ACCELERATOR for from-scratch builds (Phase A: cut boilerplate decode).
//
// Cheater's scaffold engine (blueprint/scaffold.ts) is deliberately stack-agnostic - the MODEL
// proposes the file list and authors every file. That is correct for coverage, but it makes the
// local 35B decode a lot of pure BOILERPLATE on every build (build config, the standard entry, a
// Tailwind index.css, a localStorage hook) that needs zero model intelligence.
//
// This module keeps a REGISTRY of stack profiles (the "menu") and picks one by matching the model's
// OWN proposed file list to a profile's signature - `vite.config.js`+`App.jsx` -> React+Vite (JS),
// `requirements.txt`+`app.py` -> Flask, etc. The model is never shown a boxy menu and never forced
// to pick a label; its natural file plan IS its choice. When a profile matches, the harness stamps
// that stack's INVARIANT files to disk so the model never decodes them. Purely additive: no match
// (any unrecognized stack) stamps nothing and the model-authored path is byte-identical.
//
// Anti-cage doctrine: stamped files are a STARTING POINT, not a template the model must obey. It may
// edit, extend, or replace any of them (read-before-write is satisfied because each is recorded as a
// run mutation). The final `npm run build` is the only real gate, so a stamped file that drifts is
// caught there - degrading to "the model writes it", never worse. scaffold.ts never imports this
// module, so its stack-agnostic contract is preserved. Adding stack N+1 is just appending a profile.

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
  //  entry matches the convention (it did not pick its own index.{tsx,jsx}).  optional: only when
  //  the model actually planned a file of that basename.
  group: "structural" | "styling" | "entry" | "optional";
}

export interface StackProfile {
  id: string;
  label: string;
  /** True when the model's OWN proposed file list matches this stack (language + framework). This is
   *  how the model "chooses" a stack - by what it planned - without ever seeing a menu. */
  detect: (plannedPaths: string[]) => boolean;
  invariantFiles: TemplateFile[];
}

export interface StampedFile { path: string; exportsSummary: string; }

// ---- shared renders (identical across JS/TS React) -----------------------------------------

const viteConfig = (): string => `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { port: 3000 },
  build: { outDir: "dist", sourcemap: false }
});
`;

const postcssConfig = (): string => `export default {
  plugins: { tailwindcss: {}, autoprefixer: {} }
};
`;

const tailwindConfig = (): string => `/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: { extend: {} },
  plugins: []
};
`;

const indexCss = (ctx: TemplateCtx): string => ctx.usesTailwind
  ? `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n/* Add your own component classes below. */\n`
  : `:root { color-scheme: light dark; }\n*, *::before, *::after { box-sizing: border-box; }\nbody { margin: 0; font-family: system-ui, -apple-system, sans-serif; }\n`;

const renderIndexHtml = (appName: string, entryPath: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${appName}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${entryPath}"></script>
  </body>
</html>
`;

const reactDeps = (usesTailwind: boolean, extraDev: Record<string, string>): { dependencies: Record<string, string>; devDependencies: Record<string, string> } => {
  const dependencies = { react: "^18.3.1", "react-dom": "^18.3.1" };
  const devDependencies: Record<string, string> = {
    "@vitejs/plugin-react": "^4.3.4",
    vite: "^5.4.11",
    vitest: "^2.1.8",
    jsdom: "^25.0.1",
    ...extraDev
  };
  if (usesTailwind) { devDependencies.tailwindcss = "^3.4.15"; devDependencies.postcss = "^8.4.49"; devDependencies.autoprefixer = "^10.4.20"; }
  return { dependencies, devDependencies };
};

// ---- vite-react-ts templates ---------------------------------------------------------------

const pkgJsonTs = (ctx: TemplateCtx): string => {
  const { dependencies, devDependencies } = reactDeps(ctx.usesTailwind, {
    "@types/react": "^18.3.12", "@types/react-dom": "^18.3.1", typescript: "^5.6.3"
  });
  return JSON.stringify({
    name: ctx.appName, private: true, version: "0.1.0", type: "module",
    scripts: { dev: "vite", build: "tsc && vite build", preview: "vite preview", test: "vitest run" },
    dependencies, devDependencies
  }, null, 2) + "\n";
};

// Lenient-but-strict on purpose: `strict` catches real bugs, but noUnusedLocals/Parameters are OFF -
// a stricter tsconfig than the model would have written only ADDS build-fix cycles on otherwise-fine
// generated code, which would make this a net loss.
const tsconfig = (): string => JSON.stringify({
  compilerOptions: {
    target: "ES2020", useDefineForClassFields: true, lib: ["ES2020", "DOM", "DOM.Iterable"],
    module: "ESNext", skipLibCheck: true, moduleResolution: "bundler", allowImportingTsExtensions: true,
    resolveJsonModule: true, isolatedModules: true, noEmit: true, jsx: "react-jsx", strict: true
  },
  include: ["src"], references: [{ path: "./tsconfig.node.json" }]
}, null, 2) + "\n";

const tsconfigNode = (): string => JSON.stringify({
  compilerOptions: { composite: true, skipLibCheck: true, module: "ESNext", moduleResolution: "bundler", allowSyntheticDefaultImports: true, strict: true },
  include: ["vite.config.ts"]
}, null, 2) + "\n";

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

const useLocalStorageTs = (): string => `import { useEffect, useState } from "react";

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
    try { window.localStorage.setItem(key, JSON.stringify(stored)); } catch { /* ignore quota */ }
  }, [key, stored]);
  return [stored, setStored];
}
`;

// ---- vite-react-js templates (no TypeScript: no tsconfig, `vite build` only) ----------------

const pkgJsonJs = (ctx: TemplateCtx): string => {
  const { dependencies, devDependencies } = reactDeps(ctx.usesTailwind, {});
  return JSON.stringify({
    name: ctx.appName, private: true, version: "0.1.0", type: "module",
    scripts: { dev: "vite", build: "vite build", preview: "vite preview", test: "vitest run" },
    dependencies, devDependencies
  }, null, 2) + "\n";
};

const mainJsx = (ctx: TemplateCtx): string => `import React from "react";
import { createRoot } from "react-dom/client";
import App from "${ctx.entryComponent}";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;

const useLocalStorageJs = (): string => `import { useEffect, useState } from "react";

// Persist a JSON-serializable value in localStorage. Guards \`window\` so it is preview-safe.
export function useLocalStorage(key, initialValue) {
  const [stored, setStored] = useState(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
      return raw ? JSON.parse(raw) : initialValue;
    } catch {
      return initialValue;
    }
  });
  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify(stored)); } catch { /* ignore quota */ }
  }, [key, stored]);
  return [stored, setStored];
}
`;

// ---- signature helpers ---------------------------------------------------------------------

const has = (paths: string[], name: string): boolean => paths.some((p) => basename(p).toLowerCase() === name);
const hasExt = (paths: string[], ext: string): boolean => paths.some((p) => p.toLowerCase().endsWith(ext));
const hasVite = (paths: string[]): boolean => paths.some((p) => /(^|\/)vite\.config\.[jt]s$/i.test(p.replace(/\\/g, "/")));

// ---- the registry (the "menu"; add profiles to grow it) ------------------------------------

export const VITE_REACT_TS: StackProfile = {
  id: "vite-react-ts",
  label: "React + Vite (TypeScript)",
  // The model chose TS by planning .tsx files alongside a Vite manifest.
  detect: (paths) => has(paths, "package.json") && hasVite(paths) && hasExt(paths, ".tsx"),
  invariantFiles: [
    { path: "package.json", render: pkgJsonTs, group: "structural", exportsSummary: "manifest - react, react-dom + vite/typescript/vitest devDeps are already declared; run `npm install` ONCE and do NOT install vitest/jsdom separately" },
    { path: "vite.config.ts", render: viteConfig, group: "structural", exportsSummary: "" },
    { path: "tsconfig.json", render: tsconfig, group: "structural", exportsSummary: "" },
    { path: "tsconfig.node.json", render: tsconfigNode, group: "structural", exportsSummary: "" },
    { path: "src/vite-env.d.ts", render: viteEnv, group: "structural", exportsSummary: "" },
    { path: "postcss.config.js", render: postcssConfig, group: "styling", exportsSummary: "" },
    { path: "tailwind.config.js", render: tailwindConfig, group: "styling", exportsSummary: "" },
    { path: "index.html", render: (ctx) => renderIndexHtml(ctx.appName, "/src/main.tsx"), group: "entry", exportsSummary: "" },
    { path: "src/main.tsx", render: mainTsx, group: "entry", exportsSummary: "app entry - mounts <App/> from \"./App\" into #root; create src/App.tsx with a DEFAULT export" },
    { path: "src/index.css", render: indexCss, group: "entry", exportsSummary: "global stylesheet, imported by the entry - add your own classes here; do not recreate it" },
    { path: "src/hooks/useLocalStorage.ts", render: useLocalStorageTs, group: "optional", exportsSummary: "exports useLocalStorage<T>(key, initialValue): [T, (value: T) => void]" }
  ]
};

export const VITE_REACT_JS: StackProfile = {
  id: "vite-react-js",
  label: "React + Vite (JavaScript)",
  // The model chose JS by planning .jsx (or a JS Vite config) with NO .tsx anywhere.
  detect: (paths) => has(paths, "package.json") && hasVite(paths) && !hasExt(paths, ".tsx") && (hasExt(paths, ".jsx") || paths.some((p) => /(^|\/)vite\.config\.js$/i.test(p.replace(/\\/g, "/")))),
  invariantFiles: [
    { path: "package.json", render: pkgJsonJs, group: "structural", exportsSummary: "manifest - react, react-dom + vite/vitest devDeps are already declared; run `npm install` ONCE and do NOT install vitest/jsdom separately" },
    { path: "vite.config.js", render: viteConfig, group: "structural", exportsSummary: "" },
    { path: "postcss.config.js", render: postcssConfig, group: "styling", exportsSummary: "" },
    { path: "tailwind.config.js", render: tailwindConfig, group: "styling", exportsSummary: "" },
    { path: "index.html", render: (ctx) => renderIndexHtml(ctx.appName, "/src/main.jsx"), group: "entry", exportsSummary: "" },
    { path: "src/main.jsx", render: mainJsx, group: "entry", exportsSummary: "app entry - mounts <App/> from \"./App\" into #root; create src/App.jsx with a DEFAULT export" },
    { path: "src/index.css", render: indexCss, group: "entry", exportsSummary: "global stylesheet, imported by the entry - add your own classes here; do not recreate it" },
    { path: "src/hooks/useLocalStorage.js", render: useLocalStorageJs, group: "optional", exportsSummary: "exports useLocalStorage(key, initialValue): [value, setValue]" }
  ]
};

// Order matters: more-specific (TS, keyed on .tsx) before JS, so a TS plan never falls through to JS.
export const STACK_PROFILES: StackProfile[] = [VITE_REACT_TS, VITE_REACT_JS];

/** The stack the model's OWN proposed file list matches, or null (an unrecognized stack stamps
 *  nothing and the model-authored path is unchanged). `allowedStacks` (config) restricts the menu. */
export function detectStackProfile(plannedPaths: string[], allowedStacks?: string[]): StackProfile | null {
  const pool = allowedStacks?.length ? STACK_PROFILES.filter((profile) => allowedStacks.includes(profile.id)) : STACK_PROFILES;
  return pool.find((profile) => {
    try { return profile.detect(plannedPaths ?? []); } catch { return false; }
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
  // Entry files (index.html + main.* + index.css are a coupled set: index.html points at the entry
  // which imports ./index.css). Only stamp them when the model did NOT choose its own entry name.
  const hasMainPlanned = plannedBase.has("main.tsx") || plannedBase.has("main.jsx");
  const hasOwnIndexEntry = plannedBase.has("index.tsx") || plannedBase.has("index.jsx");
  // The entry set (index.html + main.* + index.css) is stamped with hardcoded CANONICAL cross-links
  // (index.html → /src/main.*, main.* → ./index.css). If the model relocated any coupled file off its
  // canonical path (a flat layout, or public/index.html), those links dangle and `vite build` fails on
  // internally-inconsistent bytes the harness itself wrote. In that case skip stamping the entry group and
  // let the model author the coupled files coherently.
  const coupled = new Map(profile.invariantFiles
    .filter((f) => ["index.html", "main.tsx", "main.jsx", "index.css"].includes(basename(f.path).toLowerCase()))
    .map((f) => [basename(f.path).toLowerCase(), f.path]));
  const entryLayoutCanonical = planned.every((p) => {
    const canon = coupled.get(basename(p).toLowerCase());
    return !canon || p.replace(/\\/g, "/") === canon;
  });
  const entryOk = (hasMainPlanned || !hasOwnIndexEntry) && entryLayoutCanonical;
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
