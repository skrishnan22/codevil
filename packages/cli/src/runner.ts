import WebSocket from "ws";

import type { CLIToDOMessage } from "@codevil/shared";

import type { RunCommand } from "./args.js";
import type { readConfig } from "./config.js";
import { isCompletionEvent, parseFrame, renderEvent } from "./events.js";
import {
  buildSessionPayload,
  buildWebSocketUrl,
  createSession,
  type CreateSessionResponse,
} from "./session-client.js";
import { promptForApproval } from "./approval.js";

type Config = Awaited<ReturnType<typeof readConfig>>;

export interface RunnerIO {
  write(line: string): void;
  debug(line: string): void;
  promptApproval(): Promise<CLIToDOMessage>;
}

export async function runSession(
  config: Config,
  command: RunCommand,
  io: RunnerIO = buildDefaultIO(command.debug),
): Promise<CreateSessionResponse> {
  const payload = buildSessionPayload(command, config);
  io.debug(`POST ${config.endpoint}/sessions`);
  io.debug(`  payload: ${JSON.stringify(payload)}`);

  const session = await createSession(config, command);
  io.debug(`  response: ${JSON.stringify(session)}`);
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
    const url = buildWebSocketUrl(wsUrl, cursor);
    io.debug(`ws connecting: ${url}`);

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    ws.on("open", () => {
      io.debug("ws open");
    });

    ws.on("message", (data) => {
      const raw = data.toString();
      io.debug(`ws ← ${raw}`);
      void handleMessage(raw, ws, io, setCursor).then((isComplete) => {
        completed = completed || isComplete;
        if (completed) ws.close(1000, "completed");
      }, reject);
    });

    ws.on("error", (error) => {
      io.debug(`ws error: ${error.message}`);
      reject(error);
    });

    ws.on("close", (code, reason) => {
      io.debug(`ws closed: code=${code} reason=${reason.toString()}`);
      resolve(completed);
    });
  });
}

async function handleMessage(
  raw: string,
  ws: WebSocket,
  io: RunnerIO,
  setCursor: (cursor: number) => void,
): Promise<boolean> {
  const frame = parseFrame(raw);

  if (frame.kind === "snapshot") {
    // The CLI was started mid-session; snapshot delivers the current state
    // as of snapshotCursor. We advance the cursor and let the following
    // replay_batch frame render the tail events.
    setCursor(frame.cursor);
    return false;
  }

  if (frame.kind === "replay_batch") {
    // Process each event in order exactly as if they had arrived as separate
    // envelopes. Return true only if the last event signals completion.
    let completed = false;
    for (const item of frame.events) {
      setCursor(item.cursor);
      for (const line of renderEvent(item.event)) {
        io.write(line);
      }
      if (item.event.type === "plan_ready") {
        const approval = await io.promptApproval();
        io.debug(`ws → ${JSON.stringify(approval)}`);
        ws.send(JSON.stringify(approval));
      }
      if (isCompletionEvent(item.event)) {
        completed = true;
      }
    }
    return completed;
  }

  if (frame.kind === "envelope") {
    setCursor(frame.cursor);
    for (const line of renderEvent(frame.event)) {
      io.write(line);
    }
    if (frame.event.type === "plan_ready") {
      const approval = await io.promptApproval();
      io.debug(`ws → ${JSON.stringify(approval)}`);
      ws.send(JSON.stringify(approval));
    }
    return isCompletionEvent(frame.event);
  }

  // kind === "unknown": forward-compat drop — silently ignore
  return false;
}

function buildDefaultIO(debug?: boolean): RunnerIO {
  return {
    write(line: string): void {
      console.log(line);
    },
    debug(line: string): void {
      if (debug) {
        console.error(`[debug] ${line}`);
      }
    },
    promptApproval: promptForApproval,
  };
}
