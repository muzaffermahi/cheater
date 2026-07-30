// Kitten Core — provider registry. NO Pi.
//
// Manages multiple model providers (local, llamacpp, alibaba, etc.) with env-backed secrets.
// A provider is a named endpoint + optional apiKey (from env, never stored in plaintext).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProviderConfig {
  baseUrl: string;
  apiKeyEnv?: string;
}

export interface ProvidersConfig {
  active: string;
  providers: Record<string, ProviderConfig>;
}

const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
  local: { baseUrl: "http://localhost:1234/v1" },
  llamacpp: { baseUrl: "http://localhost:8080/v1" },
};

export function loadProvidersConfig(): ProvidersConfig {
  const configPath = join(homedir(), ".kitten", "config.json");
  let providers: Record<string, ProviderConfig> = { ...DEFAULT_PROVIDERS };
  let active = "local";

  if (existsSync(configPath)) {
    try {
      const data = JSON.parse(readFileSync(configPath, "utf8"));
      if (data.providers) providers = { ...providers, ...data.providers };
      if (data.provider) active = data.provider;
    } catch { /* best-effort */ }
  }

  return { active, providers };
}

export function getProviderBaseUrl(providerName: string): string {
  const config = loadProvidersConfig();
  return config.providers[providerName]?.baseUrl ?? config.providers.local.baseUrl;
}

export function getProviderApiKey(providerName: string): string | undefined {
  const config = loadProvidersConfig();
  const envName = config.providers[providerName]?.apiKeyEnv;
  if (envName) return process.env[envName] || undefined;
  return process.env.KITTEN_API_KEY || undefined;
}

export function resolveProviderUrlAndKey(providerName: string | null): { baseUrl: string; apiKey: string | undefined } {
  if (!providerName) return { baseUrl: process.env.KITTEN_BASE_URL || "http://localhost:1234/v1", apiKey: process.env.KITTEN_API_KEY || undefined };
  const config = loadProvidersConfig();
  const prov = config.providers[providerName];
  if (!prov) return { baseUrl: "http://localhost:1234/v1", apiKey: undefined };
  const apiKey = prov.apiKeyEnv ? process.env[prov.apiKeyEnv] || undefined : process.env.KITTEN_API_KEY || undefined;
  return { baseUrl: prov.baseUrl, apiKey };
}

export function listProviders(): string[] {
  return Object.keys(loadProvidersConfig().providers);
}

export function getActiveProvider(): string {
  return loadProvidersConfig().active;
}
