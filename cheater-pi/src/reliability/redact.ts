// Secret redaction: a deterministic scrubber for the few high-confidence secret shapes, applied
// at the surfaces where text leaves the model's own edit path - the sidecar model's input (a
// separate 2-4B must never SEE your keys) and the dev-trace file (a shareable log must never leak
// them). Conservative by design: it targets known token prefixes, PEM private keys, and
// secret-looking KEY=VALUE / "key": "value" assignments, so ordinary code is left alone.
//
// This is a redaction layer, not a vault: it reduces accidental exposure, it is not a guarantee.

interface Rule { re: RegExp; label: string; group?: number }

const RULES: Rule[] = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, label: "private_key" },
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, label: "openai_key" },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, label: "github_token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: "github_pat" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: "slack_token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "aws_access_key" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: "google_api_key" },
  { re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g, label: "bearer_token" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, label: "jwt" },
  // KEY = "value" / KEY: value where the key name is secret-ish and the value is longish. The
  // value (group 2) is redacted; the assignment shape is preserved so the text still reads.
  { re: /((?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)\s*[:=]\s*["']?)([A-Za-z0-9._+/=-]{12,})(["']?)/gi, label: "assigned_secret", group: 2 }
];

/** Replace high-confidence secrets in `text` with [REDACTED:<type>]. Never throws. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (match, ...groups) => {
      if (rule.group) {
        // Keep the surrounding assignment (prefix/suffix), redact only the secret value group.
        const prefix = groups[0] ?? "";
        const suffix = groups[2] ?? "";
        return `${prefix}[REDACTED:${rule.label}]${suffix}`;
      }
      return `[REDACTED:${rule.label}]`;
    });
  }
  return out;
}

/** True when `text` contains something that looks like a secret (post-redaction differs). */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
