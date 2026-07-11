import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPreviewUrl,
  injectPreviewBaseHref,
  isRetryablePreviewStatus,
  previewPathPrefix,
  rewriteHeadersForSandboxDevServer,
} from "../dist/orchestrator/preview.js";

test("buildPreviewUrl uses subdomain mode when CODEVIL_PREVIEW_ORIGIN is set", () => {
  const url = buildPreviewUrl({
    workerOrigin: "https://codevil.example.workers.dev",
    previewOrigin: "https://lexmora.app",
    sessionId: "ses_abc",
    token: "ses-abc-deadbeef",
  });

  assert.equal(url, "https://ses-abc-deadbeef.lexmora.app/");
});

test("buildPreviewUrl uses path mode on workers.dev without preview origin", () => {
  const url = buildPreviewUrl({
    workerOrigin: "https://codevil.example.workers.dev",
    previewOrigin: undefined,
    sessionId: "ses_abc",
    token: "ses-abc-deadbeef",
  });

  assert.equal(
    url,
    "https://codevil.example.workers.dev/sessions/ses_abc/preview/ses-abc-deadbeef/",
  );
});

test("injectPreviewBaseHref adds base tag under head for root-absolute assets", () => {
  const html = "<!doctype html><html><head><title>App</title></head><body></body></html>";
  const patched = injectPreviewBaseHref(html, previewPathPrefix("ses_abc", "tok"));

  assert.match(patched, /<base href="\/sessions\/ses_abc\/preview\/tok\/">/);
  assert.ok(patched.indexOf("<base") < patched.indexOf("<title>"));
});

test("injectPreviewBaseHref rewrites root-absolute preview URLs under the preview path", () => {
  const html = [
    "<!doctype html><html><head>",
    '<script type="module" src="/@vite/client"></script>',
    '<link rel="stylesheet" href="/src/main.css">',
    '<img srcset="/one.png 1x, /two.png 2x">',
    "<style>.hero{background:url('/assets/bg.png')}</style>",
    "<script>fetch('/api/data'); import('/src/main.tsx');</script>",
    "</head><body></body></html>",
  ].join("");

  const patched = injectPreviewBaseHref(html, previewPathPrefix("ses_abc", "tok"));

  assert.match(patched, /src="\/sessions\/ses_abc\/preview\/tok\/@vite\/client"/);
  assert.match(patched, /href="\/sessions\/ses_abc\/preview\/tok\/src\/main\.css"/);
  assert.match(patched, /srcset="\/sessions\/ses_abc\/preview\/tok\/one\.png 1x, \/sessions\/ses_abc\/preview\/tok\/two\.png 2x"/);
  assert.match(patched, /url\('\/sessions\/ses_abc\/preview\/tok\/assets\/bg\.png'\)/);
  assert.match(patched, /fetch\('\/sessions\/ses_abc\/preview\/tok\/api\/data'\)/);
  assert.match(patched, /import\('\/sessions\/ses_abc\/preview\/tok\/src\/main\.tsx'\)/);
});

test("injectPreviewBaseHref is a no-op when base already exists", () => {
  const html = '<html><head><base href="/"></head><body></body></html>';
  assert.equal(injectPreviewBaseHref(html, "/sessions/ses_abc/preview/tok/"), html);
});

test("rewriteHeadersForSandboxDevServer points Host at the container port", () => {
  const headers = new Headers({
    host: "ses-abc-deadbeef.lexmora.app",
    cookie: "session=abc",
  });

  const rewritten = rewriteHeadersForSandboxDevServer(headers, {
    port: 3001,
    publicHost: "ses-abc-deadbeef.lexmora.app",
    publicProto: "https",
  });

  assert.equal(rewritten.get("host"), "localhost:3001");
  assert.equal(rewritten.get("x-forwarded-host"), "ses-abc-deadbeef.lexmora.app");
  assert.equal(rewritten.get("x-forwarded-proto"), "https");
  assert.equal(rewritten.get("cookie"), "session=abc");
});

test("rewriteHeadersForSandboxDevServer leaves localhost Host unchanged", () => {
  const headers = new Headers({ host: "localhost:3001" });

  const rewritten = rewriteHeadersForSandboxDevServer(headers, {
    port: 3001,
    publicHost: "localhost:3001",
    publicProto: "http",
  });

  assert.equal(rewritten.get("host"), "localhost:3001");
  assert.equal(rewritten.get("x-forwarded-host"), null);
});

test("isRetryablePreviewStatus matches transient upstream failures", () => {
  assert.equal(isRetryablePreviewStatus(502), true);
  assert.equal(isRetryablePreviewStatus(503), true);
  assert.equal(isRetryablePreviewStatus(504), true);
  assert.equal(isRetryablePreviewStatus(500), false);
  assert.equal(isRetryablePreviewStatus(404), false);
});
