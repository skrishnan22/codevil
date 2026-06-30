import assert from "node:assert/strict";
import test from "node:test";

import {
  extractGithubRepoUrl,
  resolveRepoForExternalRequest,
} from "../dist/integrations/repo-resolution.js";

test("extractGithubRepoUrl normalizes supported GitHub URL forms", () => {
  assert.deepEqual(extractGithubRepoUrl("https://github.com/acme/app"), {
    repoUrl: "https://github.com/acme/app",
    repoSlug: "acme/app",
  });
  assert.deepEqual(extractGithubRepoUrl("http://github.com/acme/app.git"), {
    repoUrl: "https://github.com/acme/app",
    repoSlug: "acme/app",
  });
  assert.deepEqual(extractGithubRepoUrl("github.com/acme/app"), {
    repoUrl: "https://github.com/acme/app",
    repoSlug: "acme/app",
  });
});

test("extractGithubRepoUrl strips trailing punctuation and paths", () => {
  assert.deepEqual(extractGithubRepoUrl("please use https://github.com/acme/app/issues/12."), {
    repoUrl: "https://github.com/acme/app",
    repoSlug: "acme/app",
  });
  assert.deepEqual(extractGithubRepoUrl("(github.com/acme/app.git), thanks"), {
    repoUrl: "https://github.com/acme/app",
    repoSlug: "acme/app",
  });
});

test("resolveRepoForExternalRequest prefers explicit text then context over channel default", () => {
  assert.deepEqual(
    resolveRepoForExternalRequest({
      text: "run on github.com/acme/from-text",
      contextText: "mentioned github.com/acme/from-context",
      channelDefaultRepoUrl: "https://github.com/acme/default",
    }),
    {
      repoUrl: "https://github.com/acme/from-text",
      repoSlug: "acme/from-text",
    },
  );

  assert.deepEqual(
    resolveRepoForExternalRequest({
      text: "no repo here",
      contextText: "mentioned github.com/acme/from-context",
      channelDefaultRepoUrl: "https://github.com/acme/default",
    }),
    {
      repoUrl: "https://github.com/acme/from-context",
      repoSlug: "acme/from-context",
    },
  );
});

test("resolveRepoForExternalRequest falls back to valid channel default", () => {
  assert.deepEqual(
    resolveRepoForExternalRequest({
      text: "no repo here",
      channelDefaultRepoUrl: "https://github.com/acme/default",
    }),
    {
      repoUrl: "https://github.com/acme/default",
      repoSlug: "acme/default",
    },
  );
});

test("repo resolution returns null when no valid repo is present", () => {
  assert.equal(extractGithubRepoUrl("https://gitlab.com/acme/app"), null);
  assert.equal(
    resolveRepoForExternalRequest({
      text: "github.com/acme",
      contextText: "still no repo",
      channelDefaultRepoUrl: "not a repo",
    }),
    null,
  );
});
