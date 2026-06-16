import { splitSetCookieHeader } from "better-auth/cookies";

export const GOOGLE_SOCIAL_SIGN_IN_PATH = "/api/auth/sign-in/google";
export const BETTER_AUTH_SOCIAL_SIGN_IN_PATH = "/api/auth/sign-in/social";

interface GoogleSocialSignInBody {
  provider: "google";
  callbackURL?: string;
  errorCallbackURL?: string;
}

export function buildGoogleSocialSignInRequest(request: Request): Request {
  const url = new URL(request.url);
  const callbackURL = url.searchParams.get("callbackURL") ?? undefined;
  const errorCallbackURL = url.searchParams.get("errorCallbackURL") ?? callbackURL;
  const body: GoogleSocialSignInBody = {
    provider: "google",
    ...(callbackURL ? { callbackURL } : {}),
    ...(errorCallbackURL ? { errorCallbackURL } : {}),
  };

  const headers = new Headers({
    "Content-Type": "application/json",
    Origin: url.origin,
  });
  const cookie = request.headers.get("Cookie");
  if (cookie) headers.set("Cookie", cookie);

  return new Request(new URL(BETTER_AUTH_SOCIAL_SIGN_IN_PATH, url.origin), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export async function googleSocialSignInRedirectResponse(signInResponse: Response): Promise<Response> {
  if (!signInResponse.ok) return signInResponse;

  let body: unknown;
  try {
    body = await signInResponse.json();
  } catch {
    return Response.json({ error: "Invalid sign-in response" }, { status: 502 });
  }

  if (!isRecord(body) || typeof body.url !== "string") {
    return Response.json({ error: "Missing social sign-in redirect URL" }, { status: 502 });
  }

  const headers = new Headers({
    Location: body.url,
    "Cache-Control": "no-store",
  });
  copySetCookieHeaders(signInResponse.headers, headers);

  return new Response(null, { status: 302, headers });
}

function copySetCookieHeaders(source: Headers, target: Headers): void {
  const getSetCookie = (source as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getSetCookie === "function"
    ? getSetCookie.call(source)
    : splitSetCookieHeader(source.get("Set-Cookie") ?? "");

  for (const cookie of cookies) {
    target.append("Set-Cookie", cookie);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
