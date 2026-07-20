import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

let hasSession = false;

vi.mock("better-auth/cookies", () => ({
  getSessionCookie: () => (hasSession ? "session-token" : null),
}));

const { middleware } = await import("./middleware");

beforeEach(() => {
  hasSession = false;
});

describe("middleware", () => {
  it("redirects a signed-in user off /login", async () => {
    hasSession = true;

    const res = await middleware(new NextRequest("https://app.test/login"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("redirects an unauthenticated user to /login", async () => {
    const res = await middleware(new NextRequest("https://app.test/dashboard"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    hasSession = true;

    const res = await middleware(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
  });

  it("passes through for a signed-in user on a protected page", async () => {
    hasSession = true;

    const res = await middleware(new NextRequest("https://app.test/dashboard"));

    expect(res.headers.get("location")).toBeNull();
  });
});
