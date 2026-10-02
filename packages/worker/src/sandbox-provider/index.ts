import { createCloudflareSandboxProvider } from "./cloudflare.js";
import { createE2BSandboxProvider } from "./e2b.js";
import { parseSandboxProviderName, type SandboxProvider, type SandboxProviderName } from "./types.js";

export type {
  SandboxHandle,
  SandboxLifecycleView,
  SandboxProvider,
  SandboxProviderName,
  SandboxRef,
  ShellResult,
} from "./types.js";
export { SandboxNotFoundError, parseSandboxProviderName } from "./types.js";

/** The slice of the Worker environment provider resolution needs. */
export interface SandboxProviderEnv {
  Sandbox: unknown;
  SANDBOX_PROVIDER?: string;
  E2B_API_KEY?: string;
  E2B_TEMPLATE_ID?: string;
  E2B_MAX_SANDBOX_SECONDS?: string;
}

const DEFAULT_E2B_TEMPLATE_ID = "codevil-sandbox";
/** Matches the E2B Hobby continuous-runtime limit. */
const DEFAULT_E2B_MAX_SANDBOX_SECONDS = 3600;

/** Lease cap in ms: a positive whole number of seconds, else the Hobby default. */
export function e2bMaxLeaseMs(env: Pick<SandboxProviderEnv, "E2B_MAX_SANDBOX_SECONDS">): number {
  const seconds = Math.floor(Number(env.E2B_MAX_SANDBOX_SECONDS));
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_E2B_MAX_SANDBOX_SECONDS) * 1000;
}

export function configuredSandboxProviderName(env: Pick<SandboxProviderEnv, "SANDBOX_PROVIDER">): SandboxProviderName {
  const raw = env.SANDBOX_PROVIDER?.trim();
  if (!raw) return "e2b";
  const name = parseSandboxProviderName(raw);
  if (!name) throw new Error("Unsupported SANDBOX_PROVIDER");
  return name;
}

export function resolveSandboxProvider(env: SandboxProviderEnv, name: SandboxProviderName): SandboxProvider {
  if (name === "cloudflare") return createCloudflareSandboxProvider({ binding: env.Sandbox });
  const apiKey = env.E2B_API_KEY?.trim();
  if (!apiKey) throw new Error("E2B_API_KEY is not configured");
  return createE2BSandboxProvider({
    apiKey,
    templateId: env.E2B_TEMPLATE_ID?.trim() || DEFAULT_E2B_TEMPLATE_ID,
    maxLeaseMs: e2bMaxLeaseMs(env),
  });
}

export function sandboxProviderForMeta(env: SandboxProviderEnv, meta: { sandbox_provider?: string }): SandboxProvider {
  return resolveSandboxProvider(env, parseSandboxProviderName(meta.sandbox_provider) ?? "cloudflare");
}
