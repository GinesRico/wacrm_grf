import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/db/client";
import { crmAccounts, profiles } from "@/db/schema";
import { auth } from "@/lib/better-auth/server";
import { hasMinRole, isAccountRole, type AccountRole } from "./roles";
import { ForbiddenError, UnauthorizedError } from "./errors";

export interface DbAccountContext {
  userId: string;
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
    created_at?: string;
  };
  accountId: string;
  role: AccountRole;
  account: {
    id: string;
    name: string;
    owner_user_id: string;
    status: string;
    plan: string;
    max_users: number;
    max_flows: number;
    max_automations: number;
    max_whatsapp_lines: number;
    allow_ai: boolean;
    allow_api: boolean;
    allow_broadcasts: boolean;
    trial_ends_at: string | null;
    default_currency: string;
  };
  profile: {
    id: string;
    user_id: string;
    full_name: string;
    email: string;
    avatar_url: string | null;
    role: string | null;
    beta_features: string[];
    account_id: string;
    account_role: AccountRole;
  };
}

export async function getCurrentDbAccount(): Promise<DbAccountContext> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) throw new UnauthorizedError();

  const [row] = await db
    .select({
      profileId: profiles.id,
      userId: profiles.userId,
      fullName: profiles.fullName,
      email: profiles.email,
      avatarUrl: profiles.avatarUrl,
      role: profiles.role,
      betaFeatures: profiles.betaFeatures,
      accountId: profiles.accountId,
      accountRole: profiles.accountRole,
      accountName: crmAccounts.name,
      accountOwnerUserId: crmAccounts.ownerUserId,
      accountStatus: crmAccounts.status,
      accountPlan: crmAccounts.plan,
      maxUsers: crmAccounts.maxUsers,
      maxFlows: crmAccounts.maxFlows,
      maxAutomations: crmAccounts.maxAutomations,
      maxWhatsappLines: crmAccounts.maxWhatsappLines,
      allowAi: crmAccounts.allowAi,
      allowApi: crmAccounts.allowApi,
      allowBroadcasts: crmAccounts.allowBroadcasts,
      trialEndsAt: crmAccounts.trialEndsAt,
      defaultCurrency: crmAccounts.defaultCurrency,
    })
    .from(profiles)
    .innerJoin(crmAccounts, eq(profiles.accountId, crmAccounts.id))
    .where(eq(profiles.userId, session.user.id))
    .limit(1);

  if (!row) throw new ForbiddenError("Profile is not linked to an account");
  if (!isAccountRole(row.accountRole)) {
    throw new ForbiddenError(`Unknown account role: ${row.accountRole}`);
  }

  return {
    userId: session.user.id,
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      image: session.user.image,
      created_at: session.user.createdAt?.toISOString?.(),
    },
    accountId: row.accountId,
    role: row.accountRole,
    account: {
      id: row.accountId,
      name: row.accountName,
      owner_user_id: row.accountOwnerUserId,
      status: row.accountStatus,
      plan: row.accountPlan,
      max_users: row.maxUsers,
      max_flows: row.maxFlows,
      max_automations: row.maxAutomations,
      max_whatsapp_lines: row.maxWhatsappLines,
      allow_ai: row.allowAi,
      allow_api: row.allowApi,
      allow_broadcasts: row.allowBroadcasts,
      trial_ends_at: row.trialEndsAt?.toISOString() ?? null,
      default_currency: row.defaultCurrency,
    },
    profile: {
      id: row.profileId,
      user_id: row.userId,
      full_name: row.fullName,
      email: row.email,
      avatar_url: row.avatarUrl,
      role: row.role,
      beta_features: row.betaFeatures,
      account_id: row.accountId,
      account_role: row.accountRole,
    },
  };
}

export async function requireDbRole(min: AccountRole): Promise<DbAccountContext> {
  const ctx = await getCurrentDbAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(`This action requires the '${min}' role or higher`);
  }
  return ctx;
}
