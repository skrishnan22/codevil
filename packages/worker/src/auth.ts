import { betterAuth } from "better-auth";
import { buildAuthOptions, type AuthConfigEnv } from "./auth-config.js";

export function createCodevilAuth(env: AuthConfigEnv) {
  return betterAuth(buildAuthOptions(env));
}
