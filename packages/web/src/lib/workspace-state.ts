export type WorkspaceTab = "preview" | "activity";

export function getInitialWorkspaceTab(previewOn: boolean): WorkspaceTab {
  return previewOn ? "preview" : "activity";
}

export function getWorkspaceTabAfterPreviewToggle({
  previewOn,
}: {
  current: WorkspaceTab;
  previewOn: boolean;
}): WorkspaceTab {
  return previewOn ? "preview" : "activity";
}

export function getWorkspaceTabAfterUserSelection(tab: WorkspaceTab): WorkspaceTab {
  return tab;
}
