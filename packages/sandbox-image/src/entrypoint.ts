import { readFileSync } from "node:fs";

import WebSocket from "ws";

import type { DOToSandboxMessage, SandboxToDOMessage } from "@codevil/shared";

import { ShellGitDriver } from "./git-driver.js";
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

export async function startEntrypoint(env: EntrypointEnv = process.env): Promise<void> {
  console.log("codevil-sandbox: starting entrypoint");

  env = loadEnv(env);

  if (!env.CODEVIL_DO_WS_URL) throw new Error("CODEVIL_DO_WS_URL is required");

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

  ws.on("open", () => {
    console.log("codevil-sandbox: websocket connected");
    send({ type: "status", message: "Sandbox connected." });
  });

  ws.on("error", (error) => {
    console.error("codevil-sandbox: websocket error", error.message);
  });

  let queue = Promise.resolve();
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString()) as DOToSandboxMessage;
    console.log("codevil-sandbox: received message", message.type);
    queue = queue.then(() => runtime.handleMessage(message));
  });

  ws.on("close", (code, reason) => {
    console.log("codevil-sandbox: websocket closed", code, reason.toString());
    void runtime.dispose();
  });
}
