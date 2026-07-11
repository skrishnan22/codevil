import type { Sandbox } from "@cloudflare/sandbox";
import { isTerminalState } from "@codevil/shared";

import type { SessionMeta } from "./types.js";

export function createPreviewToken(sessionId: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${sessionId.replace(/^ses_/, "ses-")}-${random}`;
}

export async function hashPreviewToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildPreviewUrl(options: {
  workerOrigin: string;
  previewOrigin: string | undefined;
  sessionId: string;
  token: string;
}): string {
  const origin = normalizeOrigin(options.previewOrigin ?? options.workerOrigin);
  const url = new URL(origin);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    url.pathname = `/sessions/${options.sessionId}/preview/${options.token}/`;
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  if (!options.previewOrigin || url.hostname.endsWith(".workers.dev")) {
    const workerUrl = new URL(normalizeOrigin(options.workerOrigin));
    workerUrl.pathname = `/sessions/${options.sessionId}/preview/${options.token}/`;
    workerUrl.search = "";
    workerUrl.hash = "";
    return workerUrl.toString();
  }

  url.hostname = `${options.token}.${url.hostname}`;
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function validatePreviewAccess(meta: SessionMeta, token: string): Response | null {
  if (!meta.preview_active || !meta.preview_port || !meta.preview_token_hash) {
    return new Response("Preview is not active.", { status: 404 });
  }

  if (isTerminalState(meta.state)) {
    return new Response("Preview session has ended.", { status: 410 });
  }

  return null;
}

export async function proxyPreviewRequest(
  request: Request,
  meta: SessionMeta,
  token: string,
  sandboxNamespace: DurableObjectNamespace<Sandbox>,
): Promise<Response> {
  const blocked = validatePreviewAccess(meta, token);
  if (blocked) return blocked;

  const tokenHash = await hashPreviewToken(token);
  if (tokenHash !== meta.preview_token_hash) {
    return new Response("Unknown preview token.", { status: 404 });
  }

  const originalUrl = new URL(request.url);
  const prefix = `/sessions/${meta.session_id}/preview/${token}`;
  const isPathBasedPreview = originalUrl.pathname.startsWith(prefix);
  const path = isPathBasedPreview
    ? originalUrl.pathname.slice(prefix.length) || "/"
    : originalUrl.pathname;
  const proxyUrl = new URL(path, "http://localhost");
  proxyUrl.search = originalUrl.search;

  const proxyRequest = new Request(proxyUrl, request);

  const { getSandbox } = await import("@cloudflare/sandbox");
  const sandbox = getSandbox(sandboxNamespace, meta.session_id);
  const previewPort = meta.preview_port!;
  const portedHeaders = rewriteHeadersForSandboxDevServer(proxyRequest.headers, {
    port: previewPort,
    publicHost: originalUrl.host,
    publicProto: originalUrl.protocol.replace(/:$/, ""),
  });
  portedHeaders.set("cf-container-target-port", String(previewPort));
  const portedRequest = new Request(proxyRequest, { headers: portedHeaders });
  const response = await fetchPreviewWithRetries(sandbox, portedRequest);

  if (response.status === 101) return response;

  const contentType = response.headers.get("content-type") ?? "";
  if (isPathBasedPreview && shouldRewritePathBasedPreviewBody(contentType)) {
    const html = await response.text();
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.delete("content-length");
    return new Response(rewritePathBasedPreviewBody(html, `${prefix}/`, contentType), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const patched = new Response(response.body, response);
  patched.headers.set("Cache-Control", "no-store");
  return patched;
}

/** Prefix for path-based preview URLs (`/sessions/.../preview/.../`). */
export function previewPathPrefix(sessionId: string, token: string): string {
  return `/sessions/${sessionId}/preview/${token}/`;
}

/**
 * Dev servers (notably Next.js 16) reject proxied requests whose Host is the
 * public preview domain. Point Host at the container port and preserve the
 * browser-facing host for frameworks that read X-Forwarded-*.
 */
export function rewriteHeadersForSandboxDevServer(
  headers: Headers,
  options: { port: number; publicHost: string; publicProto: string },
): Headers {
  const out = new Headers(headers);
  const localHost = `localhost:${options.port}`;
  const originalHost = headers.get("host");
  if (originalHost && originalHost !== localHost) {
    out.set("x-forwarded-host", originalHost);
  }
  if (options.publicProto) {
    out.set("x-forwarded-proto", options.publicProto);
  }
  out.set("host", localHost);
  return out;
}

/**
 * Patch path-based preview responses so same-origin URLs keep flowing through
 * `/sessions/.../preview/.../` instead of escaping to the worker root.
 */
export function injectPreviewBaseHref(html: string, baseHref: string): string {
  const normalizedBase = baseHref.endsWith("/") ? baseHref : `${baseHref}/`;
  const withBase = insertPreviewBaseHref(html, normalizedBase);
  return rewriteHtmlRootRelativePreviewUrls(withBase, normalizedBase);
}

export function rewritePathBasedPreviewBody(
  body: string,
  baseHref: string,
  contentType: string,
): string {
  if (contentType.toLowerCase().includes("text/html")) {
    return injectPreviewBaseHref(body, baseHref);
  }

  return rewriteRootRelativePreviewUrls(body, baseHref);
}

function insertPreviewBaseHref(html: string, normalizedBase: string): string {
  if (/<base\s[\s\S]*?\bhref\s*=/i.test(html)) return html;
  const tag = `<base href="${normalizedBase}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${tag}`);
  }
  return `${tag}${html}`;
}

