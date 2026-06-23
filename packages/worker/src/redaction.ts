const REDACTED = "[REDACTED]";

const secretPatterns = [
  /sk-ant-api[0-9a-zA-Z_-]*/g,
  /sk-[a-zA-Z0-9_-]{12,}/g,
  /gh[pousr]_[a-zA-Z0-9_]{20,}/g,
  /(?:api[_-]?key|token|secret|password)=([^&\s]+)/gi,
];

import { isRecord } from "@codevil/shared";

export function redactEvent<T>(event: T, exactSecrets: readonly string[]): T {
  return redactValue(event, normalizeSecrets(exactSecrets)) as T;
}

function redactValue(value: unknown, exactSecrets: readonly string[]): unknown {
  if (typeof value === "string") return redactString(value, exactSecrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, exactSecrets));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactValue(nested, exactSecrets)]),
    );
  }
  return value;
}

function redactString(value: string, exactSecrets: readonly string[]): string {
  let redacted = value;
  for (const secret of exactSecrets) {
    redacted = redacted.split(secret).join(REDACTED);
  }

  for (const pattern of secretPatterns) {
    redacted = redacted.replace(pattern, (match, captured: string | undefined) => {
      if (captured) return match.slice(0, match.length - captured.length) + REDACTED;
      return REDACTED;
    });
  }

  return redacted;
}

function normalizeSecrets(secrets: readonly string[]): string[] {
  return secrets.filter((secret) => secret.length >= 6);
}
