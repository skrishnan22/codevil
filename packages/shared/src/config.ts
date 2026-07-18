import { z } from "zod";

export interface Config {
  endpoint: string;
  api_key: string;
  defaults: ConfigDefaults;
}

export interface ConfigDefaults {
  plan_model: string;
  exec_model: string;
  provider: string;
  max_time: string;
}

export const ConfigDefaultsSchema = z.object({
  plan_model: z.string().trim().min(1),
  exec_model: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  max_time: z.string().trim().min(1),
});

export const ConfigSchema = z.object({
  endpoint: z.string().url(),
  api_key: z.string().trim().min(1),
  defaults: ConfigDefaultsSchema,
});

export type ConfigDefaultsParsed = z.infer<typeof ConfigDefaultsSchema>;
export type ConfigParsed = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: ConfigDefaults = {
  plan_model: "deepseek-v4-flash",
  exec_model: "deepseek-v4-flash",
  provider: "opencode-go",
  max_time: "15m",
};
