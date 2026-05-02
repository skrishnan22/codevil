export interface Config {
  endpoint: string;
  api_key: string;
  defaults: ConfigDefaults;
}

export interface ConfigDefaults {
  plan_model: string;
  exec_model: string;
  provider: string;
  max_cost: string;
  max_time: string;
  max_steps: number;
}

export const DEFAULT_CONFIG: ConfigDefaults = {
  plan_model: "kimi-k2.6",
  exec_model: "kimi-k2.6",
  provider: "opencode-go",
  max_cost: "$2",
  max_time: "15m",
  max_steps: 50,
};
