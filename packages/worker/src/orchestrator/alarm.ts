import { isTerminalState, type SessionState } from "@codevil/shared";
import { SANDBOX_PAST_DUE_RETRY_MS } from "./sandbox-lifecycle.js";
import { sandboxReconnectDeadline } from "../sandbox-connection.js";

export interface AlarmScheduleInput {
  now: number;
  state: SessionState;
  createdAt: number;
  maxTimeMs: number | null;
  sandboxDisconnectedAt?: string;
  presentationRetryAt?: number | null;
  workspaceCacheRetryAt?: number | null;
  idlePauseAt?: number | null;
  leaseRenewAt?: number | null;
}

export function nextAlarmDeadline(input: AlarmScheduleInput): number | undefined {
  const deadlines: number[] = [];
  if (!isTerminalState(input.state)) {
    deadlines.push(input.createdAt + 60_000);
    if (input.maxTimeMs !== null) deadlines.push(input.createdAt + input.maxTimeMs);
    if (input.sandboxDisconnectedAt) {
      deadlines.push(sandboxReconnectDeadline(input.sandboxDisconnectedAt));
    }
    // A past-due pause/renew deadline would be filtered out below and strand
    // the work (or its retry after a failure); clamp so it re-fires after a
    // bounded delay instead. Non-finite values are skipped.
    for (const dueAt of [input.idlePauseAt, input.leaseRenewAt]) {
      if (dueAt !== null && dueAt !== undefined && Number.isFinite(dueAt)) {
        deadlines.push(Math.max(dueAt, input.now + SANDBOX_PAST_DUE_RETRY_MS));
      }
    }
  }
  if (input.presentationRetryAt !== null && input.presentationRetryAt !== undefined) {
    deadlines.push(input.presentationRetryAt);
  }
  if (input.workspaceCacheRetryAt !== null && input.workspaceCacheRetryAt !== undefined) {
    // A due-now job has a retry timestamp at or before `now`; without the
    // clamp it would be filtered out and strand the job until some other
    // deadline (potentially the session's max-time) happens to fire.
    deadlines.push(Math.max(input.workspaceCacheRetryAt, input.now + 1));
  }

  const nextDeadline = Math.min(...deadlines.filter((deadline) => deadline > input.now));
  return Number.isFinite(nextDeadline) ? nextDeadline : undefined;
}

export async function armNextAlarm(
  input: AlarmScheduleInput,
  setAlarm: (deadline: number) => Promise<void>,
): Promise<void> {
  const nextDeadline = nextAlarmDeadline(input);
  if (nextDeadline !== undefined) await setAlarm(nextDeadline);
}
