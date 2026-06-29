import { readFileSync } from "node:fs";

import WebSocket from "ws";

import type { DOToSandboxMessage, SandboxToDOMessage } from "@codevil/shared";
import {
  DOToSandboxMessageSchema,
  type EntrypointEnv,
  parseEntrypointEnv,
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
import { readAndUnlinkSecret } from "./secrets.js";
import { ReconnectingWebSocketClient } from "./socket-client.js";

export type { EntrypointEnv } from "@codevil/shared";

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

  const enqueue = (
    queue: Promise<void>,
    run: () => Promise<void>,
  ): Promise<void> => queue.then(run, run).catch((error: unknown) => {
    sandboxLogException("sandbox.message_handler.failed", error);
  });

  return (message: DOToSandboxMessage): void => {
    if (
      message.type === "credential_response" ||
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

  const wsUrl = env.CODEVIL_DO_WS_URL;
  const sessionId = sessionIdFromWsUrl(wsUrl);
  if (sessionId) setSandboxTraceFromSession(sessionId);

  await configureDefaultGitIdentity();

  const llmKey = await readAndUnlinkSecret(env.CODEVIL_LLM_KEY_FILE ?? "/run/secrets/llm_key");
  let connection: ReconnectingWebSocketClient;

  const runtime = new SandboxRuntime({
    workspace: env.CODEVIL_WORKSPACE ?? "/workspace",
    provider: env.CODEVIL_PROVIDER ?? "anthropic",
    llmKey,
    send: (message: SandboxToDOMessage) => connection.send(JSON.stringify(message)),
    agentFactory: () => new PiAgentDriver(),
    git: new ShellGitDriver(),
  });
  const dispatch = createSandboxMessageDispatcher(runtime);

  connection = new ReconnectingWebSocketClient({
    createSocket: () => {
      sandboxLogger().log("INFO", "sandbox.ws.connecting", { target: wsUrlForLog(wsUrl) });
      return new WebSocket(wsUrl, {
        headers: env.CODEVIL_API_KEY ? { Authorization: `Bearer ${env.CODEVIL_API_KEY}` } : undefined,
      });
    },
    onOpen: () => {
      sandboxLogger().log("INFO", "sandbox.ws.connected");
      connection.send(JSON.stringify({ type: "status", message: "Sandbox connected." } satisfies SandboxToDOMessage));
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
      sandboxLogger().log("DEBUG", "sandbox.message.received", { message_type: message.type });
      dispatch(message);
    },
  });
  connection.start();
}
