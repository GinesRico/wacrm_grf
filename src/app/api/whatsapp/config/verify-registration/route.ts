import { and, asc, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { whatsappConfig } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { decrypt } from "@/lib/whatsapp/encryption";
import {
  getSubscribedApps,
  verifyPhoneNumber,
} from "@/lib/whatsapp/meta-api";

export async function GET(request: Request) {
  const ctx = await getCurrentDbAccount().catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  const [config] = await db
    .select()
    .from(whatsappConfig)
    .where(
      id
        ? and(eq(whatsappConfig.accountId, ctx.accountId), eq(whatsappConfig.id, id))
        : eq(whatsappConfig.accountId, ctx.accountId),
    )
    .orderBy(desc(whatsappConfig.isDefault), asc(whatsappConfig.createdAt))
    .limit(1);

  if (!config) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: "No WhatsApp configuration saved yet.",
    });
  }

  let accessToken: string;
  try {
    accessToken = decrypt(config.accessToken);
  } catch {
    return NextResponse.json({
      live: false,
      checks: {
        config_exists: true,
        token_decryptable: false,
      },
      message:
        "Stored access token can't be decrypted. Re-enter the token to repair.",
    });
  }

  const checks: {
    config_exists: boolean;
    token_decryptable: boolean;
    phone_metadata_ok: boolean;
    waba_subscribed_to_app: boolean | null;
    locally_marked_registered: boolean;
  } = {
    config_exists: true,
    token_decryptable: true,
    phone_metadata_ok: false,
    waba_subscribed_to_app: null,
    locally_marked_registered: config.registeredAt != null,
  };
  const errors: string[] = [];

  try {
    await verifyPhoneNumber({
      phoneNumberId: config.phoneNumberId,
      accessToken,
    });
    checks.phone_metadata_ok = true;
  } catch (err) {
    errors.push(
      `Phone metadata check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (config.wabaId) {
    try {
      const subs = await getSubscribedApps({
        wabaId: config.wabaId,
        accessToken,
      });
      checks.waba_subscribed_to_app = subs.length > 0;
      if (!checks.waba_subscribed_to_app) {
        errors.push("WABA has no subscribed apps. Re-save the configuration to subscribe.");
      }
    } catch (err) {
      errors.push(
        `WABA subscription check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    errors.push("No WABA ID on file. Add it in the form and re-save.");
  }

  const live =
    checks.phone_metadata_ok &&
    (checks.waba_subscribed_to_app ?? false) &&
    checks.locally_marked_registered;

  return NextResponse.json({
    live,
    checks,
    errors,
    last_registration_error: config.lastRegistrationError ?? null,
    registered_at: config.registeredAt?.toISOString() ?? null,
    subscribed_apps_at: config.subscribedAppsAt?.toISOString() ?? null,
  });
}
