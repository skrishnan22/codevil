import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCreatePullRequestRequest,
  credentialRequestAllowed,
  createDraftPullRequest,
  parseGitHubRepo,
} from "../dist/github.js";

test("parseGitHubRepo extracts owner and repo from https URLs", () => {
  assert.deepEqual(parseGitHubRepo("https://github.com/acme/private-app.git"), {
    host: "github.com",
    owner: "acme",
    repo: "private-app",
  });
});

test("credentialRequestAllowed accepts only the configured GitHub repo", () => {
  const sessionRepo = "https://github.com/acme/private-app.git";

  assert.equal(credentialRequestAllowed(sessionRepo, {
    type: "credential_request",
    request_id: "cred_1",
    protocol: "https",
    host: "github.com",
    path: "acme/private-app.git",
  }), true);

  assert.equal(credentialRequestAllowed(sessionRepo, {
    type: "credential_request",
    request_id: "cred_2",
    protocol: "https",
    host: "github.com",
    path: "other/private-app.git",
  }), false);
});

test("buildCreatePullRequestRequest creates a GitHub API draft PR request", () => {
  assert.deepEqual(buildCreatePullRequestRequest({
    repo: "https://github.com/acme/private-app.git",
    token: "ghp_secret",
    branch: "codevil/change",
    baseBranch: "main",
    title: "Change",
    body: "Plan",
  }), {
    url: "https://api.github.com/repos/acme/private-app/pulls",
    init: {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer ghp_secret",
        "Content-Type": "application/json",
        "User-Agent": "codevil",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title: "Change",
        body: "Plan",
        head: "codevil/change",
        base: "main",
        draft: true,
      }),
    },
  });
});

test("createDraftPullRequest retries transient GitHub gateway failures", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({ message: "Bad Gateway" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ html_url: "https://github.com/acme/private-app/pull/1" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const url = await createDraftPullRequest({
      repo: "https://github.com/acme/private-app.git",
      token: "ghp_secret",
      branch: "codevil/change",
      baseBranch: "main",
      title: "Change",
      body: "Plan",
    });

    assert.equal(url, "https://github.com/acme/private-app/pull/1");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
