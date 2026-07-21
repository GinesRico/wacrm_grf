import { and, asc, desc, eq, ne } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { departments, whatsappConfig } from "@/db/schema";
import { getCurrentDbAccount, requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { assertCanCreateWhatsAppLine } from "@/lib/platform/entitlements";
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from "@/lib/whatsapp/meta-api";
import { decrypt, encrypt } from "@/lib/whatsapp/encryption";
import { publishRealtimeEvent } from "@/lib/realtime/soketi-server";

function serializeConfig(row: typeof whatsappConfig.$inferSelect) {
  return {
    id: row.id,
    label: row.label,
    waba_id: row.wabaId,
    phone_number_id: row.phoneNumberId,
    status: row.status,
    registered_at: row.registeredAt?.toISOString() ?? null,
    last_registration_error: row.lastRegistrationError,
    is_default: row.isDefault,
    department_id: row.departmentId,
  };
}

async function listConfigs(accountId: string, id?: string | null) {
  const where = id
    ? and(eq(whatsappConfig.accountId, accountId), eq(whatsappConfig.id, id))
    : eq(whatsappConfig.accountId, accountId);
  return db
    .select()
    .from(whatsappConfig)
    .where(where)
    .orderBy(desc(whatsappConfig.isDefault), asc(whatsappConfig.createdAt));
}

async function validateDepartment(accountId: string, departmentId: string | null) {
  if (!departmentId) return true;
  const [department] = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.accountId, accountId), eq(departments.id, departmentId)))
    .limit(1);
  return !!department;
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentDbAccount();
    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    const configs = await listConfigs(ctx.accountId, id);
    if (url.searchParams.get("list") === "1") {
      return NextResponse.json({ configs: configs.map(serializeConfig) });
    }

    if (configs.length === 0) {
      return NextResponse.json(
        {
          connected: false,
          reason: "no_config",
          message: "No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.",
        },
        { status: 200 },
      );
    }

    const config = configs[0];
    let accessToken: string;
    try {
      accessToken = decrypt(config.accessToken);
    } catch (err) {
      console.error("[whatsapp/config GET] Token decryption failed:", err);
      return NextResponse.json(
        {
          connected: false,
          reason: "token_corrupted",
          needs_reset: true,
          message:
            "The stored access token cannot be decrypted with the current ENCRYPTION_KEY. Click Reset Configuration below, then re-save.",
        },
        { status: 200 },
      );
    }

    try {
      const phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phoneNumberId,
        accessToken,
      });
      return NextResponse.json({
        connected: true,
        phone_info: phoneInfo,
        configs: configs.map(serializeConfig),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown Meta API error";
      console.error("[whatsapp/config GET] Meta API verification failed:", message);
      return NextResponse.json(
        {
          connected: false,
          reason: "meta_api_error",
          message: `Meta API rejected the credentials: ${message}`,
        },
        { status: 200 },
      );
    }
  } catch (error) {
    console.error("Error in WhatsApp config GET:", error);
    return NextResponse.json(
      { connected: false, reason: "unknown", message: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireDbRole("admin");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";

    if (action !== "make_default") {
      return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
    }

    const id = typeof body.id === "string" ? body.id : "";
    if (!id) {
      return NextResponse.json({ error: "id is required." }, { status: 400 });
    }

    const [target] = await db
      .select({ id: whatsappConfig.id })
      .from(whatsappConfig)
      .where(and(eq(whatsappConfig.accountId, ctx.accountId), eq(whatsappConfig.id, id)))
      .limit(1);

    if (!target) {
      return NextResponse.json({ error: "WhatsApp line not found." }, { status: 404 });
    }

    await db.transaction(async (tx) => {
      await tx
        .update(whatsappConfig)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(whatsappConfig.accountId, ctx.accountId));
      await tx
        .update(whatsappConfig)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(and(eq(whatsappConfig.accountId, ctx.accountId), eq(whatsappConfig.id, id)));
    });

    await publishRealtimeEvent("whatsapp_config.updated", {
      accountId: ctx.accountId,
      payload: { id },
    }).catch((error) => {
      console.warn("[realtime] failed to publish whatsapp_config.updated:", error);
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole("admin");
    const body = await request.json();
    const {
      id,
      label,
      phone_number_id,
      waba_id,
      access_token,
      verify_token,
      pin,
      is_default,
      department_id,
    } = body;

    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: "access_token and phone_number_id are required" },
        { status: 400 },
      );
    }

    if (pin !== undefined && pin !== null && pin !== "") {
      if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) {
        return NextResponse.json({ error: "PIN must be exactly 6 digits." }, { status: 400 });
      }
    }

    const departmentId =
      typeof department_id === "string" && department_id.trim()
        ? department_id.trim()
        : null;
    if (!(await validateDepartment(ctx.accountId, departmentId))) {
      return NextResponse.json(
        { error: "Selected department was not found." },
        { status: 400 },
      );
    }

    const [claimed] = await db
      .select({ accountId: whatsappConfig.accountId })
      .from(whatsappConfig)
      .where(
        and(
          eq(whatsappConfig.phoneNumberId, phone_number_id),
          ne(whatsappConfig.accountId, ctx.accountId),
        ),
      )
      .limit(1);

    if (claimed) {
      return NextResponse.json(
        {
          error:
            "This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one ChatMessage user.",
        },
        { status: 409 },
      );
    }

    let phoneInfo: Awaited<ReturnType<typeof verifyPhoneNumber>>;
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: phone_number_id,
        accessToken: access_token,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown Meta API error";
      console.error("Meta API verification failed during save:", message);
      return NextResponse.json({ error: `Meta API error: ${message}` }, { status: 400 });
    }

    let encryptedAccessToken: string;
    let encryptedVerifyToken: string | null;
    try {
      encryptedAccessToken = encrypt(access_token);
      encryptedVerifyToken = verify_token ? encrypt(verify_token) : null;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown encryption error";
      console.error("Encryption failed:", message);
      return NextResponse.json(
        {
          error:
            "Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.",
        },
        { status: 500 },
      );
    }

    const [existing] =
      typeof id === "string" && id
        ? await db
            .select()
            .from(whatsappConfig)
            .where(and(eq(whatsappConfig.accountId, ctx.accountId), eq(whatsappConfig.id, id)))
            .limit(1)
        : await db
            .select()
            .from(whatsappConfig)
            .where(
              and(
                eq(whatsappConfig.accountId, ctx.accountId),
                eq(whatsappConfig.phoneNumberId, phone_number_id),
              ),
            )
            .limit(1);

    const sameNumber =
      existing?.phoneNumberId === phone_number_id && existing.registeredAt != null;
    await assertCanCreateWhatsAppLine(null, ctx.accountId, existing?.id ?? null);

    let registeredAt: Date | null = existing?.registeredAt ?? null;
    let registrationError: string | null = null;
    let registrationSkipped = false;

    const needsRegistration = !sameNumber || (typeof pin === "string" && pin.length > 0);
    if (needsRegistration) {
      if (!pin) {
        registrationSkipped = true;
      } else {
        try {
          await registerPhoneNumber({
            phoneNumberId: phone_number_id,
            accessToken: access_token,
            pin,
          });
          registeredAt = new Date();
        } catch (err) {
          registrationError = err instanceof Error ? err.message : "Unknown Meta API error";
          console.error("Phone number /register failed:", registrationError);
        }
      }
    }

    let subscribedAppsAt: Date | null = null;
    if (waba_id) {
      try {
        await subscribeWabaToApp({
          wabaId: waba_id,
          accessToken: access_token,
        });
        subscribedAppsAt = new Date();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("WABA subscribed_apps failed (non-fatal):", message);
      }
    }

    const [firstExisting] = await db
      .select({ id: whatsappConfig.id })
      .from(whatsappConfig)
      .where(eq(whatsappConfig.accountId, ctx.accountId))
      .limit(1);
    const shouldBeDefault = Boolean(is_default) || !firstExisting;

    await db.transaction(async (tx) => {
      if (shouldBeDefault) {
        const defaultWhere = existing
          ? and(eq(whatsappConfig.accountId, ctx.accountId), ne(whatsappConfig.id, existing.id))
          : eq(whatsappConfig.accountId, ctx.accountId);
        await tx.update(whatsappConfig).set({ isDefault: false }).where(defaultWhere);
      }

      const row = {
        phoneNumberId: phone_number_id,
        wabaId: waba_id || null,
        accessToken: encryptedAccessToken,
        verifyToken: encryptedVerifyToken,
        status: registrationError ? "disconnected" : "connected",
        connectedAt: registrationError ? null : new Date(),
        registeredAt: registrationError ? null : registeredAt,
        subscribedAppsAt,
        lastRegistrationError: registrationError,
        label: label || phoneInfo?.verified_name || phone_number_id,
        departmentId,
        updatedAt: new Date(),
      };

      if (existing) {
        await tx
          .update(whatsappConfig)
          .set({
            ...row,
            isDefault: shouldBeDefault || existing.isDefault,
          })
          .where(and(eq(whatsappConfig.accountId, ctx.accountId), eq(whatsappConfig.id, existing.id)));
      } else {
        await tx.insert(whatsappConfig).values({
          accountId: ctx.accountId,
          userId: ctx.userId,
          isDefault: shouldBeDefault,
          ...row,
        });
      }
    });

    await publishRealtimeEvent(existing ? "whatsapp_config.updated" : "whatsapp_config.created", {
      accountId: ctx.accountId,
      payload: { id: existing?.id ?? null },
    }).catch((error) => {
      console.warn("[realtime] failed to publish whatsapp_config change:", error);
    });

    if (registrationError) {
      return NextResponse.json({
        success: false,
        saved: true,
        registered: false,
        registration_error: registrationError,
        phone_info: phoneInfo,
      });
    }

    return NextResponse.json({
      success: true,
      saved: true,
      registered: registeredAt != null,
      registration_skipped: registrationSkipped,
      phone_info: phoneInfo,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireDbRole("admin");
    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    await db
      .delete(whatsappConfig)
      .where(
        id
          ? and(eq(whatsappConfig.accountId, ctx.accountId), eq(whatsappConfig.id, id))
          : eq(whatsappConfig.accountId, ctx.accountId),
      );

    const [remaining] = await db
      .select({ id: whatsappConfig.id })
      .from(whatsappConfig)
      .where(eq(whatsappConfig.accountId, ctx.accountId))
      .orderBy(desc(whatsappConfig.isDefault), asc(whatsappConfig.createdAt))
      .limit(1);

    if (remaining?.id) {
      await db
        .update(whatsappConfig)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(and(eq(whatsappConfig.id, remaining.id), eq(whatsappConfig.accountId, ctx.accountId)));
    }

    await publishRealtimeEvent("whatsapp_config.deleted", {
      accountId: ctx.accountId,
      payload: { id },
    }).catch((error) => {
      console.warn("[realtime] failed to publish whatsapp_config.deleted:", error);
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
