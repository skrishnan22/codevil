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
  const path = originalUrl.pathname.startsWith(prefix)
    ? originalUrl.pathname.slice(prefix.length) || "/"
    : originalUrl.pathname;
  const proxyUrl = new URL(path, "http://localhost");
  proxyUrl.search = originalUrl.search;

  const proxyRequest = new Request(proxyUrl, request);

  const { getSandbox } = await import("@cloudflare/sandbox");
  const sandbox = getSandbox(sandboxNamespace, meta.session_id);
  const portedHeaders = new Headers(proxyRequest.headers);
  portedHeaders.set("cf-container-target-port", String(meta.preview_port));
  const portedRequest = new Request(proxyRequest, { headers: portedHeaders });
  const response = await sandbox.fetch(portedRequest);

  if (response.status === 101) return response;

  const patched = new Response(response.body, response);
  patched.headers.set("Cache-Control", "no-store");
  return patched;
}

function normalizeOrigin(origin: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(origin) ? origin : `https://${origin}`;
}
