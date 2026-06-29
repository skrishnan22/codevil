import { redactEvent } from "../redaction.js";
import type { Tracer } from "@codevil/shared";

interface SandboxProvisioningTraceOptions<T> {
  tracer: Tracer;
  secrets: readonly string[];
  attributes: Record<string, unknown>;
  provision: () => Promise<T>;
}

export async function traceSandboxProvisioning<T>(
  options: SandboxProvisioningTraceOptions<T>,
): Promise<T> {
  const { tracer, secrets, attributes, provision } = options;

  return tracer.span(
    "sandbox.provision",
    { attributes },
    async () => {
      try {
        return await provision();
      } catch (error) {
        throw redactedProvisioningError(error, secrets);
      }
    },
  );
}

function redactedProvisioningError(error: unknown, secrets: readonly string[]): Error {
  const attributes = redactEvent(provisioningErrorAttributes(error), secrets);
  const redacted = new Error(String(attributes.message));
  redacted.name = String(attributes.name ?? "Error");
  if (typeof attributes.stack === "string") redacted.stack = attributes.stack;

  for (const [key, value] of Object.entries(attributes)) {
    if (key === "name" || key === "message" || key === "stack") continue;
    Object.defineProperty(redacted, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return redacted;
}

function provisioningErrorAttributes(error: unknown): Record<string, unknown> {
  const structured = typeof error === "object" && error !== null
    ? Object.fromEntries(Object.entries(error))
    : {};

  return {
    ...structured,
    name: error instanceof Error ? error.name : undefined,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}
