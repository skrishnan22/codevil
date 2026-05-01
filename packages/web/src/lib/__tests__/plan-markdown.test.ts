import { describe, expect, it } from "vitest";
import { normalizePlanMarkdown } from "../plan-markdown";

describe("normalizePlanMarkdown", () => {
  it("adds markdown hierarchy to plain plan sections", () => {
    const normalized = normalizePlanMarkdown([
      "Implementation Plan",
      "Repo snapshot",
      "The app lives in apps/web.",
      "Steps",
      "Open the README.",
      "Add the test sentence.",
    ].join("\n"));

    expect(normalized).toContain("## Implementation Plan");
    expect(normalized).toContain("### Repo snapshot");
    expect(normalized).toContain("- The app lives in apps/web.");
    expect(normalized).toContain("### Steps");
    expect(normalized).toContain("- Open the README.");
  });

  it("leaves already-marked markdown alone", () => {
    const markdown = "## Plan\n\n- Step one";
    expect(normalizePlanMarkdown(markdown)).toBe(markdown);
  });
});
