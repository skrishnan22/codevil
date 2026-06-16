export const ACTIVITY_BOTTOM_THRESHOLD = 24;

interface ActivityFollowInput {
  distanceFromBottom: number;
  bottomThreshold?: number;
}

interface ActivityFollowState {
  isFollowingLatest: boolean;
  isNearBottom: boolean;
}

export function getActivityFollowStateAfterScroll({
  distanceFromBottom,
  bottomThreshold = ACTIVITY_BOTTOM_THRESHOLD,
}: ActivityFollowInput): ActivityFollowState {
  const isNearBottom = distanceFromBottom <= bottomThreshold;
  return {
    isFollowingLatest: isNearBottom,
    isNearBottom,
  };
}

export function getActivityFollowStateAfterJump(): ActivityFollowState {
  return {
    isFollowingLatest: true,
    isNearBottom: true,
  };
}
