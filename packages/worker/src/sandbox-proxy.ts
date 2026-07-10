import {
  getProviderOutboundAuthPolicy,
  PROVIDER_APIS,
  type ProviderApi,
} from "@codevil/shared";
import { resolveProviderCredential } from "./provider-credentials.js";
import type { Env } from "./worker-env.js";

const TOKEN_TTL_SECONDS = 15 * 60;
const PROXY_TARGET_HEADER = "x-codevil-proxy-target";
const TOKEN_VERSION = "v1";
const GIT_TOKEN_VERSION = "git1";

export interface SandboxProxyClaims {
  /**
   * Capability scope, checked against the immutable proxy path. This prevents a
   * capability from being used for another session/provider/API. The proxy has
   * no authenticated sandbox identity, so this is intentionally a bearer
   * capability: theft of the token itself remains the security boundary.
   */
  sessionId: string;
  provider: string;
  api: ProviderApi;
  exp: number;
}

/** Deliberately separate from LLM capabilities: it authorizes Git only. */
export interface SandboxGitProxyClaims {
  sessionId: string;
  primaryRepo: string;
  exp: number;
}

/** Issue a short-lived, HMAC-authenticated sandbox-only capability. */
export async function createSandboxProxyToken(
  secret: string,
  claims: Omit<SandboxProxyClaims, "exp">,
  now = Date.now(),
): Promise<string> {
  if (!secret.trim()) throw new Error("CODEVIL_PROXY_SIGNING_SECRET is not configured");
  const payload: SandboxProxyClaims = { ...claims, exp: Math.floor(now / 1000) + TOKEN_TTL_SECONDS };
  const encoded = base64url(JSON.stringify(payload));
  const signed = `${TOKEN_VERSION}.${encoded}`;
  return `${signed}.${await signature(secret, signed)}`;
}

export async function createSandboxGitProxyToken(secret: string, claims: Omit<SandboxGitProxyClaims, "exp">, now = Date.now()): Promise<string> {
  if (!secret.trim()) throw new Error("CODEVIL_PROXY_SIGNING_SECRET is not configured");
  if (!isRepoName(claims.primaryRepo)) throw new Error("Invalid primary Git repository");
  const payload: SandboxGitProxyClaims = { ...claims, exp: Math.floor(now / 1000) + TOKEN_TTL_SECONDS };
  const encoded = base64url(JSON.stringify(payload));
  const signed = `${GIT_TOKEN_VERSION}.${encoded}`;
  return `${signed}.${await signature(secret, signed)}`;
}

export async function handleSandboxProxy(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/sandbox-proxy/")) return null;
  const secret = env.CODEVIL_PROXY_SIGNING_SECRET?.trim();
  if (!secret) return proxyError("Sandbox proxy is not configured", 503);

  const llm = url.pathname.match(/^\/sandbox-proxy\/sessions\/([^/]+)\/llm\/([^/]+)\/([^/]+)(\/.*)$/);
  if (llm && request.method === "POST") {
    const [_, sessionId, provider, api, suffix] = llm;
    const claims = await verifyRequestToken(request, secret, "llm");
    if (!claims || claims.sessionId !== sessionId || claims.provider !== provider || claims.api !== api) return proxyError("Unauthorized", 401);
    if (!isProviderApi(api)) return proxyError("Invalid provider API", 400);
    return proxyLlm(request, env, claims, provider, api, suffix);
  }
  const git = url.pathname.match(/^\/sandbox-proxy\/sessions\/([^/]+)\/github\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/);
  if (git) {
    const [, sessionId, owner, repo, suffix = ""] = git;
    const claims = await verifyGitRequestToken(request, secret);
    if (!claims || claims.sessionId !== sessionId) return proxyError("Unauthorized", 401);
    return proxyGit(request, env, claims, owner, repo, suffix);
  }
  return proxyError("Not found", 404);
}

async function proxyGit(request: Request, env: Env, claims: SandboxGitProxyClaims, owner: string, repo: string, suffix: string): Promise<Response> {
  if (!isRepoPart(owner) || !isRepoPart(repo) || !isSafeGitSuffix(suffix)) return proxyError("Invalid Git repository path", 400);
  const operation = gitSmartHttpOperation(request, suffix);
  if (!operation) return proxyError("Git operation is not allowed", 400);
  if (!gitCapabilityFromBasic(request.headers)) return proxyError("Unauthorized", 401);
  if (operation === "write" && `${owner}/${repo}` !== claims.primaryRepo) return proxyError("Git write is not authorized for this repository", 403);
  const pat = env.GITHUB_PAT?.trim();
  if (!pat) return proxyError("GitHub credentials are not configured", 503);
  const upstream = new URL(`https://github.com/${owner}/${repo}.git${suffix ? `/${suffix}` : ""}`);
  upstream.search = new URL(request.url).search;
  const headers = cleanedHeaders(request.headers);
  headers.set("authorization", `Basic ${btoa(`x-access-token:${pat}`)}`);
  return fetch(upstream, { method: request.method, headers, body: request.body, redirect: "error" });
}

async function proxyLlm(request: Request, env: Env, claims: SandboxProxyClaims, provider: string, api: ProviderApi, suffix: string): Promise<Response> {
  const target = request.headers.get(PROXY_TARGET_HEADER);
  if (!target) return proxyError("Missing proxy target", 400);
  const targetUrl = safeHttpsUrl(target);
  const policy = targetUrl && getProviderOutboundAuthPolicy(provider, targetUrl.hostname, api);
  if (!targetUrl || !policy) return proxyError("Provider target is not allowed", 403);
  const key = resolveProviderCredential(env, provider);
  if (!key) return proxyError("Provider is not configured", 503);
  const upstream = appendSafeRelativePath(targetUrl, suffix, new URL(request.url).search);
  if (!upstream) return proxyError("Provider request path is not allowed", 400);
  // Defense in depth: path construction must never turn a vetted target into a
  // different authority before the Worker attaches the provider credential.
  if (upstream.origin !== targetUrl.origin) return proxyError("Provider request path is not allowed", 400);
  const headers = cleanedHeaders(request.headers);
  headers.set(policy.header, `${policy.prefix}${key}`);
  return fetch(upstream, { method: request.method, headers, body: request.body, redirect: "error" });
}

