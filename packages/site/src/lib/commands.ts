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
    title: "Deploy the worker",
    commands: [
      "cd packages/worker",
      "wrangler deploy",
      "# → Deployed to https://codevil.<your-account>.workers.dev",
    ],
  },
  {
    title: "Store your secrets",
    commands: [
      "wrangler secret put CODEVIL_API_KEY   # CLI auth key you choose",
      "wrangler secret put GITHUB_PAT        # GitHub Personal Access Token",
      "wrangler secret put LLM_API_KEY       # Anthropic / OpenAI / etc.",
      "wrangler secret put LLM_PROVIDER      # \"anthropic\", \"openai\", ...",
    ],
  },
  {
    title: "Install and configure the CLI",
    commands: [
      "npx codevil init",
      "# → Enter your backend URL and API key",
      "# → Config saved to ~/.codevil/config",
    ],
  },
];
