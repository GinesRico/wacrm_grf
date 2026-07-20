import type { AccountRole } from "./roles";
import { hasMinRole } from "./roles";
import { getCurrentDbAccount } from "./current-account";
import {
  ForbiddenError,
  UnauthorizedError,
  toErrorResponse,
} from "./errors";

export { ForbiddenError, UnauthorizedError, toErrorResponse };

export interface AccountContext {
  userId: string;
  accountId: string;
  role: AccountRole;
  account: {
    id: string;
    name: string;
    status?: string;
    plan?: string;
    max_users?: number;
    max_flows?: number;
    max_automations?: number;
    max_whatsapp_lines?: number;
    allow_ai?: boolean;
    allow_api?: boolean;
    allow_broadcasts?: boolean;
    trial_ends_at?: string | null;
  };
}

export async function getCurrentAccount(): Promise<AccountContext> {
  const ctx = await getCurrentDbAccount();

  return {
    userId: ctx.userId,
    accountId: ctx.accountId,
    role: ctx.role,
    account: ctx.account,
  };
}

export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(`This action requires the '${min}' role or higher`);
  }
  return ctx;
}
