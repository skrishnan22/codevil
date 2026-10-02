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
  plan_model: "deepseek-v4-flash",
  exec_model: "deepseek-v4-flash",
  provider: "opencode-go",
  max_time: "30m",
};
