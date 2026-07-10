import { existsSync } from "node:fs";

import type { ConsolidationAnnotation, PreviewApp, PreviewFramework } from "@codevil/shared";
import { addCost, zeroCost } from "@codevil/shared";
import type { CommandResult } from "./verification.js";
import type { ConsolidationResult } from "./runtime-types.js";

export { addCost, zeroCost };

export const AGENT_PREVIEW_KEY = "agent";

export function detectLibc(): "gnu" | "musl" | undefined {
  if (process.platform !== "linux") return undefined;
  if (
    existsSync("/lib/x86_64-linux-gnu/libc.so.6") ||
    existsSync("/lib/aarch64-linux-gnu/libc.so.6") ||
    existsSync("/lib64/libc.so.6")
  ) {
    return "gnu";
  }
  if (
    existsSync("/lib/ld-musl-x86_64.so.1") ||
    existsSync("/lib/ld-musl-aarch64.so.1")
  ) {
    return "musl";
  }
  return undefined;
}

export function inferFrameworkFromCommand(command: string): PreviewFramework {
  if (/\bnext\b/i.test(command)) return "next";
  if (/\bvite\b/i.test(command)) return "vite";
  if (/react-scripts/i.test(command)) return "react-scripts";
  if (/manage\.py\s+runserver/i.test(command)) return "django";
  if (/\brails\b/i.test(command)) return "rails";
  if (/^\s*make\b/i.test(command)) return "make";
  if (/^\s*just\b/i.test(command)) return "just";
  return "npm";
}

export function fallbackConsolidation(annotations: ConsolidationAnnotation[]): ConsolidationResult {
  const brief = annotations.map((annotation) => annotation.comment).join("\n\n");
  return {
    brief: brief.length > 0 ? brief : "Refine the plan.",
    cost: zeroCost(),
  };
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "change";
}

export function formatCommandFailure(label: string, command: string, result: CommandResult): string {
  const output = trimOutput(`${result.stdout}${result.stderr}`);
  return output
    ? `${label} command failed (${command}):\n${output}`
    : `${label} command failed (${command}) with exit code ${result.code}`;
}

export function outputLines(chunk: string): string[] {
  return chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(0, 500));
}

export function trimOutput(output: string): string {
  const maxLength = 32 * 1024;
  if (output.length <= maxLength) return output.trim();
  return output.slice(output.length - maxLength).trim();
}

export function resolveAppForStart(apps: PreviewApp[], appKey?: string): PreviewApp | undefined {
  if (appKey) return apps.find((app) => app.key === appKey);
  if (apps.length === 1) return apps[0];
  return apps.find((app) => app.key === AGENT_PREVIEW_KEY);
}
