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
      "pnpm exec wrangler login",
    ],
  },
  {
    title: "Prepare and upload deployment secrets",
    commands: [
      "cp packages/worker/.env.example packages/worker/.env.production",
      "# Add: GITHUB_PAT, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET",
      "# Generate independently: CODEVIL_API_KEY, CODEVIL_SETUP_TOKEN, BETTER_AUTH_SECRET",
      "# Do not upload while any REPLACE_ME placeholder remains",
      "cd packages/worker",
      "pnpm exec wrangler secret bulk .env.production",
    ],
  },
  {
    title: "Deploy and apply remote migrations",
    commands: [
      "cd ../..",
      "pnpm deploy",
      "cd packages/worker",
      "pnpm exec wrangler d1 migrations apply DB --remote",
      "# → UI and API are live together at the Worker URL",
    ],
  },
  {
    title: "Configure LLM providers",
    commands: [
      "cd ../..",
      "pnpm providers",
      "# Hidden prompts collect keys and attempt validation for each selected provider",
      "# If validation is unavailable, explicitly retry, skip validation, or cancel",
      "# Accepted provider keys upload directly as Worker secrets",
      "# Rerun this command whenever you add or rotate a provider key",
      "# Provider keys are not stored in D1 or project files",
    ],
  },
  {
    title: "Configure Google OAuth",
    commands: [
      "# Add the deployed Worker origin as an authorized JavaScript origin",
      "# Add <worker-origin>/api/auth/callback/google as an authorized redirect URI",
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
