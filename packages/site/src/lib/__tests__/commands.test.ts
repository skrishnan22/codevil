import { describe, expect, it } from "vitest";
import { DEPLOY_STEPS, type DeployStep } from "../commands";

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
  });

  it("step 2 deploys the worker with wrangler", () => {
    const step = DEPLOY_STEPS[1];
    const joined = step.commands.join("\n");
    expect(joined).toContain("cd packages/worker");
    expect(joined).toContain("wrangler deploy");
  });

  it("step 3 sets the four required secrets", () => {
    const step = DEPLOY_STEPS[2];
    const joined = step.commands.join("\n");
    expect(joined).toContain("wrangler secret put CODEVIL_API_KEY");
    expect(joined).toContain("wrangler secret put GITHUB_PAT");
    expect(joined).toContain("wrangler secret put LLM_API_KEY");
    expect(joined).toContain("wrangler secret put LLM_PROVIDER");
  });

  it("step 4 installs and configures the CLI", () => {
    const step = DEPLOY_STEPS[3];
    const joined = step.commands.join("\n");
    expect(joined).toContain("npx codevil init");
  });

  it("every step satisfies the DeployStep type", () => {
    for (const step of DEPLOY_STEPS) {
      const _: DeployStep = step;
      void _;
    }
  });
});
