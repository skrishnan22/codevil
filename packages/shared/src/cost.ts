import { z } from "zod";

export const CostInfoSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_cost_usd: z.number(),
});

export type CostInfo = z.infer<typeof CostInfoSchema>;

export function zeroCost(): CostInfo {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_cost_usd: 0,
  };
}

export function addCost(left: CostInfo, right: CostInfo): CostInfo {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    total_cost_usd: Number((left.total_cost_usd + right.total_cost_usd).toFixed(6)),
  };
}
