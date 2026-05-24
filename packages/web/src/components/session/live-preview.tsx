import { useSessionStore, type PreviewState } from "@/stores/session-store";

export function LivePreview() {
  const { preview, startPreview, stopPreview, selectPreviewApp, sessionPhase, connectionStatus } = useSessionStore();
  const enabled = preview.status === "starting" || preview.status === "ready";
  const hasApps = preview.apps.length > 0;
  const canToggle =
    connectionStatus === "connected" &&
    sessionPhase !== null &&
    hasApps &&
    preview.status !== "starting";

  return (
    <section className="live-preview">
      <div className="live-preview-bar">
        <div className="live-preview-copy">
          <div className="live-preview-title">Live Preview</div>
          <div className="live-preview-meta">
            {previewMeta(preview, hasApps)}
          </div>
        </div>
        {preview.apps.length > 1 && (
          <select
            className="preview-app-select"
            value={preview.selectedAppKey ?? preview.apps[0]?.key ?? ""}
            disabled={enabled}
            onChange={(event) => selectPreviewApp(event.target.value)}
          >
            {preview.apps.map((app) => (
              <option key={app.key} value={app.key}>
                {appLabel(app.name, app.cwd)}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className={`preview-toggle ${enabled ? "on" : ""}`}
          aria-pressed={enabled}
          disabled={!canToggle}
          onClick={() => (enabled ? stopPreview() : startPreview())}
        >
          <span />
        </button>
      </div>

      {preview.status === "error" && (
        <div className="live-preview-error">{preview.error}</div>
      )}

      {preview.status === "ready" && preview.url && (
        <iframe
          className="live-preview-frame"
          title="Live preview"
          src={preview.url}
          sandbox="allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts"
        />
      )}
    </section>
  );
}

function previewMeta(preview: PreviewState, hasApps: boolean): string {
  if (preview.command && preview.port) return `${preview.command} · ${preview.port}`;
  if (!hasApps) return "Waiting for repository to finish cloning…";
  const selected = preview.apps.find((app) => app.key === preview.selectedAppKey) ?? preview.apps[0];
  if (selected) return `${appLabel(selected.name, selected.cwd)} · port ${selected.port}`;
  return "Start a managed dev server for this session";
}

function appLabel(name: string, cwd: string): string {
  const tail = cwd.split("/").filter(Boolean).pop();
  if (tail && tail !== name) return `${name} (${tail})`;
  return name;
}
