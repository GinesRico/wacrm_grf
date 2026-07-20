import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { apiKeys, crmAccounts } from "@/db/schema";

export interface ApiKeyRow {
  id: string;
  account_id: string;
  created_by: string | null;
  name: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
}

export async function findActiveKeyByHash(
  hash: string,
): Promise<ApiKeyRow | null> {
  const [key] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);

  if (!key) return null;
  if (key.revokedAt) return null;
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null;

  return {
    id: key.id,
    account_id: key.accountId,
    created_by: key.createdBy,
    name: key.name,
    scopes: key.scopes,
    expires_at: key.expiresAt?.toISOString() ?? null,
    revoked_at: null,
  };
}

export async function getAccountName(accountId: string): Promise<string | null> {
  const [account] = await db
    .select({ name: crmAccounts.name })
    .from(crmAccounts)
    .where(eq(crmAccounts.id, accountId))
    .limit(1);
  return account?.name ?? null;
}

export function touchLastUsed(id: string): void {
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, id))
    .catch((error) => {
      console.warn("[api-keys/store] last_used_at bump failed:", error);
    });
}
