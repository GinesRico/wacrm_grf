import { NextResponse } from "next/server";

import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { decrypt } from "@/lib/whatsapp/encryption";
import { getDefaultWhatsAppConfig } from "@/lib/whatsapp/config";
import { downloadMedia, getMediaUrl } from "@/lib/whatsapp/meta-api";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ mediaId: string }> },
) {
  try {
    const { mediaId } = await params;
    if (!mediaId) {
      return NextResponse.json({ error: "Media ID is required" }, { status: 400 });
    }

    const ctx = await getCurrentDbAccount().catch(() => null);
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const config = await getDefaultWhatsAppConfig(null, ctx.accountId);
    if (!config) {
      return NextResponse.json({ error: "WhatsApp not configured" }, { status: 400 });
    }

    const accessToken = decrypt(config.access_token);
    const mediaInfo = await getMediaUrl({ mediaId, accessToken });
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    });

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": contentType || mediaInfo.mimeType || "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (error) {
    console.error("Error in WhatsApp media GET:", error);
    return NextResponse.json({ error: "Failed to fetch media" }, { status: 500 });
  }
}
