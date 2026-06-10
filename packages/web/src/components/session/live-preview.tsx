import { useState } from "react";
import { useSessionStore, type PreviewState, type PreviewStatus } from "@/stores/session-store";

export function LivePreview() {
  const { preview, startPreview, stopPreview, selectPreviewApp, sessionPhase, connectionStatus } = useSessionStore();
  const [loadedFrameKey, setLoadedFrameKey] = useState<string | null>(null);
  const [loadedPreviewUrl, setLoadedPreviewUrl] = useState<string | null>(null);
  const enabled = preview.status === "starting" || preview.status === "ready";
  const hasApps = preview.apps.length > 0;
  const hasReadyFrame = preview.status === "ready" && Boolean(preview.url);
  const frameKey = preview.url ? `${preview.url}:${preview.reloadRevision}` : null;
  const iframeLoaded = frameKey ? isPreviewFrameLoaded(frameKey, loadedFrameKey) : false;
  const hasLoadedPreview = Boolean(preview.url && loadedPreviewUrl === preview.url);
  const frameVisible = iframeLoaded || hasLoadedPreview;
  const showLoading = shouldShowPreviewLoading(preview.status, hasReadyFrame, iframeLoaded, hasLoadedPreview);
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

      {preview.status === "starting" && (
        <PreviewLoading preview={preview} />
      )}

      {hasReadyFrame && preview.url && (
        <div className="live-preview-stage">
          <iframe
            key={frameKey}
            className={`live-preview-frame ${frameVisible ? "loaded" : "loading"}`}
            title="Live preview"
            src={preview.url}
            sandbox="allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts"
            onLoad={() => {
              if (frameKey) setLoadedFrameKey(frameKey);
              setLoadedPreviewUrl(preview.url);
            }}
          />
          {showLoading && (
            <PreviewLoading preview={preview} overlay />
          )}
        </div>
      )}
    </section>
  );
}

function PreviewLoading({ preview, overlay = false }: { preview: PreviewState; overlay?: boolean }) {
  const lines = preview.outputLines.length > 0
    ? preview.outputLines
    : ["Waiting for preview command output..."];

  return (
    <div className={`live-preview-loading${overlay ? " overlay" : ""}`}>
      <div className="live-preview-loading-center">
        <div className="live-preview-loading-title">Live preview loading</div>
        <div className="live-preview-loading-meta">
          {preview.command ?? "Starting preview command"}
          {preview.port ? ` · port ${preview.port}` : ""}
        </div>
        <div className="live-preview-output" aria-live="polite">
          {lines.map((line, index) => (
            <div key={`${index}:${line}`} className="live-preview-output-line">
              {line}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function shouldShowPreviewLoading(
  status: PreviewStatus,
  hasReadyFrame: boolean,
  iframeLoaded: boolean,
  hasLoadedPreview: boolean,
): boolean {
  return status === "starting" || (status === "ready" && hasReadyFrame && !iframeLoaded && !hasLoadedPreview);
}

export function isPreviewFrameLoaded(frameKey: string, loadedFrameKey: string | null): boolean {
  return loadedFrameKey === frameKey;
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
