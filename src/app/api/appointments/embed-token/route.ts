import { NextResponse } from "next/server";

import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import {
  buildAppointmentsEmbedUrl,
  fetchAppointmentsEmbedToken,
  requireActiveArveraAppointmentsConnection,
  type AppointmentsEmbedMode,
} from "@/lib/integrations/arvera-appointments";

export async function GET(request: Request) {
  try {
    const ctx = await requireDbRole("agent");
    const { searchParams } = new URL(request.url);
    const mode = parseMode(searchParams.get("mode"));
    const origin = getPublicOrigin(request);
    const { config, apiToken } = await requireActiveArveraAppointmentsConnection(
      null,
      ctx.accountId,
    );
    const token = await fetchAppointmentsEmbedToken({
      config,
      apiToken,
      mode,
      origin,
    });

    return NextResponse.json({
      embed_token: token.embed_token,
      expires_in: token.expires_in,
      mode: token.mode,
      iframe_url: buildAppointmentsEmbedUrl({
        config,
        mode: token.mode,
        embedToken: token.embed_token,
      }),
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "UnauthorizedError" || err.name === "ForbiddenError")
    ) {
      return toErrorResponse(err);
    }
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}

function parseMode(value: string | null): AppointmentsEmbedMode {
  return value === "disponibles" ? "disponibles" : "calendario";
}

function getPublicOrigin(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();

  if (forwardedHost) {
    return `${forwardedProto || "https"}://${forwardedHost}`;
  }

  const host = request.headers.get("host")?.trim();
  if (host) {
    const protocol = new URL(request.url).protocol.replace(":", "") || "http";
    return `${protocol}://${host}`;
  }

  return "http://localhost:3000";
}
