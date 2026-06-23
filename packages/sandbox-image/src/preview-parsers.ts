import { isRecord } from "@codevil/shared";

import type { PreviewCommand } from "./preview-manager.js";

export function parsePreviewCommand(value: unknown): PreviewCommand | undefined {
  if (!isRecord(value)) return undefined;

  const fields = isRecord(value.preview) ? value.preview : value;
  if (typeof fields.command !== "string" || !fields.command.trim()) return undefined;
  if (typeof fields.port !== "number" || !Number.isInteger(fields.port)) return undefined;
  if (fields.port < 1024 || fields.port > 65535 || fields.port === 3000) return undefined;
  if (fields.cwd !== undefined && typeof fields.cwd !== "string") return undefined;
  return {
    cwd: fields.cwd?.trim() || ".",
    command: fields.command.trim(),
    port: fields.port,
  };
}

export function parsePreviewDiscovery(output: string): PreviewCommand | undefined {
  const json = extractJsonObject(output);
  if (!json) return undefined;

  try {
    return parsePreviewCommand(JSON.parse(json));
  } catch {
    return undefined;
  }
}

export function parsePreviewSuggestion(output: string): PreviewCommand | undefined {
  for (const json of extractJsonCandidates(output)) {
    try {
      const command = parsePreviewCommand(JSON.parse(json));
      if (command) return command;
    } catch {
      continue;
    }
  }

  return undefined;
}

function extractJsonObject(output: string): string | undefined {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fenced?.[1] ?? output;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

function extractJsonCandidates(output: string): string[] {
  const candidates: string[] = [];
  for (const match of output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1]);
  }

  const whole = extractJsonObject(output);
  if (whole) candidates.push(whole);
  return candidates;
}
