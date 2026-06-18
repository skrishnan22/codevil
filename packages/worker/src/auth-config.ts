export const AUTH_SESSION_EXPIRES_IN_SECONDS = 14 * 24 * 60 * 60;
export const AUTH_SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;

export interface AuthConfigEnv {
  DB: D1Database;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  CODEVIL_WEB_ORIGIN?: string;
}

export interface CodevilAuthOptions {
  database: D1Database;
  baseURL: string;
  secret: string;
  socialProviders: {
    google: {
      clientId: string;
      clientSecret: string;
    };
  };
  session: {
    expiresIn: number;
    updateAge: number;
  };
  advanced?: {
    defaultCookieAttributes?: {
      sameSite: "none";
      secure: true;
    };
  };
  account?: {
    skipStateCookieCheck: true;
  };
  trustedOrigins?: string[];
}

const REQUIRED_AUTH_KEYS = [
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const;

type RequiredAuthKey = typeof REQUIRED_AUTH_KEYS[number];

export function missingAuthConfigKeys(env: Partial<AuthConfigEnv>): RequiredAuthKey[] {
  return REQUIRED_AUTH_KEYS.filter((key) => {
    const value = env[key];
    return typeof value !== "string" || value.trim().length === 0;
  });
}

export function configuredWebOrigins(env: Pick<AuthConfigEnv, "CODEVIL_WEB_ORIGIN">): string[] {
  return (env.CODEVIL_WEB_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function buildAuthOptions(env: AuthConfigEnv): CodevilAuthOptions {
  const missing = missingAuthConfigKeys(env);
  if (missing.length > 0) {
    throw new Error(`Missing auth config: ${missing.join(", ")}`);
  }

  const baseURL = env.BETTER_AUTH_URL!.replace(/\/$/, "");
  const trustedOrigins = configuredWebOrigins(env);
  const crossSiteCookieAttributes = needsCrossSiteCookies(baseURL, trustedOrigins)
    ? { sameSite: "none" as const, secure: true as const }
    : null;

  return {
    database: env.DB,
    baseURL,
    secret: env.BETTER_AUTH_SECRET!,
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
      },
    },
    session: {
      expiresIn: AUTH_SESSION_EXPIRES_IN_SECONDS,
      updateAge: AUTH_SESSION_UPDATE_AGE_SECONDS,
    },
    ...(crossSiteCookieAttributes
      ? { advanced: { defaultCookieAttributes: crossSiteCookieAttributes } }
      : {}),
    ...(crossSiteCookieAttributes
      ? { account: { skipStateCookieCheck: true as const } }
      : {}),
    ...(trustedOrigins.length > 0 ? { trustedOrigins } : {}),
  };
}

function needsCrossSiteCookies(baseURL: string, webOrigins: string[]): boolean {
  const base = parseOrigin(baseURL);
  if (!base || base.protocol !== "https:") return false;

  return webOrigins.some((origin) => {
    const web = parseOrigin(origin);
    return Boolean(web && web.protocol === "https:" && siteKey(web.hostname) !== siteKey(base.hostname));
  });
}

function parseOrigin(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function siteKey(hostname: string): string {
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
}
