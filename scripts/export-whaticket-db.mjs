#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import nextEnv from '@next/env';
import pg from 'pg';

const { Pool } = pg;
const { loadEnvConfig } = nextEnv;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');
loadEnvConfig(projectDir);

const DEFAULT_BATCH_SIZE = 1000;

function parseArgs(argv) {
  const args = {
    batch: DEFAULT_BATCH_SIZE,
  };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, ...rest] = arg.slice(2).split('=');
    args[key] = rest.join('=');
  }
  return args;
}

function usage() {
  return [
    'Usage: pnpm export:whaticket-db --out=/tmp/whaticket-export --public=/path/to/whaticket/public',
    '',
    'Connection can be set with WHATICKET_DATABASE_URL or WHATICKET_DB_HOST/PORT/NAME/USER/PASS.',
  ].join('\n');
}

function connectionString() {
  if (process.env.WHATICKET_DATABASE_URL) return process.env.WHATICKET_DATABASE_URL;

  const host = process.env.WHATICKET_DB_HOST;
  const port = process.env.WHATICKET_DB_PORT ?? '5432';
  const name = process.env.WHATICKET_DB_NAME;
  const user = process.env.WHATICKET_DB_USER;
  const pass = process.env.WHATICKET_DB_PASS;
  if (!host || !name || !user || !pass) {
    throw new Error(
      'Set WHATICKET_DATABASE_URL or WHATICKET_DB_HOST, WHATICKET_DB_NAME, WHATICKET_DB_USER and WHATICKET_DB_PASS.'
    );
  }
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${encodeURIComponent(name)}`;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function ensureDir(target) {
  await fsp.mkdir(target, { recursive: true });
}

async function writeJson(target, data) {
  await fsp.writeFile(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function safeBaseName(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    return path.basename(parsed.pathname);
  } catch {
    return path.basename(String(value));
  }
}

async function copyPublicFile(publicDir, outputDir, sourceFileName, mediaKind) {
  const safeName = safeBaseName(sourceFileName);
  if (!safeName) return { exportedPath: null, missing: false };

  const root = path.resolve(publicDir);
  const sourcePath = path.resolve(root, safeName);
  if (!sourcePath.startsWith(root + path.sep)) {
    return { exportedPath: null, missing: true };
  }

  try {
    await fsp.access(sourcePath, fs.constants.R_OK);
  } catch {
    return { exportedPath: null, missing: true };
  }

  const targetRelativePath = path.join('media', mediaKind, safeName);
  const targetPath = path.join(outputDir, targetRelativePath);
  await ensureDir(path.dirname(targetPath));
  await fsp.copyFile(sourcePath, targetPath);
  return {
    exportedPath: targetRelativePath.replaceAll('\\', '/'),
    missing: false,
  };
}

async function exportRows(client, outputFile, sql, params, transform, counts, countKey) {
  const { rows } = await client.query(sql, params);
  await writeJson(outputFile, await Promise.all(rows.map(transform)));
  counts[countKey] = rows.length;
}

async function exportBatchedRows({
  client,
  outputFile,
  table,
  orderBy,
  batchSize,
  transform,
  counts,
  countKey,
}) {
  const stream = fs.createWriteStream(outputFile, { encoding: 'utf8' });
  let offset = 0;
  let written = 0;
  let first = true;

  stream.write('[\n');
  try {
    while (true) {
      const { rows } = await client.query(
        `select * from "${table}" order by ${orderBy} limit $1 offset $2`,
        [batchSize, offset]
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        const item = await transform(row);
        stream.write(`${first ? '' : ',\n'}${JSON.stringify(item, null, 2)}`);
        first = false;
        written += 1;
      }

      offset += rows.length;
      console.log(`${table}: ${written} rows exported`);
    }
  } finally {
    stream.write('\n]\n');
    stream.end();
  }

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
  counts[countKey] = written;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(args.out || process.env.EXPORT_DIR || path.join('/tmp', `whaticket-export-${timestamp()}`));
  const publicDir = args.public || process.env.WHATICKET_PUBLIC_DIR;
  if (!publicDir) throw new Error(usage());

  await ensureDir(outputDir);
  await ensureDir(path.join(outputDir, 'media', 'messages'));
  await ensureDir(path.join(outputDir, 'media', 'quick_answers'));

  const pool = new Pool({ connectionString: connectionString() });
  const client = await pool.connect();
  const counts = {};
  const startedAt = new Date();

  try {
    await client.query('select 1');

    await exportRows(
      client,
      path.join(outputDir, 'contacts.json'),
      'select * from "Contacts" order by id asc',
      [],
      (contact) => ({
        legacyId: contact.id,
        name: contact.name,
        number: contact.number,
        lid: contact.lid,
        email: contact.email,
        profilePicUrl: contact.profilePicUrl,
        isGroup: contact.isGroup,
        createdAt: contact.createdAt,
        updatedAt: contact.updatedAt,
      }),
      counts,
      'contacts'
    );

    await exportRows(
      client,
      path.join(outputDir, 'contacts_custom_fields.json'),
      'select * from "ContactCustomFields" order by id asc',
      [],
      (field) => ({
        legacyId: field.id,
        contactLegacyId: field.contactId,
        name: field.name,
        value: field.value,
        createdAt: field.createdAt,
        updatedAt: field.updatedAt,
      }),
      counts,
      'contactsCustomFields'
    );

    await exportRows(
      client,
      path.join(outputDir, 'queues.json'),
      'select * from "Queues" order by id asc',
      [],
      (queue) => ({
        legacyId: queue.id,
        name: queue.name,
        color: queue.color,
        greetingMessage: queue.greetingMessage,
        createdAt: queue.createdAt,
        updatedAt: queue.updatedAt,
      }),
      counts,
      'queues'
    );

    await exportRows(
      client,
      path.join(outputDir, 'users.json'),
      'select * from "Users" order by id asc',
      [],
      (user) => ({
        legacyId: user.id,
        name: user.name,
        email: user.email,
        profile: user.profile,
        defaultWhatsappLegacyId: user.whatsappId,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      }),
      counts,
      'users'
    );

    await exportRows(
      client,
      path.join(outputDir, 'users_queues.json'),
      'select * from "UserQueues" order by "userId" asc, "queueId" asc',
      [],
      (row) => ({
        userLegacyId: row.userId,
        queueLegacyId: row.queueId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
      counts,
      'usersQueues'
    );

    await exportRows(
      client,
      path.join(outputDir, 'whatsapps_sanitized.json'),
      'select * from "Whatsapps" order by id asc',
      [],
      (whatsapp) => ({
        legacyId: whatsapp.id,
        name: whatsapp.name,
        provider: whatsapp.provider,
        phoneNumberId: whatsapp.phoneNumberId,
        businessAccountId: whatsapp.businessAccountId,
        status: whatsapp.status,
        greetingMessage: whatsapp.greetingMessage,
        farewellMessage: whatsapp.farewellMessage,
        absenceMessageEnabled: whatsapp.absenceMessageEnabled,
        absenceMessage: whatsapp.absenceMessage,
        absenceDateRangeMessageEnabled: whatsapp.absenceDateRangeMessageEnabled,
        absenceDateRangeMessage: whatsapp.absenceDateRangeMessage,
        absenceWeeklySchedule: whatsapp.absenceWeeklySchedule,
        absenceDateRanges: whatsapp.absenceDateRanges,
        absenceTimezone: whatsapp.absenceTimezone,
        isDefault: whatsapp.isDefault,
        createdAt: whatsapp.createdAt,
        updatedAt: whatsapp.updatedAt,
      }),
      counts,
      'whatsapps'
    );

    await exportRows(
      client,
      path.join(outputDir, 'whatsapps_queues.json'),
      'select * from "WhatsappQueues" order by "whatsappId" asc, "queueId" asc',
      [],
      (row) => ({
        whatsappLegacyId: row.whatsappId,
        queueLegacyId: row.queueId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
      counts,
      'whatsappsQueues'
    );

    await exportRows(
      client,
      path.join(outputDir, 'tickets.json'),
      'select * from "Tickets" order by id asc',
      [],
      (ticket) => ({
        legacyId: ticket.id,
        publicId: ticket.publicId,
        status: ticket.status,
        unreadMessages: ticket.unreadMessages,
        lastMessage: ticket.lastMessage,
        isGroup: ticket.isGroup,
        absenceMessageSentAt: ticket.absenceMessageSentAt,
        userLegacyId: ticket.userId,
        contactLegacyId: ticket.contactId,
        whatsappLegacyId: ticket.whatsappId,
        queueLegacyId: ticket.queueId,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
      }),
      counts,
      'tickets'
    );

    await exportBatchedRows({
      client,
      outputFile: path.join(outputDir, 'messages.json'),
      table: 'Messages',
      orderBy: '"createdAt" asc, id asc',
      batchSize: Number(args.batch) || DEFAULT_BATCH_SIZE,
      counts,
      countKey: 'messages',
      transform: async (message) => {
        const copiedMedia = await copyPublicFile(
          publicDir,
          outputDir,
          message.mediaUrl,
          'messages'
        );
        return {
          legacyId: message.id,
          ack: message.ack,
          read: message.read,
          fromMe: message.fromMe,
          body: message.body,
          templateComponents: message.templateComponents,
          mediaFileName: message.mediaUrl,
          exportedMediaPath: copiedMedia.exportedPath,
          mediaMissing: copiedMedia.missing,
          mediaType: message.mediaType,
          isDeleted: message.isDeleted,
          quotedMessageLegacyId: message.quotedMsgId,
          ticketLegacyId: message.ticketId,
          contactLegacyId: message.contactId,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        };
      },
    });

    await exportBatchedRows({
      client,
      outputFile: path.join(outputDir, 'quick_answers.json'),
      table: 'QuickAnswers',
      orderBy: 'id asc',
      batchSize: Number(args.batch) || DEFAULT_BATCH_SIZE,
      counts,
      countKey: 'quickAnswers',
      transform: async (quickAnswer) => {
        const copiedMedia = await copyPublicFile(
          publicDir,
          outputDir,
          quickAnswer.mediaPath,
          'quick_answers'
        );
        return {
          legacyId: quickAnswer.id,
          shortcut: quickAnswer.shortcut,
          message: quickAnswer.message,
          mediaFileName: quickAnswer.mediaPath,
          exportedMediaPath: copiedMedia.exportedPath,
          mediaMissing: copiedMedia.missing,
          mediaName: quickAnswer.mediaName,
          mediaType: quickAnswer.mediaType,
          createdAt: quickAnswer.createdAt,
          updatedAt: quickAnswer.updatedAt,
        };
      },
    });

    await exportRows(
      client,
      path.join(outputDir, 'ticket_status_events.json'),
      'select * from "TicketStatusEvents" order by id asc',
      [],
      (event) => ({
        legacyId: event.id,
        ticketLegacyId: event.ticketId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        triggeredByUserLegacyId: event.triggeredByUserId,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
      }),
      counts,
      'ticketStatusEvents'
    );

    await writeJson(path.join(outputDir, 'manifest.json'), {
      app: 'whaticket',
      exportVersion: 1,
      generatedAt: new Date().toISOString(),
      startedAt: startedAt.toISOString(),
      outputDir,
      sourcePublicDir: path.resolve(publicDir),
      files: [
        'contacts.json',
        'contacts_custom_fields.json',
        'queues.json',
        'users.json',
        'users_queues.json',
        'whatsapps_sanitized.json',
        'whatsapps_queues.json',
        'tickets.json',
        'messages.json',
        'quick_answers.json',
        'ticket_status_events.json',
      ],
      mediaDirs: ['media/messages', 'media/quick_answers'],
      sensitiveFieldsExcluded: [
        'Users.passwordHash',
        'Users.password',
        'Users.tokenVersion',
        'Whatsapps.accessToken',
        'Whatsapps.verifyToken',
        'Whatsapps.session',
        'Whatsapps.qrcode',
        'WppKeys',
      ],
      counts,
    });

    console.log(`Export completed: ${outputDir}`);
    console.log(JSON.stringify(counts, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
