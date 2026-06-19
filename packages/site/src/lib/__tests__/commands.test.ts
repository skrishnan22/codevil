import { describe, expect, it } from "vitest";
import { DEPLOY_STEPS } from "../commands";

describe("DEPLOY_STEPS", () => {
  it("exports an array of steps with title and commands", () => {
    expect(Array.isArray(DEPLOY_STEPS)).toBe(true);
    expect(DEPLOY_STEPS.length).toBeGreaterThan(0);
    for (const step of DEPLOY_STEPS) {
      expect(typeof step.title).toBe("string");
      expect(step.title.length).toBeGreaterThan(0);
      expect(Array.isArray(step.commands)).toBe(true);
      expect(step.commands.length).toBeGreaterThan(0);
      for (const cmd of step.commands) {
        expect(typeof cmd).toBe("string");
        expect(cmd.length).toBeGreaterThan(0);
      }
    }
  });

  it("step 1 clones the repo and installs deps", () => {
    const step = DEPLOY_STEPS[0];
    expect(step.title).toMatch(/clone/i);
    const joined = step.commands.join("\n");
    expect(joined).toContain("git clone");
    expect(joined).toContain("pnpm install");
    expect(joined).toContain("wrangler login");
  });

  it("step 2 configures only the remaining manual and bootstrap secrets", () => {
    const step = DEPLOY_STEPS[1];
    const joined = step.commands.join("\n");
    expect(joined).toContain("GITHUB_PAT");
    expect(joined).toContain("GOOGLE_CLIENT_ID");
    expect(joined).toContain("GOOGLE_CLIENT_SECRET");
    expect(joined).toContain("CODEVIL_API_KEY");
    expect(joined).toContain("CODEVIL_SETUP_TOKEN");
    expect(joined).toContain("BETTER_AUTH_SECRET");
    expect(joined).toContain("cp packages/worker/.env.example packages/worker/.env.production");
    expect(joined).toContain("wrangler secret bulk .env.production");
    expect(joined).not.toContain("CODEVIL_LLM_KEY");
    expect(joined).not.toContain("LLM_API_KEY");
    expect(joined).not.toContain("LLM_PROVIDER");
  });

  it("step 3 deploys one Worker and applies D1 migrations", () => {
    const step = DEPLOY_STEPS[2];
    const joined = step.commands.join("\n");
    expect(joined).toContain("pnpm deploy");
    expect(joined).toContain("d1 migrations apply");
    expect(joined).not.toContain("pages deploy");
  });

  it("step 4 returns to the repo root and configures providers", () => {
    const step = DEPLOY_STEPS[3];
    const joined = step.commands.join("\n");
    expect(joined).toContain("cd ../..");
    expect(joined).toContain("pnpm providers");
    expect(joined.toLowerCase()).toContain("attempt");
    expect(joined.toLowerCase()).toContain("retry");
    expect(joined.toLowerCase()).toContain("skip");
    expect(joined.toLowerCase()).toContain("cancel");
  });

  it("step 5 configures Google OAuth for the deployed Worker URL", () => {
    const step = DEPLOY_STEPS[4];
    const joined = step.commands.join("\n").toLowerCase();
    expect(joined).toContain("origin");
    expect(joined).toContain("/api/auth/callback/google");
  });

  it("step 6 covers signing in, claiming the instance, and inviting the team", () => {
    const step = DEPLOY_STEPS[5];
    const joined = step.commands.join("\n").toLowerCase();
    expect(joined).toContain("sign in");
    expect(joined).toMatch(/invite|team/);
    expect(joined).toMatch(/claim|owner/);
  });
});