function shouldRewritePathBasedPreviewBody(contentType: string): boolean {
  const type = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return [
    "text/html",
    "text/css",
    "text/javascript",
    "text/ecmascript",
    "application/javascript",
    "application/ecmascript",
    "application/x-javascript",
    "image/svg+xml",
  ].includes(type);
}

function rewriteHtmlRootRelativePreviewUrls(html: string, baseHref: string): string {
  const baseTags: string[] = [];
  const shielded = html.replace(/<base\b[^>]*>/gi, (tag) => {
    const index = baseTags.push(tag) - 1;
    return `__CODEVIL_PREVIEW_BASE_TAG_${index}__`;
  });

  const rewritten = rewriteRootRelativePreviewUrls(shielded, baseHref);
  return rewritten.replace(/__CODEVIL_PREVIEW_BASE_TAG_(\d+)__/g, (_match, rawIndex: string) => {
    const index = Number(rawIndex);
    return baseTags[index] ?? "";
  });
}

function rewriteRootRelativePreviewUrls(input: string, baseHref: string): string {
  const normalizedBase = baseHref.endsWith("/") ? baseHref : `${baseHref}/`;
  const quoted = input.replace(/(["'`])\/(?!\/)([^"'`\s<>)]*)/g, (_match, quote: string, tail: string) => {
    return `${quote}${prefixPreviewPath(`/${tail}`, normalizedBase)}`;
  });

  const cssUrls = quoted.replace(/url\(\s*\/(?!\/)([^'")\s]*)\s*\)/g, (_match, tail: string) => {
    return `url(${prefixPreviewPath(`/${tail}`, normalizedBase)})`;
  });

  return cssUrls.replace(/\bsrcset=(["'])(.*?)\1/gi, (_match, quote: string, value: string) => {
    return `srcset=${quote}${rewriteSrcsetValue(value, normalizedBase)}${quote}`;
  });
}

function rewriteSrcsetValue(value: string, baseHref: string): string {
  return value.split(",").map((candidate) => {
    const leading = candidate.match(/^\s*/)?.[0] ?? "";
    const trimmed = candidate.slice(leading.length);
    if (!trimmed.startsWith("/")) return candidate;

    const parts = trimmed.split(/(\s+)/);
    parts[0] = prefixPreviewPath(parts[0] ?? "", baseHref);
    return `${leading}${parts.join("")}`;
  }).join(",");
}

function prefixPreviewPath(path: string, baseHref: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) return path;

  const normalizedBase = baseHref.endsWith("/") ? baseHref : `${baseHref}/`;
  const baseWithoutSlash = normalizedBase.slice(0, -1);
  if (path === baseWithoutSlash || path.startsWith(normalizedBase)) return path;
  if (path === "/") return normalizedBase;
  return `${normalizedBase}${path.slice(1)}`;
}

function normalizeOrigin(origin: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(origin) ? origin : `https://${origin}`;
}

const PREVIEW_PROXY_RETRY_BACKOFF_MS = [0, 200, 500];
const PREVIEW_PROXY_MAX_ATTEMPTS = 3;

async function fetchPreviewWithRetries(
  sandbox: Sandbox,
  request: Request,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PREVIEW_PROXY_MAX_ATTEMPTS; attempt++) {
    const backoffMs = PREVIEW_PROXY_RETRY_BACKOFF_MS[attempt] ?? 500;
    if (backoffMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }

    try {
      const response = await sandbox.fetch(request);
      if (response.status === 101 || !isRetryablePreviewStatus(response.status)) {
        return response;
      }
      if (attempt === PREVIEW_PROXY_MAX_ATTEMPTS - 1) {
        return response;
      }
      await response.body?.cancel();
    } catch (error) {
      lastError = error;
      if (attempt === PREVIEW_PROXY_MAX_ATTEMPTS - 1) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Preview proxy failed.");
}

export function isRetryablePreviewStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}
