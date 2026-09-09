import { and, eq } from 'drizzle-orm';
import { ImapFlow } from 'imapflow';

import { db } from '@/db/client';
import { emailAccounts } from '@/db/schema';
import { decryptEmailCredentials } from '@/lib/email/credentials';
import { importEmailAccount } from '@/lib/email/service';

const RECONCILE_INTERVAL_MS = Number(process.env.EMAIL_RECONCILE_INTERVAL_MS ?? 300_000);
const WATCH_REFRESH_MS = Number(process.env.EMAIL_WATCH_REFRESH_MS ?? 60_000);
const WATCH_RECONNECT_MS = Number(process.env.EMAIL_WATCH_RECONNECT_MS ?? 10_000);

type Watch = { accountId: string; emailAccountId: string; mailbox: string; client: ImapFlow; running: boolean };
const watches = new Map<string, Watch>();
const syncing = new Set<string>();
const pendingSyncReasons = new Map<string, string>();
const wakeTimers = new Map<string, NodeJS.Timeout>();

function log(message: string, meta?: Record<string, unknown>) {
  console.log(JSON.stringify({ at: new Date().toISOString(), component: 'email-imap-worker', message, ...meta }));
}

async function syncAccount(accountId: string, emailAccountId: string, reason: string) {
  if (syncing.has(emailAccountId)) {
    pendingSyncReasons.set(emailAccountId, reason);
    return;
  }
  syncing.add(emailAccountId);
  try {
    const result = await importEmailAccount({ accountId, emailAccountId, maxMessages: 200 });
    log('account synchronized', { emailAccountId, reason, ...result });
  } catch (error) {
    log('account synchronization failed', { emailAccountId, reason, error: error instanceof Error ? error.message : String(error) });
  } finally {
    syncing.delete(emailAccountId);
    const pendingReason = pendingSyncReasons.get(emailAccountId);
    if (pendingReason) {
      pendingSyncReasons.delete(emailAccountId);
      void syncAccount(accountId, emailAccountId, pendingReason);
    }
  }
}

async function stopWatch(emailAccountId: string) {
  const matches = [...watches.entries()].filter(([, watch]) => watch.emailAccountId === emailAccountId);
  await Promise.all(matches.map(async ([key, watch]) => {
    watches.delete(key);
    watch.running = false;
    await watch.client.logout().catch(() => watch.client.close());
  }));
}

async function discoverMailboxes(account: typeof emailAccounts.$inferSelect) {
  const credentials = decryptEmailCredentials(account.encryptedCredentials as Record<string, unknown>);
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: credentials.imap_user, pass: credentials.imap_password },
    logger: false,
  });
  try {
    await client.connect();
    const listed = await client.list();
    return listed.filter((item) => item.listed && item.path && !item.flags.has('\\Noselect')).map((item) => item.path);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

async function stopWatchByKey(key: string) {
  const watch = watches.get(key);
  if (!watch) return;
  watches.delete(key);
  watch.running = false;
  await watch.client.logout().catch(() => watch.client.close());
}

async function startWatch(account: typeof emailAccounts.$inferSelect, mailbox: string) {
  const key = `${account.id}:${mailbox}`;
  if (watches.has(key)) return;
  const credentials = decryptEmailCredentials(account.encryptedCredentials as Record<string, unknown>);
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: credentials.imap_user, pass: credentials.imap_password },
    logger: false,
  });
  const watch: Watch = { accountId: account.accountId, emailAccountId: account.id, mailbox, client, running: true };
  watches.set(key, watch);

  const wake = (reason: string) => {
    const current = wakeTimers.get(account.id);
    if (current) clearTimeout(current);
    wakeTimers.set(account.id, setTimeout(() => {
      wakeTimers.delete(account.id);
      void syncAccount(account.accountId, account.id, reason);
    }, 300));
  };
  client.on('exists', () => wake('imap.exists'));
  client.on('expunge', () => wake('imap.expunge'));
  client.on('flags', () => wake('imap.flags'));
  client.on('error', (error) => log('imap connection error', { emailAccountId: account.id, error: error.message }));

  try {
    await client.connect();
    await client.mailboxOpen(mailbox, { readOnly: true });
    log('watching mailbox with IMAP IDLE', { emailAccountId: account.id, mailbox });
    while (watch.running) await client.idle();
  } catch (error) {
    if (watch.running) {
      log('imap watch stopped; scheduling reconnect', { emailAccountId: account.id, mailbox, reconnectMs: WATCH_RECONNECT_MS, error: error instanceof Error ? error.message : String(error) });
      setTimeout(() => {
        if (!watches.has(key)) void startWatch(account, mailbox);
      }, WATCH_RECONNECT_MS);
    }
  } finally {
    if (watches.get(key) === watch) watches.delete(key);
    await client.logout().catch(() => client.close());
  }
}

async function refreshWatches() {
  const accounts = await db.select().from(emailAccounts).where(and(eq(emailAccounts.enabled, true), eq(emailAccounts.status, 'active')));
  const activeKeys = new Set<string>();
  for (const account of accounts) {
    let mailboxes: string[];
    try {
      mailboxes = await discoverMailboxes(account);
    } catch (error) {
      log('imap mailbox discovery failed', { emailAccountId: account.id, error: error instanceof Error ? error.message : String(error) });
      mailboxes = [account.syncMailbox];
    }
    for (const mailbox of new Set([account.syncMailbox, ...mailboxes])) {
      const key = `${account.id}:${mailbox}`;
      activeKeys.add(key);
      void startWatch(account, mailbox);
    }
  }
  for (const key of watches.keys()) if (!activeKeys.has(key)) await stopWatchByKey(key);
  return accounts;
}

async function main() {
  log('worker started', { reconcileIntervalMs: RECONCILE_INTERVAL_MS });
  const accounts = await refreshWatches();
  for (const account of accounts) void syncAccount(account.accountId, account.id, 'startup_reconcile');
  const refreshTimer = setInterval(() => void refreshWatches().catch((error) => log('watch refresh failed', { error: String(error) })), WATCH_REFRESH_MS);
  const reconcileTimer = setInterval(() => void Promise.all([...watches.values()].map((watch) => syncAccount(watch.accountId, watch.emailAccountId, 'periodic_reconcile'))), RECONCILE_INTERVAL_MS);
  const shutdown = async () => {
    clearInterval(refreshTimer);
    clearInterval(reconcileTimer);
    await Promise.all([...new Set([...watches.values()].map((watch) => watch.emailAccountId))].map((emailAccountId) => stopWatch(emailAccountId)));
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void main().catch((error) => {
  log('worker crashed', { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exitCode = 1;
});
