import { normalizeGitHubRepoName } from "@codevil/shared";

export interface GitHubRepo {
  host: string;
  owner: string;
  repo: string;
}

export interface CreatePullRequestOptions {
  repo: string;
  token: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  draft?: boolean;
}

const TRANSIENT_PR_STATUSES = new Set([429, 500, 502, 503, 504]);
const PR_RETRY_DELAYS_MS = [500, 1_500, 3_000];
export { normalizeGitHubRepoName } from "@codevil/shared";

export function parseGitHubRepo(repoUrl: string): GitHubRepo | null {
  const normalized = normalizeGitHubRepoName(repoUrl);
  if (!normalized) return null;
  const [owner, repo] = normalized.split("/");
  return { host: "github.com", owner, repo };
}

export function buildCreatePullRequestRequest(options: CreatePullRequestOptions): {
  url: string;
  init: RequestInit;
} {
  const parsed = parseGitHubRepo(options.repo);
  if (!parsed) throw new Error("Only GitHub HTTPS repositories are supported");

  return {
    url: `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls`,
    init: {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
        "User-Agent": "codevil",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title: options.title,
        body: options.body,
        head: options.branch,
        base: options.baseBranch,
        draft: options.draft ?? true,
      }),
    },
  };
}

export async function createDraftPullRequest(options: CreatePullRequestOptions): Promise<string> {
  const { url, init } = buildCreatePullRequestRequest(options);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= PR_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await fetch(url, init);
      const body = await readGitHubResponseBody(response);

      if (response.ok) {
        if (typeof body.html_url !== "string") {
          throw new Error("GitHub PR creation response did not include html_url");
        }
        return body.html_url;
      }

      const message = formatGitHubError(response, body);
      lastError = new Error(`GitHub PR creation failed: ${message}`);
      if (!TRANSIENT_PR_STATUSES.has(response.status) || attempt === PR_RETRY_DELAYS_MS.length) {
        throw lastError;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === PR_RETRY_DELAYS_MS.length) throw lastError;
    }

    await sleep(PR_RETRY_DELAYS_MS[attempt]);
  }

  throw lastError ?? new Error("GitHub PR creation failed");
}

async function readGitHubResponseBody(response: Response): Promise<{ html_url?: unknown; message?: unknown }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => ({})) as Promise<{ html_url?: unknown; message?: unknown }>;
  }

  const text = await response.text().catch(() => "");
  return text ? { message: text } : {};
}

function formatGitHubError(response: Response, body: { message?: unknown }): string {
  const detail = typeof body.message === "string" && body.message.trim()
    ? body.message.trim()
    : response.statusText;
  return `${response.status} ${detail}`;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function normalizeRepoPath(path: string | undefined): string | null {
  if (!path) return null;
  const normalized = path.replace(/^\/+/, "").replace(/\.git$/, "");
  const [owner, repo, ...rest] = normalized.split("/");
  if (!owner || !repo || rest.length > 0) return null;
  return `${owner}/${repo}`;
}
