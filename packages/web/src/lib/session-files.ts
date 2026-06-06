import type { ActivityEntry } from "@/types";

export interface FileTouch {
  path: string;
  mode: "read" | "write";
  activityIds: string[];
}

export function collectFilesTouched(activityLog: ActivityEntry[]): FileTouch[] {
  const files = new Map<string, FileTouch>();

  for (const entry of activityLog) {
    if (entry.kind !== "tool_call" || !entry.tool) continue;

    const args = parseArgs(entry.tool.args);
    const path = readPath(args);
    if (!path) continue;

    const mode = isWriteTool(entry.tool.name) ? "write" : "read";
    const existing = files.get(path);

    if (!existing) {
      files.set(path, { path, mode, activityIds: [entry.id] });
      continue;
    }

    existing.activityIds.push(entry.id);
    if (mode === "write") existing.mode = "write";
  }

  return [...files.values()];
}

function parseArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {};
  try {
    const parsed = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readPath(args: Record<string, unknown>): string | null {
  for (const key of ["path", "file_path", "filePath", "target_file"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function isWriteTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.includes("write") || normalized.includes("edit") || normalized.includes("replace");
}
