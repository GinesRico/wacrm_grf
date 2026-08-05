import { auth } from "@/lib/better-auth/server";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { toNextJsHandler } from "better-auth/next-js";

const handler = toNextJsHandler(auth);

function clientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]?.trim() || "unknown";
  return (
    request.headers.get("x-real-ip") ||
    request.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

export const GET = handler.GET;

export async function POST(request: Request) {
  const url = new URL(request.url);
  const ip = clientIp(request);
  const isSignup = url.pathname.endsWith("/sign-up/email");
  const limit = checkRateLimit(
    `auth:${isSignup ? "signup" : "post"}:${ip}`,
    isSignup ? RATE_LIMITS.authSignup : RATE_LIMITS.auth,
  );

  if (!limit.success) return rateLimitResponse(limit);

  return handler.POST(request);
}
