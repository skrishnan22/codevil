import { createCloudflareSandboxProvider } from "./cloudflare.js";
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
}

export function configuredSandboxProviderName(env: Pick<SandboxProviderEnv, "SANDBOX_PROVIDER">): SandboxProviderName {
  const raw = env.SANDBOX_PROVIDER?.trim();
  if (!raw) return "cloudflare";
  const name = parseSandboxProviderName(raw);
  if (!name) throw new Error("Unsupported SANDBOX_PROVIDER");
  return name;
}

export function resolveSandboxProvider(env: SandboxProviderEnv, name: SandboxProviderName): SandboxProvider {
  if (name === "cloudflare") return createCloudflareSandboxProvider({ binding: env.Sandbox });
  throw new Error("E2B sandbox provider is not available");
}

export function sandboxProviderForMeta(env: SandboxProviderEnv, meta: { sandbox_provider?: string }): SandboxProvider {
  return resolveSandboxProvider(env, parseSandboxProviderName(meta.sandbox_provider) ?? "cloudflare");
}
