import type { SqlStatement } from "../session-directory.js";
import { channelByExternalIdSelect } from "./store.js";

export interface ResolvedRepo {
  repoUrl: string;
  repoSlug: string;
}

export interface RepoResolutionInput {
  text?: string | null;
  contextText?: string | null;
  channelDefaultRepoUrl?: string | null;
}

const OWNER_REPO_SEGMENT = "([A-Za-z0-9_.-]+)\\/([A-Za-z0-9_.-]+)";
const GITHUB_REPO_PATTERNS = [
  new RegExp(`(?:https?:\\/\\/)?github\\.com\\/${OWNER_REPO_SEGMENT}(?:\\.git)?(?:[\\/?#][^\\s<>)\\],;]*)?`, "i"),
  new RegExp(`git@github\\.com:${OWNER_REPO_SEGMENT}(?:\\.git)?`, "i"),
];

export function extractGithubRepoUrl(text: string | null | undefined): ResolvedRepo | null {
  if (!text) return null;

  for (const pattern of GITHUB_REPO_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;

    const owner = match[1];
    const repo = match[2].replace(/\.git$/i, "").replace(/[.,;:!?]+$/, "");
    if (!owner || !repo) continue;

    return {
      repoUrl: `https://github.com/${owner}/${repo}`,
      repoSlug: `${owner}/${repo}`,
    };
  }

  return null;
}

export function resolveRepoForExternalRequest(input: RepoResolutionInput): ResolvedRepo | null {
  return (
    extractGithubRepoUrl(input.text) ??
    extractGithubRepoUrl(input.contextText) ??
    extractGithubRepoUrl(input.channelDefaultRepoUrl)
  );
}

export function channelDefaultRepoLookup(integrationId: string, externalChannelId: string): SqlStatement {
  return channelByExternalIdSelect(integrationId, externalChannelId);
}
