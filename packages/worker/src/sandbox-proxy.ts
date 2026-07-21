import {
  getProviderOutboundAuthPolicy,
  PROVIDER_APIS,
  type ProviderApi,
} from "@codevil/shared";
import { resolveProviderCredential } from "./provider-credentials.js";
import { createCapabilityToken, verifyCapabilityToken } from "./capability-token.js";
import { workerLog } from "./logging.js";
import { collectWorkerSecretValues, type Env } from "./worker-env.js";

const TOKEN_TTL_SECONDS = 15 * 60;
const PROXY_TARGET_HEADER = "x-codevil-proxy-target";

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
}

/** Deliberately separate from LLM capabilities: it authorizes Git only. */
export interface SandboxGitProxyClaims {
  sessionId: string;
  primaryRepo: string;
}

/** Issue a short-lived, HMAC-authenticated sandbox-only capability. */
export async function createSandboxProxyToken(
  secret: string,
  claims: SandboxProxyClaims,
  now = Date.now(),
): Promise<string> {
  return createCapabilityToken(secret, { audience: "sandbox_llm", claims, nowSeconds: Math.floor(now / 1000), ttlSeconds: TOKEN_TTL_SECONDS });
}

export async function createSandboxGitProxyToken(secret: string, claims: SandboxGitProxyClaims, now = Date.now()): Promise<string> {
  if (!isRepoName(claims.primaryRepo)) throw new Error("Invalid primary Git repository");
  return createCapabilityToken(secret, { audience: "sandbox_git", claims, nowSeconds: Math.floor(now / 1000), ttlSeconds: TOKEN_TTL_SECONDS });
}

export interface SandboxProxyTelemetry {
  kind: "llm" | "git";
  provider?: string;
  api?: ProviderApi;
  operation?: "read" | "write";
  outcome: "success" | "rejected" | "failed";
  status: number;
  statusClass: string;
  durationMs: number;
}

export async function handleSandboxProxy(
  request: Request,
  env: Env,
  emit: (event: SandboxProxyTelemetry) => void = (event) => {
    workerLog(event.outcome === "failed" ? "ERROR" : "DEBUG", "sandbox.proxy", { proxy: event }, collectWorkerSecretValues(env));
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/sandbox-proxy/")) return null;
  const startedAt = Date.now();
  const response = await handleSandboxProxyRequest(request, env);
  const llm = url.pathname.match(/^\/sandbox-proxy\/sessions\/[^/]+\/llm\/([^/]+)\/([^/]+)/);
  const git = url.pathname.match(/^\/sandbox-proxy\/sessions\/[^/]+\/github\/[^/]+\/[^/]+(?:\.git)?\/(.*)$/);
  const event: SandboxProxyTelemetry = llm
    ? { kind: "llm", ...(safeTelemetryId(llm[1]) ? { provider: llm[1] } : {}), ...(isProviderApi(llm[2]) ? { api: llm[2] } : {}), outcome: proxyOutcome(response.status), status: response.status, statusClass: `${Math.floor(response.status / 100)}xx`, durationMs: Date.now() - startedAt }
    : { kind: "git", ...(git ? { operation: gitSmartHttpOperation(request, git[1]) } : {}), outcome: proxyOutcome(response.status), status: response.status, statusClass: `${Math.floor(response.status / 100)}xx`, durationMs: Date.now() - startedAt };
  try { emit(event); } catch { /* observability must not affect proxying */ }
  return response;
}

async function handleSandboxProxyRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
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
  // `url.*.insteadOf` can replace the GitHub host/path prefix, but it cannot
  // add a `.git` suffix. Accept that one canonical Git spelling as well as the
  // explicit `.git` spelling. Both are normalized by proxyGit before reaching
  // GitHub, and neither admits an arbitrary path outside smart HTTP.
  const git = url.pathname.match(/^\/sandbox-proxy\/sessions\/([^/]+)\/github\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/)
    ?? url.pathname.match(/^\/sandbox-proxy\/sessions\/([^/]+)\/github\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (git) {
    const [, sessionId, owner, repo, suffix = ""] = git;
    const claims = await verifyGitRequestToken(request, secret);
    if (!claims || claims.sessionId !== sessionId) return gitProxyUnauthorized();
    return proxyGit(request, env, claims, owner, repo, suffix);
  }
  return proxyError("Not found", 404);
}

function proxyOutcome(status: number): SandboxProxyTelemetry["outcome"] {
  if (status >= 200 && status < 400) return "success";
  return status >= 500 ? "failed" : "rejected";
}
function safeTelemetryId(value: string): boolean { return /^[A-Za-z0-9_-]{1,64}$/.test(value); }

async function proxyGit(request: Request, env: Env, claims: SandboxGitProxyClaims, owner: string, repo: string, suffix: string): Promise<Response> {
  if (!isRepoPart(owner) || !isRepoPart(repo) || !isSafeGitSuffix(suffix)) return proxyError("Invalid Git repository path", 400);
  const operation = gitSmartHttpOperation(request, suffix);
  if (!operation) return proxyError("Git operation is not allowed", 400);
  if (!gitCapabilityFromBasic(request.headers)) return gitProxyUnauthorized();
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
  const envelope = await verifyCapabilityToken<SandboxProxyClaims>(token, secret, { audience: "sandbox_llm", maxLifetimeSeconds: TOKEN_TTL_SECONDS });
  const claims = envelope?.claims;
  return claims && isSessionId(claims.sessionId) && typeof claims.provider === "string" && isProviderApi(claims.api) ? claims : undefined;
}
async function verifyGitRequestToken(request: Request, secret: string): Promise<SandboxGitProxyClaims | undefined> {
  const token = gitCapabilityFromBasic(request.headers);
  if (!token) return undefined;
  const envelope = await verifyCapabilityToken<SandboxGitProxyClaims>(token, secret, { audience: "sandbox_git", maxLifetimeSeconds: TOKEN_TTL_SECONDS });
  const claims = envelope?.claims;
  return claims && isSessionId(claims.sessionId) && isRepoName(claims.primaryRepo) ? claims : undefined;
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
  // `Connection` can name additional per-connection headers. Remove those
  // dynamically so a client cannot smuggle a future hop-by-hop header through
  // this proxy; only delete syntactically valid names to keep malformed input
  // from turning sanitization itself into a failed request.
  for (const name of source.get("connection")?.split(",") ?? []) {
    const header = name.trim().toLowerCase();
    if (/^[a-z0-9!#$%&'*+.^_|~-]+$/.test(header)) headers.delete(header);
  }
  // A Worker subrequest cannot forward client transport headers or Cloudflare
  // control headers. Git sends `connection: keep-alive`, so leaving these in
  // turns an otherwise valid smart-HTTP request into a thrown Worker fetch.
  for (const key of [
    "authorization", "x-api-key", "x-goog-api-key", "cf-aig-authorization", PROXY_TARGET_HEADER,
    "host", "content-length", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
    "te", "trailer", "transfer-encoding", "upgrade", "cache-control", "origin", "range", "x-forwarded-for",
  ]) headers.delete(key);
  for (const key of [...headers.keys()]) {
    if (key.startsWith("x-codevil-") || key.startsWith("cf-") || key.startsWith("cf_")) headers.delete(key);
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
function gitProxyUnauthorized(): Response {
  return Response.json(
    { error: "Unauthorized" },
    { status: 401, headers: { "www-authenticate": 'Basic realm="Codevil sandbox Git proxy"' } },
  );
}
function proxyError(error: string, status: number): Response { return Response.json({ error }, { status }); }
