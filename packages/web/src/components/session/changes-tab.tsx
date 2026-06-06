import { useMemo, useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import { collectFilesTouched } from "@/lib/session-files";

export function ChangesTab() {
  const { activityLog } = useSessionStore();
  const files = useMemo(() => collectFilesTouched(activityLog), [activityLog]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selected = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;

  return (
    <div className="changes-tab">
      <div className="changes-file-strip" aria-label="Files touched">
        {files.length === 0 ? (
          <div className="changes-file-empty">No files touched yet</div>
        ) : (
          files.map((file) => (
            <button
              key={file.path}
              type="button"
              className={`changes-file-chip${selected?.path === file.path ? " active" : ""}`}
              onClick={() => setSelectedPath(file.path)}
            >
              <span className={`changes-file-mode ${file.mode}`}>{file.mode === "write" ? "W" : "R"}</span>
              <span className="changes-file-path">{file.path}</span>
            </button>
          ))
        )}
      </div>

      <div className="changes-diff-viewer">
        {selected ? (
          <div className="changes-empty-diff">
            <div className="changes-empty-title">No patch available yet</div>
            <div className="changes-empty-copy">
              Diff data is not emitted by this session yet. File touches are inferred from tool calls.
            </div>
          </div>
        ) : (
          <div className="changes-empty-diff">
            <div className="changes-empty-title">No files touched yet</div>
            <div className="changes-empty-copy">Files will appear here as the agent reads or writes them.</div>
          </div>
        )}
      </div>
    </div>
  );
}
