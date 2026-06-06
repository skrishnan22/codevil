import { describe, expect, it } from "vitest";
import { collectFilesTouched } from "../session-files";
import type { ActivityEntry } from "../../types";

describe("collectFilesTouched", () => {
  it("returns an empty list when there are no tool calls", () => {
    expect(collectFilesTouched([])).toEqual([]);
  });

  it("collects read files from path arguments", () => {
    const activityLog: ActivityEntry[] = [
      {
        id: "a1",
        kind: "tool_call",
        status: "success",
        timestamp: 1,
        tool: { name: "read", summary: "Read file", args: JSON.stringify({ path: "src/app.tsx" }) },
      },
    ];

    expect(collectFilesTouched(activityLog)).toEqual([
      { path: "src/app.tsx", mode: "read", activityIds: ["a1"] },
    ]);
  });

  it("collects write files from edit and write tools", () => {
    const activityLog: ActivityEntry[] = [
      {
        id: "a1",
        kind: "tool_call",
        status: "success",
        timestamp: 1,
        tool: { name: "edit", summary: "Edit file", args: JSON.stringify({ path: "src/app.tsx" }) },
      },
      {
        id: "a2",
        kind: "tool_call",
        status: "success",
        timestamp: 2,
        tool: { name: "write", summary: "Write file", args: JSON.stringify({ file_path: "src/new.ts" }) },
      },
    ];

    expect(collectFilesTouched(activityLog)).toEqual([
      { path: "src/app.tsx", mode: "write", activityIds: ["a1"] },
      { path: "src/new.ts", mode: "write", activityIds: ["a2"] },
    ]);
  });

  it("merges repeated touches for the same path and keeps write precedence", () => {
    const activityLog: ActivityEntry[] = [
      {
        id: "a1",
        kind: "tool_call",
        status: "success",
        timestamp: 1,
        tool: { name: "read", summary: "Read file", args: JSON.stringify({ path: "src/app.tsx" }) },
      },
      {
        id: "a2",
        kind: "tool_call",
        status: "success",
        timestamp: 2,
        tool: { name: "edit", summary: "Edit file", args: JSON.stringify({ path: "src/app.tsx" }) },
      },
    ];

    expect(collectFilesTouched(activityLog)).toEqual([
      { path: "src/app.tsx", mode: "write", activityIds: ["a1", "a2"] },
    ]);
  });

  it("ignores malformed JSON arguments", () => {
    const activityLog: ActivityEntry[] = [
      {
        id: "a1",
        kind: "tool_call",
        status: "success",
        timestamp: 1,
        tool: { name: "read", summary: "Read file", args: "{" },
      },
    ];

    expect(collectFilesTouched(activityLog)).toEqual([]);
  });
});
