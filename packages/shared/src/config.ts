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

export const DEFAULT_CONFIG: ConfigDefaults = {
  plan_model: "kimi-k2.6",
  exec_model: "kimi-k2.6",
  provider: "opencode-go",
  max_time: "15m",
};
