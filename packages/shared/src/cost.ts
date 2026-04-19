export interface CostInfo {
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number;
}

export interface GuardLimits {
  max_cost_usd: number;
  max_time_seconds: number;
  max_steps: number;
}

export const DEFAULT_GUARD_LIMITS: GuardLimits = {
  max_cost_usd: 2,
  max_time_seconds: 15 * 60,
  max_steps: 50,
};
