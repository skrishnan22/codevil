import type { DOToCLIEvent, CLIToDOMessage, SnapshotFrame } from "@codevil/shared";
import { SnapshotFrameSchema } from "@codevil/shared";

export interface EventEnvelope {
  cursor: number;
  event: DOToCLIEvent;
}

export interface WSClientOptions {
  wsUrl: string;
  initialCursor?: number;
  onEvent: (envelope: EventEnvelope) => void;
  onSnapshot?: (frame: SnapshotFrame) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (error: Event) => void;
  onReconnecting?: (attempt: number, delayMs: number) => void;
}

export function buildWebSocketUrl(
  wsUrl: string,
  cursor: number,
): string {
  const url = new URL(wsUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  url.searchParams.delete("token");
  url.searchParams.delete("participant_id");
  url.searchParams.delete("name");
  url.searchParams.set("cursor", cursor.toString());
  return url.toString();
}

export function parseEnvelope(raw: string): EventEnvelope {
  const parsed = JSON.parse(raw);
  if (typeof parsed.cursor !== "number" || !parsed.event || typeof parsed.event.type !== "string") {
    throw new Error("Invalid event envelope");
  }
  return { cursor: parsed.cursor, event: parsed.event as DOToCLIEvent };
}

export function connectWebSocket(options: WSClientOptions): {
  send: (msg: CLIToDOMessage) => void;
  close: () => void;
} {
  let ws: WebSocket | null = null;
  let cursor = options.initialCursor ?? 0;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let explicitlyClosed = false;
  const outbox: CLIToDOMessage[] = [];

  function open(): void {
    const url = buildWebSocketUrl(
      options.wsUrl,
      cursor,
    );
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectAttempt = 0;
      options.onOpen?.();
      const pending = outbox.splice(0);
      for (const message of pending) {
        ws?.send(JSON.stringify(message));
      }
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;

      // Check for the snapshot frame shape before attempting to parse as an
      // event envelope.  Snapshot frames have { type: "snapshot", path, cursor, state }.
      const raw = JSON.parse(event.data);
      if (raw && typeof raw === "object" && raw.type === "snapshot") {
        const result = SnapshotFrameSchema.safeParse(raw);
        if (result.success && options.onSnapshot) {
          // Advance cursor so reconnects start after the snapshot.
          cursor = Math.max(cursor, result.data.cursor);
          options.onSnapshot(result.data);
        }
        return;
      }

      // Re-use the already-parsed value to avoid a second JSON.parse.
      // Silently drop malformed envelopes — symmetric with the snapshot frame path above.
      if (typeof raw.cursor !== "number" || !raw.event || typeof (raw.event as Record<string, unknown>).type !== "string") {
        return;
      }
      const envelope: EventEnvelope = { cursor: raw.cursor as number, event: raw.event as DOToCLIEvent };
      cursor = Math.max(cursor, envelope.cursor);
      options.onEvent(envelope);
    };

    ws.onclose = (event) => {
      if (explicitlyClosed) {
        options.onClose?.(event.code, event.reason);
        return;
      }
      const delayMs = Math.min(500 * 2 ** reconnectAttempt, 5_000);
      reconnectAttempt++;
      options.onReconnecting?.(reconnectAttempt, delayMs);
      reconnectTimer = setTimeout(open, delayMs);
    };
    ws.onerror = (event) => options.onError?.(event);
  }

  open();

  return {
    send(msg: CLIToDOMessage) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      } else {
        outbox.push(msg);
      }
    },
    close() {
      explicitlyClosed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close(1000, "client closed");
    },
  };
}
