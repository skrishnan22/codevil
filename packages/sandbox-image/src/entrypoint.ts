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
    console.log("codevil-sandbox: loaded env from /run/secrets/env.json");
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
    console.error("codevil-sandbox: message handler failed", error);
  });

  return (message: DOToSandboxMessage): void => {
    if (
      message.type === "credential_response" ||
      message.type === "create_pr_response" ||
      message.type === "ask_question_response" ||
      message.type === "ask_question_cancelled"
    ) {
      void runtime.handleMessage(message);
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
  console.log("codevil-sandbox: starting entrypoint");

  const env = loadEnv(rawEnv);

  if (!env.CODEVIL_DO_WS_URL) throw new Error("CODEVIL_DO_WS_URL is required");

  const wsUrl = env.CODEVIL_DO_WS_URL;

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
      console.log("codevil-sandbox: connecting to", wsUrl);
      return new WebSocket(wsUrl, {
        headers: env.CODEVIL_API_KEY ? { Authorization: `Bearer ${env.CODEVIL_API_KEY}` } : undefined,
      });
    },
    onOpen: () => {
      console.log("codevil-sandbox: websocket connected");
      connection.send(JSON.stringify({ type: "status", message: "Sandbox connected." } satisfies SandboxToDOMessage));
    },
    onError: (error) => {
      console.error("codevil-sandbox: websocket error", error.message);
    },
    onClose: (code, reason) => {
      console.log("codevil-sandbox: websocket closed; reconnecting", code, reason);
    },
    onMessage: (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        console.error("codevil-sandbox: malformed JSON from DO");
        return;
      }
      const message = parseInbound(DOToSandboxMessageSchema, raw, "do_to_sandbox");
      if (!message) return;
      console.log("codevil-sandbox: received message", message.type);
      dispatch(message);
    },
  });
  connection.start();
}
