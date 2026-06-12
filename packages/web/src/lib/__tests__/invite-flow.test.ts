import { describe, expect, it } from "vitest";
import { shouldAutoAcceptInvite } from "../invite-flow";

describe("shouldAutoAcceptInvite", () => {
  it("auto-accepts a pending invite after OAuth when the user has no membership yet", () => {
    expect(shouldAutoAcceptInvite({
      invite: {
        status: "pending",
        invitation: {
          email: "alice@example.com",
          role: "developer",
          expires_at: "2026-06-25T00:00:00.000Z",
        },
      },
      auth: {
        authenticated: true,
        setupRequired: false,
        authConfigured: true,
        user: { id: "usr_1", email: "alice@example.com", name: "Alice" },
      },
      accepting: false,
      accepted: false,
      autoAcceptAttempted: false,
    })).toBe(true);
  });

  it("does not auto-accept before OAuth or once acceptance has started", () => {
    const invite = {
      status: "pending" as const,
      invitation: {
        email: "alice@example.com",
        role: "developer" as const,
        expires_at: "2026-06-25T00:00:00.000Z",
      },
    };

    expect(shouldAutoAcceptInvite({
      invite,
      auth: { authenticated: false, setupRequired: false, authConfigured: true },
      accepting: false,
      accepted: false,
      autoAcceptAttempted: false,
    })).toBe(false);

    expect(shouldAutoAcceptInvite({
      invite,
      auth: {
        authenticated: true,
        setupRequired: false,
        authConfigured: true,
        user: { id: "usr_1", email: "alice@example.com", name: "Alice" },
      },
      accepting: true,
      accepted: false,
      autoAcceptAttempted: false,
    })).toBe(false);
  });

  it("does not auto-accept existing active members or repeat a failed attempt", () => {
    expect(shouldAutoAcceptInvite({
      invite: {
        status: "pending",
        invitation: {
          email: "alice@example.com",
          role: "developer",
          expires_at: "2026-06-25T00:00:00.000Z",
        },
      },
      auth: {
        authenticated: true,
        setupRequired: false,
        authConfigured: true,
        user: { id: "usr_1", email: "alice@example.com", name: "Alice" },
        membership: { role: "developer", status: "active" },
      },
      accepting: false,
      accepted: false,
      autoAcceptAttempted: false,
    })).toBe(false);

    expect(shouldAutoAcceptInvite({
      invite: {
        status: "pending",
        invitation: {
          email: "alice@example.com",
          role: "developer",
          expires_at: "2026-06-25T00:00:00.000Z",
        },
      },
      auth: {
        authenticated: true,
        setupRequired: false,
        authConfigured: true,
        user: { id: "usr_1", email: "alice@example.com", name: "Alice" },
      },
      accepting: false,
      accepted: false,
      autoAcceptAttempted: true,
    })).toBe(false);
  });
});
