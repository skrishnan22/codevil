export interface ManagedWebSocket {
  readyState: number;
  send(value: string): void;
  ping(): void;
  terminate(): void;
  close(): void;
  on(event: "open", listener: () => void): this;
  on(event: "pong", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
}

export interface ReconnectingWebSocketClientOptions {
  createSocket(): ManagedWebSocket;
  onOpen(): void;
  onMessage(data: unknown): void;
  onError(error: Error): void;
  onClose(code: number, reason: string): void;
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

const OPEN = 1;

export class ReconnectingWebSocketClient {
  private readonly options: Required<Omit<
    ReconnectingWebSocketClientOptions,
    "heartbeatIntervalMs" | "pongTimeoutMs" | "reconnectBaseDelayMs" | "reconnectMaxDelayMs" | "setTimeout" | "clearTimeout"
  >> & {
    heartbeatIntervalMs: number;
    pongTimeoutMs: number;
    reconnectBaseDelayMs: number;
    reconnectMaxDelayMs: number;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  private socket: ManagedWebSocket | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private stopped = true;
  private outbox: string[] = [];

  constructor(options: ReconnectingWebSocketClientOptions) {
    this.options = {
      ...options,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
      pongTimeoutMs: options.pongTimeoutMs ?? 10_000,
      reconnectBaseDelayMs: options.reconnectBaseDelayMs ?? 1_000,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs ?? 30_000,
      setTimeout: options.setTimeout ?? setTimeout,
      clearTimeout: options.clearTimeout ?? clearTimeout,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearConnectionTimers();
    if (this.reconnectTimer !== undefined) {
      this.options.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
  }

  send(value: string): void {
    if (this.socket?.readyState === OPEN) {
      this.socket.send(value);
      return;
    }
    this.outbox.push(value);
  }

  private connect(): void {
    if (this.stopped) return;

    const socket = this.options.createSocket();
    this.socket = socket;

    socket.on("open", () => {
      if (this.socket !== socket || this.stopped) return;
      this.reconnectAttempt = 0;
      this.flushOutbox(socket);
      this.options.onOpen();
      this.scheduleHeartbeat(socket);
    });
    socket.on("pong", () => {
      if (this.socket !== socket || this.stopped) return;
      if (this.pongTimer !== undefined) {
        this.options.clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
      }
      this.scheduleHeartbeat(socket);
    });
    socket.on("message", (data) => {
      if (this.socket === socket && !this.stopped) this.options.onMessage(data);
    });
    socket.on("error", (error) => {
      if (this.socket === socket && !this.stopped) this.options.onError(error);
    });
    socket.on("close", (code, reason) => {
      if (this.socket !== socket) return;
      this.clearConnectionTimers();
      this.socket = undefined;
      this.options.onClose(code, reason.toString());
      this.scheduleReconnect();
    });
  }

  private scheduleHeartbeat(socket: ManagedWebSocket): void {
    if (this.heartbeatTimer !== undefined) this.options.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = this.options.setTimeout(() => {
      this.heartbeatTimer = undefined;
      if (this.socket !== socket || socket.readyState !== OPEN || this.stopped) return;
      socket.ping();
      this.pongTimer = this.options.setTimeout(() => {
        this.pongTimer = undefined;
        if (this.socket === socket && !this.stopped) socket.terminate();
      }, this.options.pongTimeoutMs);
    }, this.options.heartbeatIntervalMs);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const delay = Math.min(
      this.options.reconnectBaseDelayMs * 2 ** this.reconnectAttempt,
      this.options.reconnectMaxDelayMs,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = this.options.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private flushOutbox(socket: ManagedWebSocket): void {
    const queued = this.outbox;
    this.outbox = [];
    for (const value of queued) socket.send(value);
  }

  private clearConnectionTimers(): void {
    if (this.heartbeatTimer !== undefined) {
      this.options.clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.pongTimer !== undefined) {
      this.options.clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    }
  }
}
