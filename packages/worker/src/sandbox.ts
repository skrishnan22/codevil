import type { Sandbox } from "@cloudflare/sandbox";

import type {
  DOToCLIEvent,
  SandboxToDOMessage,
} from "@codevil/shared";

export interface SandboxProcessEnvOptions {
  wsUrl: string;
  apiKey: string;
  provider: string;
}

export interface ProvisionSandboxOptions extends SandboxProcessEnvOptions {
  binding: DurableObjectNamespace<Sandbox>;
  sessionId: string;
  llmKey?: string;
}

export interface SandboxRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

const DEFAULT_SANDBOX_RETRY_ATTEMPTS = 12;
const DEFAULT_SANDBOX_RETRY_DELAY_MS = 2_000;
const MAX_SANDBOX_RETRY_DELAY_MS = 15_000;

export function buildSandboxWebSocketUrl(workerUrl: string, sessionId: string): string {
  const url = new URL(`/sessions/${sessionId}/sandbox/ws`, workerUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

export function sandboxProcessEnv(options: SandboxProcessEnvOptions): Record<string, string> {
  return {
    CODEVIL_DO_WS_URL: options.wsUrl,
    CODEVIL_API_KEY: options.apiKey,
    CODEVIL_WORKSPACE: "/workspace",
    CODEVIL_PROVIDER: options.provider,
    CODEVIL_LLM_KEY_FILE: "/run/secrets/llm_key",
  };
}

export async function provisionSandbox(options: ProvisionSandboxOptions): Promise<void> {
  const { getSandbox } = await import("@cloudflare/sandbox");
  const sandbox = getSandbox(options.binding, options.sessionId);

  await retrySandboxOperation(() => sandbox.mkdir("/run/secrets", { recursive: true }));

  const llmKey = options.llmKey;
  if (llmKey) {
    await retrySandboxOperation(() => sandbox.writeFile("/run/secrets/llm_key", llmKey));
  }

  const env = sandboxProcessEnv(options);
  await retrySandboxOperation(() => sandbox.writeFile(
    "/run/secrets/env.json",
    JSON.stringify(env),
  ));

  await retrySandboxOperation(() => sandbox.startProcess(
    "node /app/packages/sandbox-image/dist/index.js",
    {
      cwd: "/workspace",
      env,
      processId: "codevil-agent",
      autoCleanup: true,
    },
  ));
}

export async function retrySandboxOperation<T>(
  operation: () => Promise<T>,
  options: SandboxRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_SANDBOX_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_SANDBOX_RETRY_DELAY_MS;
  const sleep = options.sleep ?? sleepFor;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientSandboxError(error)) {
        throw error;
      }

      await sleep(retryDelay(baseDelayMs, attempt));
    }
  }

  throw lastError;
}

function retryDelay(baseDelayMs: number, attempt: number): number {
  return Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_SANDBOX_RETRY_DELAY_MS);
}

function isTransientSandboxError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return message.includes("503")
    || message.includes("temporarily unavailable")
    || message.includes("no container instance")
    || message.includes("currently provisioning")
    || message.includes("failed to create session")
    || message.includes("failed to start container")
    || message.includes("container suddenly disconnected");
}

function sleepFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function readProcessLogs(
  binding: DurableObjectNamespace<Sandbox>,
  sessionId: string,
  processId: string,
): Promise<{ stdout: string; stderr: string } | null> {
  try {
    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandbox = getSandbox(binding, sessionId);
    return await sandbox.getProcessLogs(processId);
  } catch {
    return null;
  }
}

export function mapSandboxMessageToCLIEvents(message: SandboxToDOMessage): DOToCLIEvent[] {
  switch (message.type) {
    case "clone_started":
    case "clone_complete":
    case "verification_started":
    case "verification_retrying":
      return [];
    case "status":
      return [{ type: "status", message: message.message }];
    case "clone_progress":
      return [{ type: "clone_progress", line: message.line }];
    case "agent_event":
      return [{ type: "agent_event", event: message.event }];
    case "agent_turn_complete":
    case "create_pr_request":
    case "plan_ready":
    case "consolidation_complete":
    case "consolidation_failed":
      return [];
    case "execution_complete":
      return [{ type: "status", message: "Execution completed. Creating pull request." }];
    case "verification_failed":
      return [{
        type: "verification_failed",
        attempts: message.attempts,
        last_error: message.last_error,
      }];
    case "credential_request":
      return [{ type: "status", message: `Credential requested for ${message.host}.` }];
    case "branch_pushed":
      return [{ type: "status", message: `Branch pushed: ${message.branch}.` }];
    case "pr_created":
      return [{ type: "complete", pr_url: message.url }];
    case "preview_starting":
      return [{ type: "preview_starting", command: message.command, port: message.port }];
    case "preview_ready":
      return [{ type: "status", message: `Preview ready on port ${message.port}.` }];
    case "preview_error":
      return [{ type: "preview_error", message: message.message }];
    case "preview_stopped":
      return [{ type: "preview_stopped" }];
    case "preview_apps":
      return [{ type: "preview_apps", apps: message.apps }];
    case "error":
      return [{ type: "error", message: message.message }];
    default:
      return [];
  }
}
