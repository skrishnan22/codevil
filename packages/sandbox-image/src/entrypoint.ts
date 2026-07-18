import { readFileSync } from "node:fs";

import WebSocket from "ws";

import type { DOToSandboxMessage, SandboxToDOMessage } from "@codevil/shared";
import {
  DOToSandboxMessageSchema,
  type EntrypointEnv,
  parseEntrypointEnv,
  parseProviderPublicConfig,
  parseInbound,
} from "@codevil/shared";

import { configureDefaultGitIdentity, ShellGitDriver } from "./git-driver.js";
import {
  sandboxLogException,
  sandboxLogger,
  sessionIdFromWsUrl,
  setSandboxTraceFromSession,
  wsUrlForLog,
} from "./logging.js";
import { PiAgentDriver } from "./pi-driver.js";
import { SandboxRuntime } from "./runtime.js";
import { ReconnectingWebSocketClient } from "./socket-client.js";

export type { EntrypointEnv } from "@codevil/shared";

// Capabilities last 15 minutes. Refreshing over the existing authenticated DO
// socket before that window closes lets long-lived keepalive sandboxes continue
// without ever receiving a real provider credential.
const PROXY_CAPABILITY_REFRESH_MS = 10 * 60 * 1_000;

function isNodeENOENT(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function loadEnv(processEnv: Record<string, unknown>): EntrypointEnv {
  const fromProcess = parseEntrypointEnv(processEnv);
  if (fromProcess.CODEVIL_DO_WS_URL) return fromProcess;

  try {
    const raw = readFileSync("/run/secrets/env.json", "utf8");
    const fileParsed = JSON.parse(raw) as Record<string, unknown>;
    sandboxLogger().log("INFO", "sandbox.env.loaded", { source: "/run/secrets/env.json" });
    return parseEntrypointEnv({ ...processEnv, ...fileParsed });
  } catch (error) {
    if (isNodeENOENT(error)) return fromProcess;
    if (error instanceof Error && error.message.startsWith("Invalid sandbox env:")) throw error;
    if (error instanceof SyntaxError) {
      throw new Error("Invalid JSON in /run/secrets/env.json");
    }
    throw error;
  }
}

export interface SandboxMessageRuntime {
  handleMessage(message: DOToSandboxMessage): Promise<void>;
}

export function createSandboxMessageDispatcher(runtime: SandboxMessageRuntime): (message: DOToSandboxMessage) => void {
  let mainQueue = Promise.resolve();
  let previewQueue = Promise.resolve();
  let capabilityQueue = Promise.resolve();

  const enqueue = (
    queue: Promise<void>,
    run: () => Promise<void>,
  ): Promise<void> => queue.then(run, run).catch((error: unknown) => {
    sandboxLogException("sandbox.message_handler.failed", error);
  });

  return (message: DOToSandboxMessage): void => {
    if (message.type === "protocol_error") {
      sandboxLogger().log("ERROR", "do_protocol_error", { message: message.message });
      return;
    }

    if (message.type === "proxy_capabilities") {
      capabilityQueue = enqueue(capabilityQueue, () => runtime.handleMessage(message));
      return;
    }

    if (
      message.type === "create_pr_response" ||
      message.type === "ask_question_response" ||
      message.type === "ask_question_cancelled"
    ) {
      void runtime.handleMessage(message).catch((error: unknown) => {
        sandboxLogException("sandbox.rpc_handler.failed", error, { message_type: message.type });
      });
      return;
    }

    if (message.type === "preview_start" || message.type === "preview_stop") {
      previewQueue = enqueue(previewQueue, () => runtime.handleMessage(message));
      return;
    }

    mainQueue = enqueue(mainQueue, () => runtime.handleMessage(message));
  };
}

export async function startEntrypoint(
  rawEnv: Record<string, unknown> = process.env,
): Promise<void> {
  sandboxLogger().log("INFO", "sandbox.entrypoint.start");

  const env = loadEnv(rawEnv);

  if (!env.CODEVIL_DO_WS_URL) throw new Error("CODEVIL_DO_WS_URL is required");
  if (!env.CODEVIL_PROXY_BASE || !env.CODEVIL_PROXY_TOKENS) {
    throw new Error("Sandbox outbound proxy configuration is required");
  }

  let wsUrl = withSandboxWebSocketToken(env.CODEVIL_DO_WS_URL, env.CODEVIL_SANDBOX_WS_TOKEN);
  const sessionId = sessionIdFromWsUrl(wsUrl);
  if (sessionId) setSandboxTraceFromSession(sessionId);

  await configureDefaultGitIdentity();

  let connection: ReconnectingWebSocketClient;
  let proxyCapabilityRefreshTimer: NodeJS.Timeout | undefined;

  const proxyTokens = parseProxyTokens(env.CODEVIL_PROXY_TOKENS);
  const providerConfig = parseProviderPublicConfig(env.CODEVIL_PROVIDER_CONFIG);
  const runtime = new SandboxRuntime({
    workspace: env.CODEVIL_WORKSPACE ?? "/workspace",
    provider: env.CODEVIL_PROVIDER ?? "anthropic",
    providerConfig,
    proxyTokens,
    proxySessionId: sessionId,
    proxyBase: env.CODEVIL_PROXY_BASE,
    send: (message: SandboxToDOMessage) => connection.send(JSON.stringify(message)),
    agentFactory: () => new PiAgentDriver(),
    git: new ShellGitDriver({
      proxyBase: env.CODEVIL_PROXY_BASE,
      proxySessionId: sessionId,
      gitProxyCapability: proxyTokens?.git,
    }),
  });
  const dispatch = createSandboxMessageDispatcher(runtime);

  connection = new ReconnectingWebSocketClient({
    createSocket: () => {
      sandboxLogger().log("INFO", "sandbox.ws.connecting", { target: wsUrlForLog(wsUrl) });
      return new WebSocket(wsUrl);
    },
    onOpen: () => {
      sandboxLogger().log("INFO", "sandbox.ws.connected");
      connection.send(JSON.stringify({ type: "status", message: "Sandbox connected." } satisfies SandboxToDOMessage));
      connection.send(JSON.stringify({ type: "proxy_capabilities_refresh_request" } satisfies SandboxToDOMessage));
      if (!proxyCapabilityRefreshTimer) {
        proxyCapabilityRefreshTimer = setInterval(() => {
          connection.send(JSON.stringify({ type: "proxy_capabilities_refresh_request" } satisfies SandboxToDOMessage));
        }, PROXY_CAPABILITY_REFRESH_MS);
        proxyCapabilityRefreshTimer.unref();
      }
    },
    onError: (error) => {
      sandboxLogException("sandbox.ws.error", error);
    },
    onClose: (code, reason) => {
      sandboxLogger().log("WARN", "sandbox.ws.closed", { code, reason });
    },
    onMessage: (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        sandboxLogger().log("WARN", "sandbox.ws.malformed_json");
        return;
      }
      const message = parseInbound(DOToSandboxMessageSchema, raw, "do_to_sandbox");
      if (!message) return;
      if (message.type === "proxy_capabilities" && message.sandbox_ws_token) {
        wsUrl = withSandboxWebSocketToken(wsUrl, message.sandbox_ws_token);
      }
      sandboxLogger().log("DEBUG", "sandbox.message.received", { message_type: message.type });
      dispatch(message);
    },
  });
  connection.start();
}

function withSandboxWebSocketToken(wsUrl: string, token: string | undefined): string {
  if (!token) return wsUrl;
  const url = new URL(wsUrl);
  url.searchParams.set("sandbox_ws_token", token);
  return url.toString();
}

function parseProxyTokens(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return undefined; }
}
