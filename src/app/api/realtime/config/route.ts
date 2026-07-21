import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function read(name: string, fallback?: string): string | undefined {
  return process.env[name] || (fallback ? process.env[fallback] : undefined);
}

export async function GET() {
  const key = read("NEXT_PUBLIC_SOKETI_APP_KEY");
  const host = read("NEXT_PUBLIC_SOKETI_HOST", "SOKETI_HOST");
  if (!key || !host) {
    return NextResponse.json(
      { error: "Soketi public config is not configured." },
      { status: 503 },
    );
  }

  const portValue = read("NEXT_PUBLIC_SOKETI_PORT", "SOKETI_PORT");
  const tlsValue = read("NEXT_PUBLIC_SOKETI_TLS", "SOKETI_TLS");

  return NextResponse.json(
    {
      key,
      host,
      port: portValue ? Number(portValue) : undefined,
      forceTLS: tlsValue !== "false",
      cluster: process.env.NEXT_PUBLIC_SOKETI_CLUSTER ?? "mt1",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
