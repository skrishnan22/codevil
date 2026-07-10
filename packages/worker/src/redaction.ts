const REDACTED = "[REDACTED]";
const UNAVAILABLE = "[UNAVAILABLE]";

const secretPatterns = [
  /sk-ant-api[0-9a-zA-Z_-]*/g,
  /sk-[a-zA-Z0-9_-]{12,}/g,
  /gh[pousr]_[a-zA-Z0-9_]{20,}/g,
  /(?:api[_-]?key|token|secret|password)=([^&\s]+)/gi,
];

import { isRecord, safePrimitiveString } from "@codevil/shared";

export function redactEvent<T>(event: T, exactSecrets: readonly string[]): T {
  try {
    return redactValue(event, normalizeSecrets(exactSecrets), new WeakMap()) as T;
  } catch {
    // Logging must never turn an application error into a second failure, or
    // fall back to an unredacted diagnostic path.
    return { redaction: UNAVAILABLE } as T;
  }
}

function redactValue(
  value: unknown,
  exactSecrets: readonly string[],
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === "string") return redactString(value, exactSecrets);
  if (value instanceof Error) return redactError(value, exactSecrets, seen);
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing) return existing;
    const redacted: unknown[] = [];
    seen.set(value, redacted);
    const descriptors = propertyDescriptors(value);
    if (!descriptors) return [UNAVAILABLE];
    const length = descriptors.length?.value;
    if (typeof length !== "number") return [UNAVAILABLE];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[index];
      if (!descriptor) continue;
      redacted[index] = redactDescriptorValue(descriptor, exactSecrets, seen);
    }
    return redacted;
  }
  if (isRecord(value)) {
    const existing = seen.get(value);
    if (existing) return existing;
    const redacted: Record<string, unknown> = {};
    seen.set(value, redacted);
    const descriptors = propertyDescriptors(value);
    if (!descriptors) return { redaction: UNAVAILABLE };
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      redacted[key] = sensitiveAttributeName.test(key)
        ? REDACTED
        : redactDescriptorValue(descriptor, exactSecrets, seen);
    }
    return redacted;
  }
  return value;
}

const sensitiveAttributeName = /(?:api[_-]?key|token|secret|password|authorization)/i;

function redactError(error: Error, exactSecrets: readonly string[], seen: WeakMap<object, unknown>): Error {
  const existing = seen.get(error);
  if (existing) return existing as Error;

  const descriptors = propertyDescriptors(error);
  const redacted = new Error(redactString(errorText(error, descriptors, "message"), exactSecrets));
  redacted.name = redactString(errorText(error, descriptors, "name"), exactSecrets);
  const stack = errorText(error, descriptors, "stack");
  if (stack !== UNAVAILABLE) redacted.stack = redactString(stack, exactSecrets);
  seen.set(error, redacted);
  if (!descriptors) {
    Object.defineProperty(redacted, "redaction", { value: UNAVAILABLE, enumerable: true });
    return redacted;
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "message" || key === "name" || key === "stack") continue;
    if (!descriptor.enumerable && key !== "cause") continue;
    const value = sensitiveAttributeName.test(key)
      ? REDACTED
      : redactDescriptorValue(descriptor, exactSecrets, seen);
    Object.defineProperty(redacted, key, {
      value,
      enumerable: descriptor.enumerable,
      configurable: true,
      writable: true,
    });
  }
  return redacted;
}

function propertyDescriptors(value: object): Record<string, PropertyDescriptor> | undefined {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return undefined;
  }
}

function redactDescriptorValue(
  descriptor: PropertyDescriptor,
  exactSecrets: readonly string[],
  seen: WeakMap<object, unknown>,
): unknown {
  return "value" in descriptor
    ? redactValue(descriptor.value, exactSecrets, seen)
    : UNAVAILABLE;
}

function errorText(
  error: Error,
  descriptors: Record<string, PropertyDescriptor> | undefined,
  key: "message" | "name" | "stack",
): string {
  const descriptor = descriptors?.[key] ?? inheritedDescriptor(error, key);
  if (!descriptor || !("value" in descriptor)) return UNAVAILABLE;
  return typeof descriptor.value === "string" ? descriptor.value : safePrimitiveString(descriptor.value);
}

function inheritedDescriptor(error: Error, key: string): PropertyDescriptor | undefined {
  try {
    let prototype: object | null = Object.getPrototypeOf(error);
    while (prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (descriptor) return descriptor;
      prototype = Object.getPrototypeOf(prototype);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function redactString(value: string, exactSecrets: readonly string[]): string {
  let redacted = value;
  for (const secret of exactSecrets) {
    redacted = redacted.split(secret).join(REDACTED);
  }

  for (const pattern of secretPatterns) {
    redacted = redacted.replace(pattern, (match, captured: string | undefined) => {
      if (captured) return match.slice(0, match.length - captured.length) + REDACTED;
      return REDACTED;
    });
  }

  return redacted;
}

function normalizeSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets.map((secret) => secret.trim()).filter(Boolean))];
}
