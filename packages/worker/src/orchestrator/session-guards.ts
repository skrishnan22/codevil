export function parseMaxCostUsd(value: string): number | null {
  const match = value.trim().match(/^\$?(\d+(?:\.\d+)?)$/);
  if (!match) return null;

  return Number(match[1]);
}

export function parseMaxTimeMs(value: string): number | null {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1_000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    default:
      return null;
  }
}

export function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug.slice(0, 48) || "task";
}

export function traceIdFromSessionId(sessionId: string): string {
  const hex = sessionId.replace(/^ses_/, "");
  return /^[0-9a-f]{32}$/i.test(hex) ? hex.toLowerCase() : hex.padEnd(32, "0").slice(0, 32);
}
