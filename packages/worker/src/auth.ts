import { betterAuth } from "better-auth";
import { buildAuthOptions, type AuthConfigEnv } from "./auth-config.js";

export function createCodevilAuth(env: AuthConfigEnv, baseURL?: string) {
  return betterAuth(buildAuthOptions(env, baseURL));
}
