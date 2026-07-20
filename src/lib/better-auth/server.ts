import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import * as schema from "@/db/schema";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
    transaction: true,
  }),
  emailAndPassword: {
    enabled: true,
    sendResetPassword: async ({ user, url }) => {
      console.info(`[auth] password reset for ${user.email}: ${url}`);
    },
  },
  user: {
    changeEmail: {
      enabled: true,
      updateEmailWithoutVerification: true,
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
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL,
});
