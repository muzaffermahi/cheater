// Kitten Core — diagnostic & support bundle. NO Pi.
//
// `kitten support` prints a copy-pastable diagnostic bundle with version info, config sources,
// endpoint status, and recent runs — with all secrets redacted.

import { ConversationStore } from "./store/conversationStore.js";
import { storePath, kittenHome } from "./paths.js";
import { VERSION } from "../config.js";
import { loadKittenSettings } from "./settings.js";
import { KittenLLM } from "./llm.js";
import { loadProvidersConfig } from "./providers.js";

function redactApiKey(s: string): string {
  return s
    .replace(/(sk-[a-zA-Z0-9]{10,})/g, "sk-...redacted")
    .replace(/((?:api[_-]?key|token|secret|password|authorization)=)[^&\s)]+/gi, "$1...redacted");
}

function redactEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return redactApiKey(value);
  }
}

export async function gatherSupportInfo(cwd = process.cwd()): Promise<string> {
  const lines: string[] = [];
  lines.push("=== Kitten Support Bundle ===");
  lines.push(`Version: ${VERSION}`);
  lines.push(`Node: ${process.versions.node}`);
  lines.push(`Platform: ${process.platform} ${process.arch}`);
  lines.push(`Store path: ${storePath()}`);

  const settings = loadKittenSettings(cwd);
  lines.push(`Config sources: ${settings.sources.length ? settings.sources.join(", ") : "defaults + env"}`);
  for (const w of settings.warnings) lines.push(`Config warning: ${w}`);

  // Redacted config
  const providerCfg = loadProvidersConfig();
  lines.push(`Active provider: ${providerCfg.active}`);
  for (const [name, cfg] of Object.entries(providerCfg.providers)) {
    const keyStatus = cfg.apiKeyEnv ? `${cfg.apiKeyEnv}=${process.env[cfg.apiKeyEnv] ? "set" : "unset"}` : "no key env";
    lines.push(`  ${name}: ${redactEndpoint(cfg.baseUrl)} (${keyStatus})`);
  }

  lines.push(`Main model: ${settings.models.main}`);
  lines.push(`Sidecar model: ${settings.models.sidecar || "none"}`);

  const llm = new KittenLLM(settings.models);
  lines.push(`Endpoint: ${redactEndpoint(settings.models.baseUrl)}`);
  const engine = await llm.detectEngine().catch(() => "unknown");
  lines.push(`Engine: ${engine}`);

  // Recent runs
  try {
    const store = ConversationStore.open(storePath());
    const convs = store.listConversations({ limit: 10 });
    lines.push(`\nRecent runs (last ${Math.min(10, convs.length)} conversations):`);
    for (const c of convs) {
      const runs = store.listRuns(c.id);
      const last = runs[runs.length - 1];
      if (last) {
        lines.push(`  ${last.id.slice(0, 12)} | model: ${last.model || "?"} | lane: ${last.lane || "?"} | ${last.status} | ${(last.endedAt && last.startedAt ? ((last.endedAt - last.startedAt) / 1000).toFixed(1) + "s" : "?")}`);
      }
    }
    store.close();
  } catch { lines.push("store: unavailable"); }

  lines.push("\n=== End Support Bundle ===");
  return redactApiKey(lines.join("\n"));
}
