export const USER_AVATAR_COLORS = [
  "oklch(0.62 0.13 235)",
  "oklch(0.62 0.16 35)",
  "oklch(0.58 0.16 150)",
  "oklch(0.60 0.15 305)",
  "oklch(0.58 0.13 85)",
  "oklch(0.56 0.12 190)",
  "oklch(0.56 0.14 20)",
  "oklch(0.54 0.13 260)",
  "oklch(0.58 0.11 120)",
  "oklch(0.55 0.12 330)",
  "oklch(0.52 0.10 55)",
  "oklch(0.53 0.10 210)",
];

export interface AvatarParticipant {
  id: string;
  name: string;
}

export function getParticipantColorKey(participant: AvatarParticipant): string {
  return participant.id || participant.name;
}

export function assignParticipantAvatarColors(
  participants: AvatarParticipant[],
): Map<string, string> {
  const colors = new Map<string, string>();
  for (const participant of participants) {
    const key = getParticipantColorKey(participant);
    if (colors.has(key)) continue;
    colors.set(key, USER_AVATAR_COLORS[colors.size % USER_AVATAR_COLORS.length]);
  }
  return colors;
}
