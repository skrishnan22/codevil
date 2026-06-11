export type EmailProviderName = "none" | "resend";

export interface EmailProviderEnv {
  EMAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  CODEVIL_APP_NAME?: string;
}

export interface InviteEmailInput {
  invitationId: string;
  email: string;
  role: string;
  inviteUrl: string;
  invitedByName: string;
}

export interface InviteEmailContent {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type EmailDeliveryResult =
  | { provider: "none"; status: "not_configured" }
  | { provider: "resend"; status: "sent"; messageId: string }
  | { provider: "resend"; status: "failed"; error: string };

export interface EmailProvider {
  name: EmailProviderName;
  sendInvite(input: InviteEmailInput): Promise<EmailDeliveryResult>;
}

type Fetcher = typeof globalThis.fetch;

export function createEmailProvider(env: EmailProviderEnv): EmailProvider {
  if (
    env.EMAIL_PROVIDER === "resend" &&
    nonBlank(env.RESEND_API_KEY) &&
    nonBlank(env.RESEND_FROM)
  ) {
    return createResendEmailProvider({
      apiKey: env.RESEND_API_KEY,
      from: env.RESEND_FROM,
      appName: env.CODEVIL_APP_NAME ?? "Codevil",
      fetcher: globalThis.fetch,
    });
  }

  return noneEmailProvider;
}

export function buildInviteEmail(input: InviteEmailInput, appName: string): InviteEmailContent {
  const subject = `Join ${appName}`;
  const text = [
    `${input.invitedByName} invited you to join ${appName} as ${input.role}.`,
    "",
    `Accept the invite: ${input.inviteUrl}`,
    "",
    "If you were not expecting this invite, you can ignore this email.",
  ].join("\n");
  const html = [
    `<p>${escapeHtml(input.invitedByName)} invited you to join ${escapeHtml(appName)} as <strong>${escapeHtml(input.role)}</strong>.</p>`,
    `<p><a href="${escapeAttribute(input.inviteUrl)}">Accept invite</a></p>`,
    `<p>If you were not expecting this invite, you can ignore this email.</p>`,
  ].join("");

  return {
    to: input.email,
    subject,
    html,
    text,
  };
}

export function createResendEmailProvider(options: {
  apiKey: string;
  from: string;
  appName: string;
  fetcher: Fetcher;
}): EmailProvider {
  return {
    name: "resend",
    async sendInvite(input) {
      const email = buildInviteEmail(input, options.appName);
      let response: Response;
      try {
        response = await options.fetcher("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": "codevil/1.0",
            "Idempotency-Key": `codevil-invite-${input.invitationId}`,
          },
          body: JSON.stringify({
            from: options.from,
            to: [email.to],
            subject: email.subject,
            html: email.html,
            text: email.text,
          }),
        });
      } catch (error) {
        return {
          provider: "resend",
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }

      const body = await readJsonObject(response);
      if (!response.ok) {
        return {
          provider: "resend",
          status: "failed",
          error: errorMessage(body, response.status),
        };
      }

      return {
        provider: "resend",
        status: "sent",
        messageId: typeof body.id === "string" ? body.id : "",
      };
    },
  };
}

const noneEmailProvider: EmailProvider = {
  name: "none",
  async sendInvite() {
    return {
      provider: "none",
      status: "not_configured",
    };
  },
};

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = await response.json();
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function errorMessage(body: Record<string, unknown>, status: number): string {
  for (const key of ["message", "error", "name"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return `Resend request failed with status ${status}`;
}

function nonBlank(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
