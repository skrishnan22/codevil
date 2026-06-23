import { existsSync } from "node:fs";

import type { CostInfo, ConsolidationAnnotation, PreviewApp, PreviewFramework } from "@codevil/shared";
import type { CommandResult } from "./verification.js";
import type { ConsolidationResult } from "./runtime-types.js";

export const AGENT_PREVIEW_KEY = "agent";

export function credentialRequestFromRepo(repo: string): { protocol: "https"; host: string; path: string } | null {
  try {
    const url = new URL(repo);
    if (url.protocol !== "https:") return null;
    return {
      protocol: "https",
      host: url.hostname,
      path: url.pathname.replace(/^\/+/, ""),
    };
  } catch {
    return null;
  }
}

export function detectLibc(): "gnu" | "musl" | undefined {
  if (process.platform !== "linux") return undefined;
  // glibc: /lib/x86_64-linux-gnu/libc.so.6 on Debian/Ubuntu, /lib64/libc.so.6 on RHEL/Fedora.
  if (
    existsSync("/lib/x86_64-linux-gnu/libc.so.6") ||
    existsSync("/lib/aarch64-linux-gnu/libc.so.6") ||
    existsSync("/lib64/libc.so.6")
  ) {
    return "gnu";
  }
  // musl: Alpine ships ld-musl-* alongside libc.so.
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

export function addCost(left: CostInfo, right: CostInfo): CostInfo {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    total_cost_usd: Number((left.total_cost_usd + right.total_cost_usd).toFixed(6)),
  };
}

export function fallbackConsolidation(annotations: ConsolidationAnnotation[]): ConsolidationResult {
  const brief = annotations.map((annotation) => annotation.comment).join("\n\n");
  return {
    brief: brief.length > 0 ? brief : "Refine the plan.",
    cost: zeroCost(),
  };
}

export function zeroCost(): CostInfo {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_cost_usd: 0,
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
