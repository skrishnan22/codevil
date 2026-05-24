import { readFileSync } from "node:fs";

import WebSocket from "ws";

import type { DOToSandboxMessage, SandboxToDOMessage } from "@codevil/shared";
import { DOToSandboxMessageSchema, parseInbound } from "@codevil/shared";

import { configureDefaultGitIdentity, ShellGitDriver } from "./git-driver.js";
import { PiAgentDriver } from "./pi-driver.js";
import { SandboxRuntime } from "./runtime.js";
import { readAndUnlinkSecret } from "./secrets.js";

export interface EntrypointEnv {
  CODEVIL_DO_WS_URL?: string;
  CODEVIL_API_KEY?: string;
  CODEVIL_WORKSPACE?: string;
  CODEVIL_PROVIDER?: string;
  CODEVIL_LLM_KEY_FILE?: string;
}

function loadEnv(processEnv: EntrypointEnv): EntrypointEnv {
  if (processEnv.CODEVIL_DO_WS_URL) return processEnv;

  try {
    const raw = readFileSync("/run/secrets/env.json", "utf8");
    const fileEnv = JSON.parse(raw) as EntrypointEnv;
    console.log("codevil-sandbox: loaded env from /run/secrets/env.json");
    return { ...processEnv, ...fileEnv };
  } catch {
    return processEnv;
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
    if (message.type === "credential_response") {
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

export async function startEntrypoint(env: EntrypointEnv = process.env): Promise<void> {
  console.log("codevil-sandbox: starting entrypoint");

  env = loadEnv(env);

  if (!env.CODEVIL_DO_WS_URL) throw new Error("CODEVIL_DO_WS_URL is required");

  await configureDefaultGitIdentity();

  console.log("codevil-sandbox: connecting to", env.CODEVIL_DO_WS_URL);
  const llmKey = await readAndUnlinkSecret(env.CODEVIL_LLM_KEY_FILE ?? "/run/secrets/llm_key");
  const ws = new WebSocket(env.CODEVIL_DO_WS_URL, {
    headers: env.CODEVIL_API_KEY ? { Authorization: `Bearer ${env.CODEVIL_API_KEY}` } : undefined,
  });

  const send = (message: SandboxToDOMessage): void => {
    ws.send(JSON.stringify(message));
  };

  const runtime = new SandboxRuntime({
    workspace: env.CODEVIL_WORKSPACE ?? "/workspace",
    provider: env.CODEVIL_PROVIDER ?? "anthropic",
    llmKey,
    send,
    agentFactory: () => new PiAgentDriver(),
    git: new ShellGitDriver(),
  });
  const dispatch = createSandboxMessageDispatcher(runtime);

  ws.on("open", () => {
    console.log("codevil-sandbox: websocket connected");
    send({ type: "status", message: "Sandbox connected." });
  });

  ws.on("error", (error) => {
    console.error("codevil-sandbox: websocket error", error.message);
  });

  ws.on("message", (data) => {
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      console.error("codevil-sandbox: malformed JSON from DO");
      return;
    }
    const message = parseInbound(DOToSandboxMessageSchema, raw, "do_to_sandbox");
    if (!message) return;
    console.log("codevil-sandbox: received message", message.type);
    dispatch(message);
  });

  ws.on("close", (code, reason) => {
    console.log("codevil-sandbox: websocket closed", code, reason.toString());
    void runtime.dispose();
  });
}
