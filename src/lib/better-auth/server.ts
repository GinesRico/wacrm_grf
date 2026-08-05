import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import * as schema from "@/db/schema";

function requiredSecret(name: string): string {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === "test") {
    return "test-only-better-auth-secret";
  }
  if (!value) {
    throw new Error(`${name} must be configured before auth can start.`);
  }
  return value;
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      ...schema,
      user: schema.authUser,
      session: schema.authSession,
      account: schema.authAccount,
      verification: schema.authVerification,
    },
    transaction: true,
  }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: process.env.ALLOW_PUBLIC_SIGNUP !== "true",
    sendResetPassword: async ({ user, url }) => {
      if (process.env.NODE_ENV === "development") {
        console.info(`[auth] password reset requested for ${user.email}`);
        console.info(`[auth] development reset URL: ${url}`);
        return;
      }

      console.warn(
        `[auth] password reset requested for ${user.email}, but no production email sender is configured.`,
      );
    },
  },
  user: {
    changeEmail: {
      enabled: true,
      updateEmailWithoutVerification: false,
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          const [existingProfile] = await db
            .select({ id: schema.profiles.id })
            .from(schema.profiles)
            .where(eq(schema.profiles.userId, user.id))
            .limit(1);
          if (existingProfile) return;

          const [account] = await db
            .insert(schema.crmAccounts)
            .values({
              name: user.name ? `${user.name}'s Account` : "Workspace",
              ownerUserId: user.id,
            })
            .returning({ id: schema.crmAccounts.id });

          await db.insert(schema.profiles).values({
            userId: user.id,
            fullName: user.name || user.email,
            email: user.email,
            avatarUrl: user.image ?? null,
            accountId: account.id,
            accountRole: "owner",
          });
        },
      },
      update: {
        after: async (user) => {
          await db
            .update(schema.profiles)
            .set({
              fullName: user.name || user.email,
              email: user.email,
              avatarUrl: user.image ?? null,
            })
            .where(eq(schema.profiles.userId, user.id));
        },
      },
    },
  },
  secret: requiredSecret("BETTER_AUTH_SECRET"),
  baseURL: process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL,
});
