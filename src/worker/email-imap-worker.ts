import { and, eq } from 'drizzle-orm';
import { ImapFlow } from 'imapflow';

import { db } from '@/db/client';
import { emailAccounts } from '@/db/schema';
import { decryptEmailCredentials } from '@/lib/email/credentials';
import { importEmailAccount } from '@/lib/email/service';

const RECONCILE_INTERVAL_MS = Number(process.env.EMAIL_RECONCILE_INTERVAL_MS ?? 60_000);
const WATCH_REFRESH_MS = 30_000;

type Watch = { accountId: string; emailAccountId: string; client: ImapFlow; running: boolean };
const watches = new Map<string, Watch>();
const syncing = new Set<string>();

function log(message: string, meta?: Record<string, unknown>) {
  console.log(JSON.stringify({ at: new Date().toISOString(), component: 'email-imap-worker', message, ...meta }));
}

async function syncAccount(accountId: string, emailAccountId: string, reason: string) {
  if (syncing.has(emailAccountId)) return;
  syncing.add(emailAccountId);
  try {
    const result = await importEmailAccount({ accountId, emailAccountId, maxMessages: 200 });
    log('account synchronized', { emailAccountId, reason, ...result });
  } catch (error) {
    log('account synchronization failed', { emailAccountId, reason, error: error instanceof Error ? error.message : String(error) });
  } finally {
    syncing.delete(emailAccountId);
  }
}

async function stopWatch(emailAccountId: string) {
  const watch = watches.get(emailAccountId);
  if (!watch) return;
  watches.delete(emailAccountId);
  watch.running = false;
  await watch.client.logout().catch(() => watch.client.close());
}

async function startWatch(account: typeof emailAccounts.$inferSelect) {
  if (watches.has(account.id)) return;
  const credentials = decryptEmailCredentials(account.encryptedCredentials as Record<string, unknown>);
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: credentials.imap_user, pass: credentials.imap_password },
    logger: false,
  });
  const watch: Watch = { accountId: account.accountId, emailAccountId: account.id, client, running: true };
  watches.set(account.id, watch);

  const wake = (reason: string) => void syncAccount(account.accountId, account.id, reason);
  client.on('exists', () => wake('imap.exists'));
  client.on('expunge', () => wake('imap.expunge'));
  client.on('flags', () => wake('imap.flags'));
  client.on('error', (error) => log('imap connection error', { emailAccountId: account.id, error: error.message }));

  try {
    await client.connect();
    await client.mailboxOpen(account.syncMailbox, { readOnly: true });
    log('watching mailbox with IMAP IDLE', { emailAccountId: account.id, mailbox: account.syncMailbox });
    while (watch.running) await client.idle();
  } catch (error) {
    if (watch.running) log('imap watch stopped', { emailAccountId: account.id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (watches.get(account.id) === watch) watches.delete(account.id);
    await client.logout().catch(() => client.close());
  }
}

async function refreshWatches() {
  const accounts = await db.select().from(emailAccounts).where(and(eq(emailAccounts.enabled, true), eq(emailAccounts.status, 'active')));
  const activeIds = new Set(accounts.map((account) => account.id));
  for (const account of accounts) void startWatch(account);
  for (const emailAccountId of watches.keys()) if (!activeIds.has(emailAccountId)) await stopWatch(emailAccountId);
  for (const account of accounts) void syncAccount(account.accountId, account.id, 'periodic_reconcile');
}

async function main() {
  log('worker started', { reconcileIntervalMs: RECONCILE_INTERVAL_MS });
  await refreshWatches();
  const refreshTimer = setInterval(() => void refreshWatches().catch((error) => log('watch refresh failed', { error: String(error) })), WATCH_REFRESH_MS);
  const reconcileTimer = setInterval(() => void Promise.all([...watches.values()].map((watch) => syncAccount(watch.accountId, watch.emailAccountId, 'periodic_reconcile'))), RECONCILE_INTERVAL_MS);
  const shutdown = async () => {
    clearInterval(refreshTimer);
    clearInterval(reconcileTimer);
    await Promise.all([...watches.keys()].map((emailAccountId) => stopWatch(emailAccountId)));
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void main().catch((error) => {
  log('worker crashed', { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exitCode = 1;
});
