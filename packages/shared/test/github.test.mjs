import assert from "node:assert/strict";
import test from "node:test";

import { normalizeGitHubRepoName } from "../dist/index.js";

test("normalizeGitHubRepoName accepts only canonical GitHub repository inputs", () => {
  for (const input of [
    "github.com/acme/app",
    "github.com/acme/app.git",
    "https://github.com/acme/app",
    "https://github.com/acme/app.git",
  ]) {
    assert.equal(normalizeGitHubRepoName(input), "acme/app");
  }
});

test("normalizeGitHubRepoName rejects unsafe or non-repository inputs", () => {
  for (const input of [
    "https://github.com/acme/app.git/extra",
    "https://github.com/acme/app?ref=main",
    "https://github.com/acme/..",
    "https://github.com@evil.example/acme/app.git",
    "https://gitlab.com/acme/app.git",
  ]) {
    assert.equal(normalizeGitHubRepoName(input), undefined, input);
  }
});
