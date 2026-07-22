import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getCurrentDbAccount: vi.fn(),
}));

vi.mock("./current-account", () => ({
  getCurrentDbAccount: h.getCurrentDbAccount,
}));

import {
  ForbiddenError,
  getCurrentAccount,
  requireRole,
  UnauthorizedError,
} from "./account";

const dbContext = {
  userId: "user-1",
  user: {
    id: "user-1",
    name: "Jane",
    email: "jane@example.com",
  },
  accountId: "acct-1",
  role: "admin" as const,
  account: {
    id: "acct-1",
    name: "Acme",
    owner_user_id: "user-1",
    status: "active",
    plan: "starter",
    max_users: 3,
    max_flows: 2,
    max_automations: 2,
    max_whatsapp_lines: 1,
    allow_ai: false,
    allow_api: false,
    allow_broadcasts: true,
    trial_ends_at: null,
    default_currency: "USD",
  },
  profile: {
    id: "profile-1",
    user_id: "user-1",
    full_name: "Jane",
    email: "jane@example.com",
    avatar_url: null,
    role: null,
    beta_features: [],
    account_id: "acct-1",
    account_role: "admin" as const,
  },
};

beforeEach(() => {
  h.getCurrentDbAccount.mockReset();
  h.getCurrentDbAccount.mockResolvedValue(dbContext);
});

describe("getCurrentAccount", () => {
  it("maps the Drizzle account context to the public account context", async () => {
    await expect(getCurrentAccount()).resolves.toMatchObject({
      userId: "user-1",
      accountId: "acct-1",
      role: "admin",
      account: { id: "acct-1", name: "Acme" },
    });
  });

  it("propagates UnauthorizedError when there is no session", async () => {
    h.getCurrentDbAccount.mockRejectedValueOnce(new UnauthorizedError());
    await expect(getCurrentAccount()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("requireRole", () => {
  it("allows a role at or above the requirement", async () => {
    await expect(requireRole("agent")).resolves.toMatchObject({
      role: "admin",
    });
  });

  it("rejects a role below the requirement", async () => {
    h.getCurrentDbAccount.mockResolvedValueOnce({
      ...dbContext,
      role: "viewer",
    });

    await expect(requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
  });
});
