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
  plan_model: "gpt-5.4",
  exec_model: "gpt-5.4",
  provider: "openai",
  max_cost: "$2",
  max_time: "15m",
  max_steps: 50,
};
