import WebSocket from "ws";

import type { CLIToDOMessage } from "@codevil/shared";

import type { RunCommand } from "./args.js";
import type { readConfig } from "./config.js";
import { isCompletionEvent, parseEnvelope, renderEvent } from "./events.js";
import {
  buildWebSocketUrl,
  createSession,
  type CreateSessionResponse,
} from "./session-client.js";
import { promptForApproval } from "./approval.js";

type Config = Awaited<ReturnType<typeof readConfig>>;

export interface RunnerIO {
  write(line: string): void;
  promptApproval(): Promise<CLIToDOMessage>;
}

export async function runSession(
  config: Config,
  command: RunCommand,
  io: RunnerIO = defaultIO,
): Promise<CreateSessionResponse> {
  const session = await createSession(config, command);
  io.write(`Connected session ${session.session_id}`);

  let cursor = 0;
  let completed = false;

  while (!completed) {
    completed = await connectUntilClose(session.ws_url, cursor, config.api_key, io, (nextCursor) => {
      cursor = nextCursor;
    });
  }

  return session;
}

async function connectUntilClose(
  wsUrl: string,
  cursor: number,
  apiKey: string,
  io: RunnerIO,
  setCursor: (cursor: number) => void,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let completed = false;
    const ws = new WebSocket(buildWebSocketUrl(wsUrl, cursor), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    ws.on("message", (data) => {
      void handleMessage(data.toString(), ws, io, setCursor).then((isComplete) => {
        completed = completed || isComplete;
        if (completed) ws.close(1000, "completed");
      }, reject);
    });

    ws.on("error", reject);
    ws.on("close", () => resolve(completed));
  });
}

async function handleMessage(
  raw: string,
  ws: WebSocket,
  io: RunnerIO,
  setCursor: (cursor: number) => void,
): Promise<boolean> {
  const envelope = parseEnvelope(raw);
  setCursor(envelope.cursor);

  for (const line of renderEvent(envelope.event)) {
    io.write(line);
  }

  if (envelope.event.type === "plan_ready") {
    ws.send(JSON.stringify(await io.promptApproval()));
  }

  return isCompletionEvent(envelope.event);
}

const defaultIO: RunnerIO = {
  write(line: string): void {
    console.log(line);
  },
  promptApproval: promptForApproval,
};
