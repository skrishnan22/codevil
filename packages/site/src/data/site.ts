export const SITE = {
  name: "Codevil",
  tagline: "Shared rooms where your team and an AI agent build code together.",
  appUrl: "https://codevil-ui.pages.dev",
  repoUrl: "https://github.com/anomalyco/codevil",
  description:
    "Codevil is a self-hosted AI coding agent platform. Start a room, point it at a repo, and your team watches the agent work in real time — direct it conversationally, annotate plans together, preview UI changes live, and ship a pull request. Runs on your own Cloudflare account.",
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