async function verifyRequestToken(request: Request, secret: string, kind: "llm"): Promise<SandboxProxyClaims | undefined> {
  const token = proxyToken(request.headers);
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [version, encoded, supplied] = parts;
  const signed = `${version}.${encoded}`;
  if (version !== TOKEN_VERSION || !encoded || !supplied || !await timingSafeEqual(await signature(secret, signed), supplied)) return undefined;
  try {
    const claims = JSON.parse(unbase64url(encoded)) as SandboxProxyClaims;
    if (!claims || !isSessionId(claims.sessionId) || typeof claims.provider !== "string" || !isProviderApi(claims.api) || !Number.isInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) return undefined;
    return claims;
  } catch { return undefined; }
}
async function verifyGitRequestToken(request: Request, secret: string): Promise<SandboxGitProxyClaims | undefined> {
  const token = gitCapabilityFromBasic(request.headers);
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [version, encoded, supplied] = parts;
  const signed = `${version}.${encoded}`;
  if (version !== GIT_TOKEN_VERSION || !encoded || !supplied || !await timingSafeEqual(await signature(secret, signed), supplied)) return undefined;
  try {
    const claims = JSON.parse(unbase64url(encoded)) as SandboxGitProxyClaims;
    return claims && isSessionId(claims.sessionId) && isRepoName(claims.primaryRepo) && Number.isInteger(claims.exp) && claims.exp > Math.floor(Date.now() / 1000) ? claims : undefined;
  } catch { return undefined; }
}
function gitCapabilityFromBasic(headers: Headers): string | undefined {
  const raw = headers.get("authorization")?.trim();
  const match = raw?.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (!match) return undefined;
  try { const decoded = atob(match[1]); const colon = decoded.indexOf(":"); return colon >= 0 && decoded.slice(0, colon) === "x-access-token" ? decoded.slice(colon + 1) || undefined : undefined; } catch { return undefined; }
}

function proxyToken(headers: Headers): string | undefined {
  for (const header of ["authorization", "x-api-key", "x-goog-api-key", "cf-aig-authorization"]) {
    const value = headers.get(header)?.trim();
    if (!value) continue;
    return value.replace(/^Bearer\s+/i, "");
  }
  return undefined;
}
function safeHttpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && (url.port === "" || url.port === "443")
      && !url.search
      && !url.hash
      ? url
      : undefined;
  } catch { return undefined; }
}
function cleanedHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const key of ["authorization", "x-api-key", "x-goog-api-key", "cf-aig-authorization", PROXY_TARGET_HEADER, "host", "content-length"]) headers.delete(key);
  for (const key of [...headers.keys()]) {
    if (key.startsWith("x-codevil-")) headers.delete(key);
  }
  return headers;
}
function isProviderApi(value: string): value is ProviderApi { return (PROVIDER_APIS as readonly string[]).includes(value); }
function isSessionId(value: unknown): value is string { return typeof value === "string" && /^ses_[a-zA-Z0-9_-]+$/.test(value); }
function isRepoPart(value: string): boolean { return /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== ".."; }
function isRepoName(value: unknown): value is string { const parts = typeof value === "string" ? value.split("/") : []; return parts.length === 2 && isRepoPart(parts[0]) && isRepoPart(parts[1]); }
function isSafeGitSuffix(value: string): boolean { return !value || (!value.includes("\\") && !/%2f|%5c/i.test(value) && value.split("/").every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..")); }

/**
 * Only Git smart-HTTP negotiation and pack transfer are proxyable. Keeping the
 * query string exact prevents a capability-bearing request from becoming a
 * general authenticated github.com fetch via duplicate or extra parameters.
 */
function gitSmartHttpOperation(request: Request, suffix: string): "read" | "write" | undefined {
  const search = new URL(request.url).search;
  if (request.method === "GET" && suffix === "info/refs") {
    if (search === "?service=git-upload-pack") return "read";
    if (search === "?service=git-receive-pack") return "write";
    return undefined;
  }
  if (request.method === "POST" && search === "") {
    if (suffix === "git-upload-pack") return "read";
    if (suffix === "git-receive-pack") return "write";
  }
  return undefined;
}

/**
 * Append Pi's request suffix without URL resolution. URL resolution would allow
 * a network-path or absolute reference to replace the vetted provider origin.
 */
function appendSafeRelativePath(target: URL, suffix: string, search: string): URL | undefined {
  if (!suffix.startsWith("/") || suffix.startsWith("//") || suffix.includes("\\") || /%2f|%5c/i.test(suffix)) return undefined;
  const path = suffix.slice(1);
  if (!path || path.includes("://")) return undefined;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) return undefined;
  const upstream = new URL(target.toString());
  upstream.pathname = `${target.pathname.replace(/\/$/, "")}/${parts.join("/")}`;
  upstream.search = search;
  return upstream;
}
function proxyError(error: string, status: number): Response { return Response.json({ error }, { status }); }
function base64url(value: string): string { return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function unbase64url(value: string): string { return atob(value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4)); }
async function signature(secret: string, value: string): Promise<string> { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return base64url(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))))); }
async function timingSafeEqual(a: string, b: string): Promise<boolean> { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
