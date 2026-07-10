import type { LLMProviderDefinition } from "@codevil/shared";

export type CredentialValidation =
  | { status: "valid" }
  | { status: "invalid"; message: string }
  | { status: "unavailable"; message: string };

type ProviderValidationDefinition = Pick<LLMProviderDefinition, "displayName" | "validation">;

export type ProviderValidationFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Pick<Response, "status">>;

type TimerHandle = unknown;

export interface ProviderValidationOptions {
  timeoutMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

const DEFAULT_VALIDATION_TIMEOUT_MS = 10_000;

export async function validateProviderCredential(
  definition: ProviderValidationDefinition,
  key: string,
  fetcher: ProviderValidationFetcher = fetch,
  options: ProviderValidationOptions = {},
): Promise<CredentialValidation> {
  if (!definition.validation) {
    return {
      status: "unavailable",
      message: `Live credential validation is not available for ${definition.displayName}.`,
    };
  }

  const controller = new AbortController();
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  });
  let timer: TimerHandle;

  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimer(() => {
        controller.abort();
        reject(new Error("Provider validation deadline exceeded."));
      }, options.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS);
    });
    const response = await Promise.race([
      fetcher(definition.validation.url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          [definition.validation.header]: `${definition.validation.prefix}${key}`,
        },
        signal: controller.signal,
      }),
      deadline,
    ]);

    if (response.status >= 200 && response.status < 300) {
      return { status: "valid" };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        status: "invalid",
        message: `Invalid credential for ${definition.displayName}.`,
      };
    }

    return {
      status: "unavailable",
      message: `Unable to validate ${definition.displayName} (status ${response.status}).`,
    };
  } catch {
    return {
      status: "unavailable",
      message: `Unable to validate ${definition.displayName}.`,
    };
  } finally {
    clearTimer(timer!);
  }
}
