import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

const AUTH_PATHS = ["/login", "/signup", "/forgot-password"];
const PROTECTED_PATHS = [
  "/dashboard",
  "/inbox",
  "/contacts",
  "/pipelines",
  "/broadcasts",
  "/automations",
  "/flows",
  "/agents",
  "/settings",
  "/payments",
  "/appointments",
  "/notifications",
  "/platform",
];

export async function middleware(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  const pathname = request.nextUrl.pathname;

  if (sessionCookie && AUTH_PATHS.includes(pathname)) {
    const url = request.nextUrl.clone();
    const inviteToken = request.nextUrl.searchParams.get("invite");
    const nextPath = request.nextUrl.searchParams.get("next");

    if (inviteToken && (pathname === "/login" || pathname === "/signup")) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`;
      url.search = "";
    } else if (nextPath?.startsWith("/") && !nextPath.startsWith("//")) {
      url.pathname = nextPath;
      url.search = "";
    } else {
      url.pathname = "/dashboard";
      url.search = "";
    }
    return NextResponse.redirect(url);
  }

  if (
    !sessionCookie &&
    PROTECTED_PATHS.some((path) => pathname.startsWith(path))
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(url);
  }

  if (
    !sessionCookie &&
    pathname.startsWith("/api/whatsapp/") &&
    !pathname.includes("/webhook")
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
