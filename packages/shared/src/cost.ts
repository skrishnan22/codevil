import { z } from "zod";

export const CostInfoSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_cost_usd: z.number(),
});

export const GuardLimitsSchema = z.object({
  max_cost_usd: z.number(),
  max_time_seconds: z.number(),
  max_steps: z.number(),
});

export type CostInfo = z.infer<typeof CostInfoSchema>;
export type GuardLimits = z.infer<typeof GuardLimitsSchema>;

export const DEFAULT_GUARD_LIMITS: GuardLimits = {
  max_cost_usd: 2,
  max_time_seconds: 15 * 60,
  max_steps: 50,
};
