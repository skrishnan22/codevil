export const SITE = {
  name: "Codevil",
  tagline: "Self-hosted AI coding agents that run in your cloud.",
  appUrl: "https://codevil-ui.pages.dev",
  repoUrl: "https://github.com/anomalyco/codevil",
  description:
    "Codevil is a self-hosted AI coding agent platform. Describe a task — Codevil plans, executes, verifies, and opens a pull request, all on your own Cloudflare account. Your code, your keys, your rules.",
} as const;

export const NAV_LINKS = [
  { label: "How it works", href: "/#how-it-works" },
  { label: "Features", href: "/#features" },
  { label: "Architecture", href: "/#architecture" },
  { label: "Self-host", href: "/#quickstart" },
  { label: "FAQ", href: "/#faq" },
] as const;

export const FOOTER_LINKS = [
  { label: "GitHub", href: SITE.repoUrl },
  { label: "Open the app", href: SITE.appUrl },
  { label: "Self-host guide", href: "/#quickstart" },
  { label: "Spec", href: "https://github.com/anomalyco/codevil/blob/main/SPEC.md" },
] as const;
