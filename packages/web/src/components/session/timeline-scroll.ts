export const TIMELINE_BOTTOM_THRESHOLD = 24;

interface TimelineFollowInput {
  distanceFromBottom: number;
  bottomThreshold?: number;
}

interface TimelineFollowState {
  isFollowingLatest: boolean;
  isNearBottom: boolean;
}

export function getTimelineFollowStateAfterScroll({
  distanceFromBottom,
  bottomThreshold = TIMELINE_BOTTOM_THRESHOLD,
}: TimelineFollowInput): TimelineFollowState {
  const isNearBottom = distanceFromBottom <= bottomThreshold;
  return {
    isFollowingLatest: isNearBottom,
    isNearBottom,
  };
}

export function getTimelineFollowStateAfterJump(): TimelineFollowState {
  return {
    isFollowingLatest: true,
    isNearBottom: true,
  };
}
