export interface DeployStep {
  title: string;
  commands: string[];
}

export const DEPLOY_STEPS: DeployStep[] = [
  {
    title: "Clone and install",
    commands: [
      "git clone https://github.com/anomalyco/codevil.git",
      "cd codevil",
      "pnpm install",
    ],
  },
  {
    title: "Deploy the worker + web app",
    commands: [
      "cd packages/worker",
      "wrangler deploy",
      "# → API live at https://codevil.<your-account>.workers.dev",
      "cd ../web",
      "pnpm deploy",
      "# → App live at https://codevil-ui.pages.dev",
    ],
  },
  {
    title: "Store your secrets",
    commands: [
      "wrangler secret put CODEVIL_API_KEY     # CLI auth key",
      "wrangler secret put GITHUB_PAT          # GitHub Personal Access Token",
      "wrangler secret put LLM_API_KEY         # Anthropic / OpenAI / Kimi / ...",
      "wrangler secret put LLM_PROVIDER        # \"anthropic\", \"openai\", ...",
      "wrangler secret put BETTER_AUTH_SECRET  # session signing secret",
      "wrangler secret put GOOGLE_CLIENT_SECRET  # OAuth client secret",
    ],
  },
  {
    title: "Claim your instance and invite the team",
    commands: [
      "# Open the app URL in your browser",
      "# Sign in with Google → enter the setup token → become Owner",
      "# Invite teammates by email with owner / admin / developer / viewer roles",
    ],
  },
];
