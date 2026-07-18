import { safeExceptionAttributes, type Tracer } from "@codevil/shared";
import { redactEvent } from "../redaction.js";

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
  const attributes = redactEvent(safeExceptionAttributes(error), secrets);
  const redacted = new Error(typeof attributes.error === "string" ? attributes.error : "[UNAVAILABLE]");
  redacted.name = typeof attributes.name === "string" ? attributes.name : "Error";
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
