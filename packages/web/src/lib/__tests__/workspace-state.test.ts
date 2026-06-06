import { describe, expect, it } from "vitest";
import {
  getInitialWorkspaceTab,
  getWorkspaceTabAfterPreviewToggle,
  getWorkspaceTabAfterUserSelection,
  type WorkspaceTab,
} from "../workspace-state";

describe("workspace-state", () => {
  it("defaults to preview when preview is on", () => {
    expect(getInitialWorkspaceTab(true)).toBe("preview");
  });

  it("defaults to activity when preview is off", () => {
    expect(getInitialWorkspaceTab(false)).toBe("activity");
  });

  it("switches to preview when preview is toggled on", () => {
    expect(getWorkspaceTabAfterPreviewToggle({ current: "activity", previewOn: true })).toBe("preview");
  });

  it("switches to activity when preview is toggled off", () => {
    expect(getWorkspaceTabAfterPreviewToggle({ current: "preview", previewOn: false })).toBe("activity");
  });

  it("keeps manual activity selection while preview is off", () => {
    const selected: WorkspaceTab = getWorkspaceTabAfterUserSelection("activity");
    expect(selected).toBe("activity");
  });

  it("keeps manual preview selection while preview is on", () => {
    const selected: WorkspaceTab = getWorkspaceTabAfterUserSelection("preview");
    expect(selected).toBe("preview");
  });
});
