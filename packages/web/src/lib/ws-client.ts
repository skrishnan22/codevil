import type { DOToCLIEvent, CLIToDOMessage } from "@codevil/shared";

export interface EventEnvelope {
  cursor: number;
  event: DOToCLIEvent;
}

export interface WSClientOptions {
  wsUrl: string;
  apiKey: string;
  initialCursor?: number;
  onEvent: (envelope: EventEnvelope) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (error: Event) => void;
}

export function buildWebSocketUrl(wsUrl: string, apiKey: string, cursor: number): string {
  const url = new URL(wsUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  url.searchParams.set("token", apiKey);
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
  const url = buildWebSocketUrl(options.wsUrl, options.apiKey, options.initialCursor ?? 0);
  const ws = new WebSocket(url);

  ws.onopen = () => options.onOpen?.();

  ws.onmessage = (e) => {
    if (typeof e.data === "string") {
      const envelope = parseEnvelope(e.data);
      options.onEvent(envelope);
    }
  };

  ws.onclose = (e) => options.onClose?.(e.code, e.reason);
  ws.onerror = (e) => options.onError?.(e);

  return {
    send(msg: CLIToDOMessage) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    close() {
      ws.close(1000, "client closed");
    },
  };
}
