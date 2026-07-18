const GITHUB_REPO_PART = /^[A-Za-z0-9_.-]+$/;

/**
 * Converts an accepted GitHub repository input into its canonical owner/repo
 * form. This is intentionally strict because it is used to scope credentials.
 */
export function normalizeGitHubRepoName(repo: string): string | undefined {
  const bare = repo.match(/^github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (bare) return githubRepoNameFromParts(bare[1], bare[2]);

  try {
    const url = new URL(repo);
    if (
      url.protocol !== "https:" || url.hostname !== "github.com" ||
      url.username || url.password || url.port || url.search || url.hash
    ) return undefined;
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    return match ? githubRepoNameFromParts(match[1], match[2]) : undefined;
  } catch {
    return undefined;
  }
}

function githubRepoNameFromParts(owner: string, repo: string): string | undefined {
  return isGitHubRepoPart(owner) && isGitHubRepoPart(repo) ? `${owner}/${repo}` : undefined;
}

function isGitHubRepoPart(value: string): boolean {
  return GITHUB_REPO_PART.test(value) && value !== "." && value !== "..";
}
