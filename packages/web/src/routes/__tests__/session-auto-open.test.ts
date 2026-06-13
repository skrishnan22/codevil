/**
 * Unit tests for the pure auto-open helpers exported from session.$id.tsx.
 * These run in node (no jsdom needed).
 */
import { describe, it, expect } from "vitest";
import { revisionKey, shouldAutoOpen } from "../session.$id";

describe("revisionKey", () => {
  it("combines runId and round with a colon", () => {
    expect(revisionKey("run_abc", 0)).toBe("run_abc:0");
    expect(revisionKey("run_abc", 1)).toBe("run_abc:1");
    expect(revisionKey("run_xyz", 3)).toBe("run_xyz:3");
  });
});

describe("shouldAutoOpen", () => {
  it("returns true when lastSeenKey is null and a revision exists", () => {
    expect(shouldAutoOpen(null, "run_abc:0")).toBe(true);
  });

  it("returns true when the key has changed (new round)", () => {
    expect(shouldAutoOpen("run_abc:0", "run_abc:1")).toBe(true);
  });

  it("returns true when the run id changes", () => {
    expect(shouldAutoOpen("run_abc:0", "run_xyz:0")).toBe(true);
  });

  it("returns false when the key is the same (same run and round)", () => {
    expect(shouldAutoOpen("run_abc:0", "run_abc:0")).toBe(false);
  });

  it("returns false when currentKey is null (no revision)", () => {
    expect(shouldAutoOpen(null, null)).toBe(false);
    expect(shouldAutoOpen("run_abc:0", null)).toBe(false);
  });
});
