import type { DOToCLIEvent, CLIToDOMessage, SnapshotFrame, ReplayBatchFrame } from "@codevil/shared";
import {
  parseReplayEvent,
  SnapshotFrameSchema,
  ReplayBatchFrameSchema,
} from "@codevil/shared";

export interface EventEnvelope {
  cursor: number;
  event: DOToCLIEvent;
}

export interface WSClientOptions {
  wsUrl: string;
  initialCursor?: number;
  onEvent: (envelope: EventEnvelope) => void;
  onSnapshot?: (frame: SnapshotFrame) => void;
  onReplayBatch?: (frame: ReplayBatchFrame) => void;
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
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid event envelope");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.cursor !== "number") {
    throw new Error("Invalid event envelope");
  }
  const event = parseReplayEvent(record.event);
  if (!event) throw new Error("Invalid event envelope");
  return { cursor: record.cursor, event };
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

      // replay_batch frames carry all tail events in one shot.  Advance cursor
      // to the last item's cursor (if any) and route to onReplayBatch.
      if (raw && typeof raw === "object" && (raw as { type?: unknown }).type === "replay_batch") {
        const result = ReplayBatchFrameSchema.safeParse(raw);
        if (!result.success) return;   // silent drop, matching snapshot path
        // Advance cursor to the last item's cursor (if any).
        const last = result.data.events[result.data.events.length - 1];
        if (last) cursor = Math.max(cursor, last.cursor);
        options.onReplayBatch?.(result.data);
        return;
      }

      // Re-use the already-parsed value to avoid a second JSON.parse.
      // Silently drop malformed envelopes — symmetric with the snapshot frame path above.
      if (typeof raw.cursor !== "number" || raw.event === undefined) {
        return;
      }
      const cliEvent = parseReplayEvent(raw.event);
      if (!cliEvent) return;
      const envelope: EventEnvelope = { cursor: raw.cursor as number, event: cliEvent };
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
