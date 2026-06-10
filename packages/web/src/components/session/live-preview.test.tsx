import { describe, expect, it } from "vitest";
import { isPreviewFrameLoaded, shouldShowPreviewLoading } from "./live-preview";

describe("shouldShowPreviewLoading", () => {
  it("keeps the loading surface visible until the ready iframe loads", () => {
    expect(shouldShowPreviewLoading("starting", false, false, false)).toBe(true);
    expect(shouldShowPreviewLoading("ready", true, false, false)).toBe(true);
    expect(shouldShowPreviewLoading("ready", true, true, false)).toBe(false);
  });

  it("does not show the loading surface again for refreshes after the preview has loaded once", () => {
    expect(shouldShowPreviewLoading("ready", true, false, true)).toBe(false);
  });

  it("only treats the current iframe revision as loaded", () => {
    expect(isPreviewFrameLoaded("https://preview.example/:0", null)).toBe(false);
    expect(isPreviewFrameLoaded("https://preview.example/:1", "https://preview.example/:0")).toBe(false);
    expect(isPreviewFrameLoaded("https://preview.example/:1", "https://preview.example/:1")).toBe(true);
  });
});
