import { useSessionStore } from "@/stores/session-store";
import { loadStoredSession } from "@/lib/session-summary";
import {
  assignParticipantAvatarColors,
  getParticipantColorKey,
} from "@/lib/avatar-colors";
import type { CSSProperties } from "react";

const PHASES = ["Plan", "Execute", "Verify", "PR", "Done"];

export function RoomHeader() {
  const { sessionId, messages, participants, sessionPhase, planApproved } = useSessionStore();
  const storedSession = loadStoredSession(sessionId);
  const title =
    messages.find((message) => message.role === "user")?.content.replace(/^@codevil\s*/i, "") ||
    storedSession?.title ||
    "Waiting for room activity";
  const people = participants.length > 0
    ? participants.map((participant) => ({ id: participant.id, name: participant.name }))
    : uniqueActors(messages).map((name) => ({ id: name, name }));
  const avatarColors = assignParticipantAvatarColors(people);
  const activeIndex = getActivePhaseIndex(sessionPhase, planApproved);

  return (
    <header className="room-editorial">
      <div className="room-editorial-kicker">ROOM · {PHASES[activeIndex] ?? "PLAN"}</div>
      <h1 className="room-editorial-title">{title}</h1>
      <div className="room-editorial-meta">
        <span className="room-phase-bars" aria-label={`Phase ${activeIndex + 1} of ${PHASES.length}`}>
          {PHASES.map((phase, index) => (
            <span
              key={phase}
              className={index <= activeIndex ? "room-phase-bar room-phase-bar--done" : "room-phase-bar"}
              title={phase}
            />
          ))}
        </span>
        <span className="room-phase-copy">{activeIndex + 1}/{PHASES.length} · {PHASES[activeIndex]}</span>
        <span className="room-editorial-meta-sep" aria-hidden="true">·</span>
        <span className="room-avatars" aria-label={`${people.length + 1} in room`}>
          {people.map((person) => (
            <span
              key={person.id}
              className="room-avatar"
              title={person.name}
              aria-label={person.name}
              style={{ "--avatar-color": avatarColors.get(getParticipantColorKey(person)) } as CSSProperties}
            >
              {person.name.slice(0, 1).toUpperCase()}
            </span>
          ))}
          <span className="room-avatar room-avatar--agent" title="Codevil" aria-label="Codevil">
            <span />
          </span>
        </span>
        <span className="room-occupancy">{people.length + 1} in room</span>
      </div>
    </header>
  );
}

function uniqueActors(messages: { actor?: string; role: string }[]): string[] {
  const names = messages
    .filter((message) => message.role === "user")
    .map((message) => message.actor || "You");
  return [...new Set(names)].slice(0, 3);
}

function getActivePhaseIndex(sessionPhase: string | null, planApproved: boolean): number {
  if (sessionPhase === "completed") return 4;
  if (sessionPhase === "creating_pr") return 3;
  if (sessionPhase === "verifying" || sessionPhase === "retrying") return 2;
  if (sessionPhase === "executing" || planApproved) return 1;
  return 0;
}
