import { isTerminalState, type SessionState } from "@codevil/shared";
import { sandboxReconnectDeadline } from "../sandbox-connection.js";

export interface AlarmScheduleInput {
  now: number;
  state: SessionState;
  createdAt: number;
  maxTimeMs: number | null;
  sandboxDisconnectedAt?: string;
  presentationRetryAt?: number | null;
  workspaceCacheRetryAt?: number | null;
}

export function nextAlarmDeadline(input: AlarmScheduleInput): number | undefined {
  const deadlines: number[] = [];
  if (!isTerminalState(input.state)) {
    deadlines.push(input.createdAt + 60_000);
    if (input.maxTimeMs !== null) deadlines.push(input.createdAt + input.maxTimeMs);
    if (input.sandboxDisconnectedAt) {
      deadlines.push(sandboxReconnectDeadline(input.sandboxDisconnectedAt));
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
