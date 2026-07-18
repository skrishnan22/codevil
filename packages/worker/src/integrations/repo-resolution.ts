export interface ResolvedGithubRepo {
  repoUrl: string;
  repoSlug: string;
}

const GITHUB_REPO_CANDIDATE = /(?:https?:\/\/)?github\.com\/[^\s<>"']+/gi;
const GITHUB_SSH_REPO_CANDIDATE = /git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)}\]]+$/;
const REPO_PART = /^[A-Za-z0-9_.-]+$/;

export function extractGithubRepoUrl(text: string | null | undefined): ResolvedGithubRepo | null {
  if (!text) return null;

  for (const match of text.matchAll(GITHUB_SSH_REPO_CANDIDATE)) {
    const resolved = normalizeGithubRepoParts(match[1], match[2]);
    if (resolved) return resolved;
  }

  for (const match of text.matchAll(GITHUB_REPO_CANDIDATE)) {
    const resolved = normalizeGithubRepoCandidate(match[0]);
    if (resolved) return resolved;
  }

  return null;
}

export function resolveRepoForExternalRequest({
  text,
  contextText,
  channelDefaultRepoUrl,
}: {
  text?: string | null;
  contextText?: string | null;
  channelDefaultRepoUrl?: string | null;
}): ResolvedGithubRepo | null {
  return (
    extractGithubRepoUrl(text) ??
    (contextText ? extractGithubRepoUrl(contextText) : null) ??
    (channelDefaultRepoUrl ? extractGithubRepoUrl(channelDefaultRepoUrl) : null)
  );
}

function normalizeGithubRepoCandidate(rawCandidate: string): ResolvedGithubRepo | null {
  const candidate = rawCandidate.replace(TRAILING_PUNCTUATION, "");
  const urlText = candidate.startsWith("http://") || candidate.startsWith("https://")
    ? candidate
    : `https://${candidate}`;

  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return null;
  }

  if (url.hostname.toLowerCase() !== "github.com") return null;

  const [owner, rawRepo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !rawRepo) return null;

  return normalizeGithubRepoParts(owner, rawRepo);
}

function normalizeGithubRepoParts(owner: string, rawRepo: string): ResolvedGithubRepo | null {
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!isValidGithubPart(owner) || !isValidGithubPart(repo)) return null;
  return {
    repoUrl: `https://github.com/${owner}/${repo}`,
    repoSlug: `${owner}/${repo}`,
  };
}

function isValidGithubPart(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && REPO_PART.test(value);
}
