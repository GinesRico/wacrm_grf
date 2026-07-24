#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { hashPassword } from 'better-auth/crypto';
import pg from 'pg';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');

async function loadLocalEnvIfAvailable() {
  try {
    const nextEnv = await import('@next/env');
    nextEnv.default.loadEnvConfig(projectDir);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
}

const DEFAULT_PASSWORD = 'rme39msu';
const DEFAULT_COLOR = '#22c55e';
const CHAT_MEDIA_BUCKET = 'chat-media';
let s3Client = null;

const REQUIRED_FILES = [
  'manifest.json',
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
];

function parseArgs(argv) {
  const args = { media: 'alarik', password: DEFAULT_PASSWORD, dryRun: false };
  const positional = [];
  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      args[key] = rest.length ? rest.join('=') : true;
    } else {
      positional.push(arg);
    }
  }
  args.exportDir = positional[0]
    ? path.resolve(process.cwd(), positional[0])
    : null;
  return args;
}

function usage() {
  return [
    'Usage: pnpm import:whaticket <export-dir> [--account=<uuid>] [--owner-user=<id>] [--password=rme39msu] [--media=alarik|public|skip] [--import-key=<key>] [--status-events=dedupe|system|skip] [--repair-media] [--dry-run]',
    '',
    'The export directory must contain manifest.json, the JSON files exported by WhaTicket, and media/.',
  ].join('\n');
}

async function readJson(exportDir, name) {
  const raw = await fs.readFile(path.join(exportDir, name), 'utf8');
  return JSON.parse(raw);
}

async function validateExportDir(exportDir) {
  if (!exportDir) throw new Error(usage());
  const missing = [];
  for (const file of REQUIRED_FILES) {
    try {
      await fs.access(path.join(exportDir, file));
    } catch {
      missing.push(file);
    }
  }
  if (missing.length) {
    throw new Error(`Missing required export files: ${missing.join(', ')}`);
  }
}

function text(value) {
  if (value === null || value === undefined) return null;
  const valueText = String(value).trim();
  return valueText || null;
}

function whaticketSystemMessageText(value) {
  const raw = text(value);
  if (!raw) return null;
  const cleaned = raw
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[*_~]/g, '')
    .replace(/^[\s_*~\-\u2013\u2014]+|[\s_*~\-\u2013\u2014]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (isWhaticketSystemText(cleaned)) {
    return cleaned;
  }
  return null;
}

function isWhaticketSystemText(value) {
  const cleaned = text(value);
  if (!cleaned) return false;
  return (
    /^Chat (aceptado|devuelto(?: a cola)?|resuelto|reabierto)\b/i.test(cleaned) ||
    /^Estado cambiado\b/i.test(cleaned)
  );
}

function legacy(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

function dateOrNow(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : new Date();
}

function dateOrNull(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function normalizePhone(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function normalizeColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value
    : DEFAULT_COLOR;
}

function normalizeTicketStatus(value) {
  if (value === 'closed') return 'closed';
  if (value === 'pending') return 'pending';
  return 'open';
}

function normalizeMediaType(value, hasMedia) {
  const mediaType = String(value ?? '').toLowerCase();
  if (['image', 'document', 'audio', 'video', 'sticker'].includes(mediaType)) {
    return mediaType;
  }
  if (mediaType === 'ptt') return 'audio';
  if (hasMedia) return 'document';
  return 'text';
}

function normalizeMessageStatus(row) {
  if (row?.isDeleted) return 'failed';
  if (row?.read || Number(row?.ack) >= 3) return 'read';
  if (Number(row?.ack) >= 2) return 'delivered';
  if (Number(row?.ack) < 0) return 'failed';
  return 'sent';
}

function safeImportKey(value) {
  return (
    String(value)
      .replace(/[^a-zA-Z0-9_.-]+/g, '_')
      .slice(0, 80) || 'whaticket'
  );
}

function elapsedSince(startedAt) {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

async function runPhase(label, rows, worker, options = {}) {
  const total = rows.length;
  const every = options.every ?? (total > 50000 ? 5000 : 1000);
  const startedAt = Date.now();
  console.log(`\n[${label}] starting ${total} rows`);
  let processed = 0;
  for (const row of rows) {
    await worker(row, processed);
    processed += 1;
    if (processed === total || processed % every === 0) {
      const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : '100.0';
      console.log(
        `[${label}] ${processed}/${total} (${pct}%) elapsed ${elapsedSince(startedAt)}`
      );
    }
  }
  if (total === 0) {
    console.log(`[${label}] 0/0 (100.0%) elapsed ${elapsedSince(startedAt)}`);
  }
}

function encryptPlaceholderToken(textValue) {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      'ENCRYPTION_KEY must be a 64-character hex string to create disconnected WhatsApp placeholders.'
    );
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'hex'),
    iv
  );
  let encrypted = cipher.update(textValue, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}:${cipher.getAuthTag().toString('hex')}`;
}

function buildPublicMediaPath(accountId, importKey, kind, row) {
  const sourceName = path.basename(
    row.mediaFileName || row.exportedMediaPath || 'file.bin'
  );
  const ext = path.extname(sourceName) || '.bin';
  const base =
    path
      .basename(sourceName, ext)
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .slice(0, 60) || 'file';
  return path.posix.join(
    'imported-media',
    `account-${accountId}`,
    safeImportKey(importKey),
    kind,
    `${legacy(row.legacyId) ?? crypto.randomUUID()}-${base}${ext}`
  );
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Alarik/S3 media import.`);
  return value;
}

function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: requiredEnv('S3_ENDPOINT'),
      region: process.env.S3_REGION ?? 'auto',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
      credentials: {
        accessKeyId: requiredEnv('S3_ACCESS_KEY_ID'),
        secretAccessKey: requiredEnv('S3_SECRET_ACCESS_KEY'),
      },
    });
  }
  return s3Client;
}

function storageBucket() {
  return requiredEnv('S3_BUCKET');
}

function publicObjectUrl(key) {
  const base = requiredEnv('S3_PUBLIC_BASE_URL');
  return `${base.replace(/\/$/, '')}/${key.replace(/^\//, '')}`;
}

function mediaContentType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const types = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.3gp': 'video/3gpp',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
  };
  return types[ext] ?? 'application/octet-stream';
}

async function copyMedia(
  exportDir,
  accountId,
  importKey,
  kind,
  row,
  mediaMode,
  warnings
) {
  if (!row?.exportedMediaPath || row.mediaMissing) return null;
  if (mediaMode === 'skip') return null;
  if (!['alarik', 'public'].includes(mediaMode)) {
    throw new Error(
      `Unsupported --media mode "${mediaMode}". Use alarik, public, or skip.`
    );
  }

  const relativeSource = String(row.exportedMediaPath).replaceAll('\\', '/');
  const sourcePath = path.resolve(exportDir, relativeSource);
  if (!sourcePath.startsWith(path.resolve(exportDir) + path.sep)) {
    warnings.push(`Skipped unsafe media path: ${relativeSource}`);
    return null;
  }

  try {
    await fs.access(sourcePath);
  } catch {
    warnings.push(`Media file not found: ${relativeSource}`);
    return null;
  }

  const relativeTarget = buildPublicMediaPath(accountId, importKey, kind, row);
  if (mediaMode === 'alarik') {
    const objectPath = relativeTarget.replaceAll('\\', '/');
    const key = `${CHAT_MEDIA_BUCKET}/${objectPath}`;
    const body = await fs.readFile(sourcePath);
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: storageBucket(),
        Key: key,
        Body: body,
        ContentType: mediaContentType(sourcePath),
        CacheControl: '3600',
      })
    );
    return publicObjectUrl(key);
  }

  const targetPath = path.join(projectDir, 'public', relativeTarget);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
  return `/${relativeTarget.replaceAll('\\', '/')}`;
}

async function queryOne(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0] ?? null;
}

async function exec(client, sql, params = []) {
  return client.query(sql, params);
}

async function resolveAccount(client, accountId) {
  if (accountId) {
    const account = await queryOne(
      client,
      'select id, owner_user_id from accounts where id = $1',
      [accountId]
    );
    if (!account) throw new Error(`WACRM account not found: ${accountId}`);
    return { id: account.id, ownerUserId: account.owner_user_id };
  }
  const accounts = await client.query(
    'select id, owner_user_id from accounts order by created_at'
  );
  if (accounts.rows.length !== 1) {
    throw new Error(
      'Pass --account=<uuid> when the database has zero or multiple WACRM accounts.'
    );
  }
  return {
    id: accounts.rows[0].id,
    ownerUserId: accounts.rows[0].owner_user_id,
  };
}

async function getMap(client, accountId, importKey, entityType, legacyId) {
  if (!legacyId) return null;
  const row = await queryOne(
    client,
    `select new_id
       from whaticket_legacy_map
      where account_id = $1 and import_key = $2 and entity_type = $3 and legacy_id = $4`,
    [accountId, importKey, entityType, legacyId]
  );
  return row?.new_id ?? null;
}

async function setMap(
  client,
  accountId,
  importKey,
  entityType,
  legacyId,
  newId,
  payload = {}
) {
  if (!legacyId) return;
  await exec(
    client,
    `insert into whaticket_legacy_map (account_id, import_key, entity_type, legacy_id, new_id, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (account_id, import_key, entity_type, legacy_id)
     do update set new_id = excluded.new_id, payload = excluded.payload, updated_at = now()`,
    [
      accountId,
      importKey,
      entityType,
      legacyId,
      newId,
      JSON.stringify(payload ?? {}),
    ]
  );
}

function importedUserEmail(originalEmail, legacyId) {
  const email = text(originalEmail);
  if (!email || !email.includes('@')) {
    return `whaticket-user-${legacyId}@legacy.local`;
  }
  const [local, domain] = email.split('@');
  return `${local}+whaticket-${legacyId}@${domain}`;
}

async function ensureUser(client, ctx, row, passwordHash) {
  const legacyId = legacy(row.legacyId);
  const mapped = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'user',
    legacyId
  );
  if (mapped) return mapped;

  let email = text(row.email) ?? `whaticket-user-${legacyId}@legacy.local`;
  const name = text(row.name) ?? email;
  let existingUser = await queryOne(
    client,
    'select id from "user" where lower(email) = lower($1)',
    [email]
  );

  if (existingUser) {
    const existingProfile = await queryOne(
      client,
      'select account_id from profiles where user_id = $1',
      [existingUser.id]
    );
    if (existingProfile && existingProfile.account_id !== ctx.accountId) {
      const originalEmail = email;
      email = importedUserEmail(originalEmail, legacyId);
      console.warn(
        `User ${originalEmail} belongs to another WACRM account; importing legacy user ${legacyId} as ${email}.`
      );
      existingUser = await queryOne(
        client,
        'select id from "user" where lower(email) = lower($1)',
        [email]
      );
    }
  }

  let userId = existingUser?.id ?? crypto.randomUUID();

  if (!existingUser) {
    await exec(
      client,
      `insert into "user" (id, name, email, email_verified, image, created_at, updated_at)
       values ($1, $2, lower($3), true, null, $4, $5)`,
      [userId, name, email, dateOrNow(row.createdAt), dateOrNow(row.updatedAt)]
    );
    await exec(
      client,
      `insert into "account" (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values ($1, $2, 'credential', $2, $3, $4, $5)`,
      [
        crypto.randomUUID(),
        userId,
        passwordHash,
        dateOrNow(row.createdAt),
        dateOrNow(row.updatedAt),
      ]
    );
  }

  const profile = await queryOne(
    client,
    'select account_id from profiles where user_id = $1',
    [userId]
  );
  if (profile && profile.account_id !== ctx.accountId) {
    throw new Error(`User ${email} already belongs to another WACRM account.`);
  }
  if (!profile) {
    const role = row.profile === 'admin' ? 'admin' : 'agent';
    await exec(
      client,
      `insert into profiles (user_id, full_name, email, avatar_url, account_id, account_role, created_at, updated_at)
       values ($1, $2, lower($3), null, $4, $5, $6, $7)`,
      [
        userId,
        name,
        email,
        ctx.accountId,
        role,
        dateOrNow(row.createdAt),
        dateOrNow(row.updatedAt),
      ]
    );
  }

  await setMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'user',
    legacyId,
    userId,
    row
  );
  return userId;
}

async function ensureDepartment(client, ctx, row) {
  const legacyId = legacy(row.legacyId);
  const mapped = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'queue',
    legacyId
  );
  if (mapped) return mapped;

  const name = text(row.name) ?? `Queue ${legacyId}`;
  const existing = await queryOne(
    client,
    'select id from departments where account_id = $1 and lower(name) = lower($2)',
    [ctx.accountId, name]
  );
  const departmentId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await exec(
      client,
      `insert into departments (id, account_id, name, color, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        departmentId,
        ctx.accountId,
        name,
        normalizeColor(row.color),
        dateOrNow(row.createdAt),
        dateOrNow(row.updatedAt),
      ]
    );
  }
  await setMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'queue',
    legacyId,
    departmentId,
    row
  );
  return departmentId;
}

async function ensureDepartmentMember(client, accountId, departmentId, userId) {
  if (!departmentId || !userId) return;
  await exec(
    client,
    `insert into department_members (department_id, account_id, user_id)
     values ($1, $2, $3)
     on conflict (department_id, user_id) do nothing`,
    [departmentId, accountId, userId]
  );
}

async function ensureWhatsapp(client, ctx, row, departmentId) {
  const legacyId = legacy(row.legacyId);
  const mapped = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'whatsapp',
    legacyId
  );
  if (mapped) return mapped;

  const phoneNumberId = text(row.phoneNumberId) ?? `legacy-${legacyId}`;
  const existing = await queryOne(
    client,
    'select id from whatsapp_config where account_id = $1 and phone_number_id = $2',
    [ctx.accountId, phoneNumberId]
  );
  const whatsappId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    const placeholderToken = encryptPlaceholderToken(
      `whaticket-import:${ctx.importKey}:${legacyId}`
    );
    await exec(
      client,
      `insert into whatsapp_config
        (id, user_id, account_id, department_id, label, phone_number_id, waba_id, access_token,
         verify_token, status, connected_at, registered_at, subscribed_apps_at, last_registration_error,
         is_default, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, null, 'disconnected', null, null, null,
         'Imported from WhaTicket without tokens. Reconnect this line in WACRM.', $9, $10, $11)`,
      [
        whatsappId,
        ctx.ownerUserId,
        ctx.accountId,
        departmentId,
        text(row.name) ?? phoneNumberId,
        phoneNumberId,
        text(row.businessAccountId),
        placeholderToken,
        Boolean(row.isDefault),
        dateOrNow(row.createdAt),
        dateOrNow(row.updatedAt),
      ]
    );
  }
  await setMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'whatsapp',
    legacyId,
    whatsappId,
    row
  );
  return whatsappId;
}

async function copyContactAvatar(ctx, row, mediaMode, warnings) {
  const avatarRow = {
    legacyId: row.legacyId,
    mediaFileName: row.profilePicUrl,
    exportedMediaPath: row.exportedAvatarPath,
    mediaMissing: row.avatarMissing,
  };
  return copyMedia(
    exportDirGlobal,
    ctx.accountId,
    ctx.importKey,
    'contacts',
    avatarRow,
    mediaMode,
    warnings
  );
}

async function ensureContact(client, ctx, row, mediaMode, warnings) {
  const legacyId = legacy(row.legacyId);
  const mapped = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'contact',
    legacyId
  );
  if (mapped) {
    if (ctx.repairMedia) {
      await repairContactAvatar(client, ctx, mapped, row, mediaMode, warnings);
    }
    return mapped;
  }

  const phone = text(row.number) ?? text(row.lid) ?? `legacy-${legacyId}`;
  const phoneNormalized = normalizePhone(phone);
  const existing = phoneNormalized
    ? await queryOne(
        client,
        'select id from contacts where account_id = $1 and phone_normalized = $2',
        [ctx.accountId, phoneNormalized]
      )
    : null;
  const contactId = existing?.id ?? crypto.randomUUID();
  const avatarUrl = await copyContactAvatar(ctx, row, mediaMode, warnings);
  if (!existing) {
    await exec(
      client,
      `insert into contacts
        (id, user_id, account_id, phone, phone_normalized, name, email, company, avatar_url, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, null, $8, $9, $10)`,
      [
        contactId,
        ctx.ownerUserId,
        ctx.accountId,
        phone,
        phoneNormalized || null,
        text(row.name),
        text(row.email),
        avatarUrl,
        dateOrNow(row.createdAt),
        dateOrNow(row.updatedAt),
      ]
    );
  } else if (ctx.repairMedia) {
    await repairContactAvatar(client, ctx, contactId, row, mediaMode, warnings);
  }
  await setMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'contact',
    legacyId,
    contactId,
    row
  );
  return contactId;
}

async function repairContactAvatar(client, ctx, contactId, row, mediaMode, warnings) {
  if (mediaMode === 'skip') {
    await exec(client, 'update contacts set avatar_url = null where id = $1', [
      contactId,
    ]);
    return;
  }

  const avatarUrl = await copyContactAvatar(ctx, row, mediaMode, warnings);
  await exec(client, 'update contacts set avatar_url = $2 where id = $1', [
    contactId,
    avatarUrl,
  ]);
}

async function ensureCustomFieldValue(client, ctx, row) {
  const legacyId = legacy(row.legacyId);
  const mapped = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'contact_custom_field',
    legacyId
  );
  if (mapped) return mapped;

  const contactId = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'contact',
    legacy(row.contactLegacyId)
  );
  if (!contactId) return null;
  const fieldName = text(row.name);
  if (!fieldName) return null;

  let field = await queryOne(
    client,
    'select id from custom_fields where account_id = $1 and lower(field_name) = lower($2)',
    [ctx.accountId, fieldName]
  );
  if (!field) {
    field = { id: crypto.randomUUID() };
    await exec(
      client,
      `insert into custom_fields (id, user_id, account_id, field_name, field_type, field_options, created_at)
       values ($1, $2, $3, $4, 'text', null, $5)
       on conflict (account_id, field_name) do nothing`,
      [
        field.id,
        ctx.ownerUserId,
        ctx.accountId,
        fieldName,
        dateOrNow(row.createdAt),
      ]
    );
    field = await queryOne(
      client,
      'select id from custom_fields where account_id = $1 and lower(field_name) = lower($2)',
      [ctx.accountId, fieldName]
    );
  }

  const valueId = crypto.randomUUID();
  await exec(
    client,
    `insert into contact_custom_values (id, contact_id, custom_field_id, value)
     values ($1, $2, $3, $4)
     on conflict (contact_id, custom_field_id) do update set value = excluded.value
     returning id`,
    [valueId, contactId, field.id, text(row.value)]
  );
  const saved = await queryOne(
    client,
    'select id from contact_custom_values where contact_id = $1 and custom_field_id = $2',
    [contactId, field.id]
  );
  await setMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'contact_custom_field',
    legacyId,
    saved.id,
    row
  );
  return saved.id;
}

async function ensureConversation(client, ctx, row) {
  const legacyId = legacy(row.legacyId);
  const mapped = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'ticket',
    legacyId
  );
  if (mapped) return mapped;

  const contactId = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'contact',
    legacy(row.contactLegacyId)
  );
  if (!contactId) return null;
  const userId = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'user',
    legacy(row.userLegacyId)
  );
  const departmentId = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'queue',
    legacy(row.queueLegacyId)
  );
  const whatsappId = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'whatsapp',
    legacy(row.whatsappLegacyId)
  );

  const conversationId = crypto.randomUUID();
  await exec(
    client,
    `insert into conversations
      (id, user_id, account_id, contact_id, whatsapp_config_id, department_id, status, assigned_agent_id,
       last_message_text, last_message_at, unread_count, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      conversationId,
      userId ?? ctx.ownerUserId,
      ctx.accountId,
      contactId,
      whatsappId,
      departmentId,
      normalizeTicketStatus(row.status),
      userId,
      text(row.lastMessage),
      dateOrNull(row.updatedAt) ?? dateOrNull(row.createdAt),
      Math.max(0, Number(row.unreadMessages) || 0),
      dateOrNow(row.createdAt),
      dateOrNow(row.updatedAt),
    ]
  );
  await setMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'ticket',
    legacyId,
    conversationId,
    row
  );
  return conversationId;
}

async function ensureMessage(
  client,
  ctx,
  row,
  ticketByLegacy,
  mediaMode,
  warnings
) {
  const legacyId = legacy(row.legacyId);
  const mapped = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'message',
    legacyId
  );
  if (mapped) {
    await repairMappedMessage(client, ctx, mapped, row, mediaMode, warnings);
    return mapped;
  }

  const conversationId = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'ticket',
    legacy(row.ticketLegacyId)
  );
  if (!conversationId) return null;
  const systemText = whaticketSystemMessageText(row.body);
  if (systemText) {
    const messageId = crypto.randomUUID();
    await exec(
      client,
      `insert into messages
        (id, conversation_id, sender_type, sender_id, content_type, content_text,
         message_id, status, is_starred, created_at)
       values ($1, $2, 'bot', null, 'system', $3, $4, 'sent', false, $5)`,
      [
        messageId,
        conversationId,
        systemText,
        legacyId ? `whaticket:${legacyId}` : null,
        dateOrNow(row.createdAt),
      ]
    );
    await setMap(
      client,
      ctx.accountId,
      ctx.importKey,
      'message',
      legacyId,
      messageId,
      row
    );
    return messageId;
  }

  const ticket = ticketByLegacy.get(legacy(row.ticketLegacyId));
  const senderUserId = ticket
    ? await getMap(
        client,
        ctx.accountId,
        ctx.importKey,
        'user',
        legacy(ticket.userLegacyId)
      )
    : null;
  const mediaUrl = await copyMedia(
    exportDirGlobal,
    ctx.accountId,
    ctx.importKey,
    'messages',
    row,
    mediaMode,
    warnings
  );
  const hasMedia = Boolean(mediaUrl);
  const messageId = crypto.randomUUID();
  const contentType = normalizeMediaType(row.mediaType, hasMedia);

  await exec(
    client,
    `insert into messages
      (id, conversation_id, sender_type, sender_id, content_type, content_text, media_url,
       template_name, message_id, status, reply_to_message_id, interactive_payload, deleted_at,
       is_starred, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, null, $8, $9, null, $10::jsonb, $11, false, $12)`,
    [
      messageId,
      conversationId,
      row.fromMe ? 'agent' : 'customer',
      row.fromMe
        ? (senderUserId ?? ctx.ownerUserId)
        : await getMap(
            client,
            ctx.accountId,
            ctx.importKey,
            'contact',
            legacy(row.contactLegacyId)
          ),
      contentType,
      text(row.body),
      mediaUrl,
      legacyId ? `whaticket:${legacyId}` : null,
      normalizeMessageStatus(row),
      row.templateComponents ? JSON.stringify(row.templateComponents) : null,
      row.isDeleted ? dateOrNow(row.updatedAt ?? row.createdAt) : null,
      dateOrNow(row.createdAt),
    ]
  );
  await setMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'message',
    legacyId,
    messageId,
    row
  );
  return messageId;
}

async function repairMappedMessage(client, ctx, messageId, row, mediaMode, warnings) {
  const systemText = whaticketSystemMessageText(row.body);
  if (systemText) {
    await exec(
      client,
      `update messages
          set sender_type = 'bot',
              sender_id = null,
              content_type = 'system',
              content_text = $2,
              media_url = null
        where id = $1
          and (content_type <> 'system' or content_text is distinct from $2)`,
      [messageId, systemText]
    );
    return;
  }

  if (!ctx.repairMedia || mediaMode === 'skip') return;
  if (!row?.exportedMediaPath || row.mediaMissing) return;

  const existing = await queryOne(
    client,
    'select media_url from messages where id = $1',
    [messageId]
  );
  if (existing?.media_url) return;

  const mediaUrl = await copyMedia(
    exportDirGlobal,
    ctx.accountId,
    ctx.importKey,
    'messages',
    row,
    mediaMode,
    warnings
  );
  if (!mediaUrl) return;

  await exec(
    client,
    `update messages
        set media_url = $2,
            content_type = $3
      where id = $1`,
    [messageId, mediaUrl, normalizeMediaType(row.mediaType, true)]
  );
}

async function importQuickReply(client, ctx, row, mediaMode, warnings) {
  const legacyId = legacy(row.legacyId);
  const mapped = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'quick_answer',
    legacyId
  );
  if (mapped) return mapped;

  const mediaUrl = await copyMedia(
    exportDirGlobal,
    ctx.accountId,
    ctx.importKey,
    'quick_answers',
    row,
    mediaMode,
    warnings
  );
  const title = text(row.shortcut) ?? `Quick answer ${legacyId}`;
  const content = [
    text(row.message),
    mediaUrl ? `[Imported attachment: ${mediaUrl}]` : null,
  ]
    .filter(Boolean)
    .join('\n\n');
  const quickReplyId = crypto.randomUUID();
  await exec(
    client,
    `insert into quick_replies
      (id, account_id, user_id, title, kind, content_text, interactive_payload, created_at, updated_at)
     values ($1, $2, $3, $4, 'text', $5, null, $6, $7)`,
    [
      quickReplyId,
      ctx.accountId,
      ctx.ownerUserId,
      title,
      content || title,
      dateOrNow(row.createdAt),
      dateOrNow(row.updatedAt),
    ]
  );
  await setMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'quick_answer',
    legacyId,
    quickReplyId,
    {
      ...row,
      importedMediaUrl: mediaUrl,
    }
  );
  return quickReplyId;
}

async function updateQuotedMessages(client, ctx, messages) {
  let updated = 0;
  for (const row of messages) {
    if (!row.quotedMessageLegacyId) continue;
    const messageId = await getMap(
      client,
      ctx.accountId,
      ctx.importKey,
      'message',
      legacy(row.legacyId)
    );
    const quotedId = await getMap(
      client,
      ctx.accountId,
      ctx.importKey,
      'message',
      legacy(row.quotedMessageLegacyId)
    );
    if (!messageId || !quotedId) continue;
    await exec(
      client,
      'update messages set reply_to_message_id = $1 where id = $2',
      [quotedId, messageId]
    );
    updated += 1;
  }
  return updated;
}

async function userDisplayName(client, userId) {
  if (!userId) return 'Sistema';
  const row = await queryOne(
    client,
    'select full_name, email from profiles where user_id = $1',
    [userId]
  );
  return text(row?.full_name) ?? text(row?.email) ?? 'Sistema';
}

function systemTextForStatusEvent(row, agentName) {
  const fromStatus = text(row.fromStatus);
  const toStatus = text(row.toStatus);
  if (toStatus === 'open' && fromStatus === 'pending') {
    return `Chat aceptado por ${agentName}`;
  }
  if (toStatus === 'pending') {
    return `Chat devuelto a cola por ${agentName}`;
  }
  if (toStatus === 'closed') {
    return `Chat resuelto por ${agentName}`;
  }
  if (toStatus === 'open' && fromStatus === 'closed') {
    return `Chat reabierto por ${agentName}`;
  }
  return `Estado cambiado de ${fromStatus ?? '-'} a ${toStatus ?? '-'} por ${agentName}`;
}

async function importTicketStatusEvent(client, ctx, row) {
  const legacyId = legacy(row.legacyId);
  const conversationId = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'ticket',
    legacy(row.ticketLegacyId)
  );
  if (!conversationId) {
    await setMap(
      client,
      ctx.accountId,
      ctx.importKey,
      'ticket_status_event',
      legacyId,
      null,
      row
    );
    return null;
  }

  const mapped = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'ticket_status_event',
    legacyId
  );
  if (mapped) return mapped;

  const userId = await getMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'user',
    legacy(row.triggeredByUserLegacyId)
  );
  const agentName = await userDisplayName(client, userId);
  const systemText = systemTextForStatusEvent(row, agentName);
  if (ctx.statusEventsMode === 'dedupe') {
    const existingSystemMessage = await queryOne(
      client,
      `select id
         from messages
        where conversation_id = $1
          and content_type = 'system'
          and created_at between $2::timestamptz - interval '30 seconds'
                             and $2::timestamptz + interval '30 seconds'
          and (
            content_text = $3
            or content_text ~* '^Chat (aceptado|devuelto( a cola)?|resuelto|reabierto)\\b'
            or content_text ~* '^Estado cambiado\\b'
          )
        order by abs(extract(epoch from (created_at - $2::timestamptz))) asc
        limit 1`,
      [conversationId, dateOrNow(row.createdAt), systemText]
    );
    if (existingSystemMessage?.id) {
      await setMap(
        client,
        ctx.accountId,
        ctx.importKey,
        'ticket_status_event',
        legacyId,
        existingSystemMessage.id,
        {
          ...row,
          dedupedToMessageId: existingSystemMessage.id,
        }
      );
      return existingSystemMessage.id;
    }
  }

  const messageId = crypto.randomUUID();
  await exec(
    client,
    `insert into messages
      (id, conversation_id, sender_type, sender_id, content_type, content_text,
       message_id, status, is_starred, created_at)
     values ($1, $2, 'bot', $3, 'system', $4, $5, 'sent', false, $6)`,
    [
      messageId,
      conversationId,
      userId,
      systemText,
      legacyId ? `whaticket-status:${legacyId}` : null,
      dateOrNow(row.createdAt),
    ]
  );
  await setMap(
    client,
    ctx.accountId,
    ctx.importKey,
    'ticket_status_event',
    legacyId,
    messageId,
    row
  );
  return messageId;
}

let exportDirGlobal = null;

async function main() {
  await loadLocalEnvIfAvailable();

  const args = parseArgs(process.argv.slice(2));
  await validateExportDir(args.exportDir);
  exportDirGlobal = args.exportDir;

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const manifest = await readJson(args.exportDir, 'manifest.json');
  const importKey =
    text(args['import-key']) ??
    text(manifest.generatedAt) ??
    path.basename(args.exportDir);
  const statusEventsMode = text(args['status-events']) ?? 'dedupe';
  if (!['dedupe', 'skip', 'system'].includes(statusEventsMode)) {
    throw new Error('Unsupported --status-events mode. Use dedupe, system, or skip.');
  }

  const data = {
    contacts: await readJson(args.exportDir, 'contacts.json'),
    contactFields: await readJson(
      args.exportDir,
      'contacts_custom_fields.json'
    ),
    queues: await readJson(args.exportDir, 'queues.json'),
    users: await readJson(args.exportDir, 'users.json'),
    usersQueues: await readJson(args.exportDir, 'users_queues.json'),
    whatsapps: await readJson(args.exportDir, 'whatsapps_sanitized.json'),
    whatsappsQueues: await readJson(args.exportDir, 'whatsapps_queues.json'),
    tickets: await readJson(args.exportDir, 'tickets.json'),
    messages: await readJson(args.exportDir, 'messages.json'),
    quickAnswers: await readJson(args.exportDir, 'quick_answers.json'),
    ticketStatusEvents: await readJson(
      args.exportDir,
      'ticket_status_events.json'
    ),
  };

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const summary = {};
  const warnings = [];

  try {
    const account = await resolveAccount(client, args.account);
    const ctx = {
      accountId: account.id,
      ownerUserId: args['owner-user'] || account.ownerUserId,
      importKey,
      repairMedia: Boolean(args['repair-media']),
      statusEventsMode,
    };
    const passwordHash = await hashPassword(args.password || DEFAULT_PASSWORD);
    const whatsappQueueByWhatsapp = new Map();
    for (const row of data.whatsappsQueues) {
      const list =
        whatsappQueueByWhatsapp.get(legacy(row.whatsappLegacyId)) ?? [];
      list.push(legacy(row.queueLegacyId));
      whatsappQueueByWhatsapp.set(legacy(row.whatsappLegacyId), list);
    }
    const ticketByLegacy = new Map(
      data.tickets.map((row) => [legacy(row.legacyId), row])
    );

    await client.query('begin');

    console.log(
      `Importing WhaTicket package into account ${ctx.accountId} with media=${args.media}${args.dryRun ? ' (dry-run)' : ''}`
    );

    await runPhase(
      'users',
      data.users,
      (row) => ensureUser(client, ctx, row, passwordHash),
      { every: 1 }
    );
    summary.users = data.users.length;

    await runPhase(
      'queues',
      data.queues,
      (row) => ensureDepartment(client, ctx, row),
      { every: 1 }
    );
    summary.queues = data.queues.length;

    await runPhase('users_queues', data.usersQueues, async (row) => {
      await ensureDepartmentMember(
        client,
        ctx.accountId,
        await getMap(
          client,
          ctx.accountId,
          ctx.importKey,
          'queue',
          legacy(row.queueLegacyId)
        ),
        await getMap(
          client,
          ctx.accountId,
          ctx.importKey,
          'user',
          legacy(row.userLegacyId)
        )
      );
    });
    summary.usersQueues = data.usersQueues.length;

    await runPhase(
      'whatsapps',
      data.whatsapps,
      async (row) => {
        const queueLegacyId = whatsappQueueByWhatsapp.get(
          legacy(row.legacyId)
        )?.[0];
        const departmentId = queueLegacyId
          ? await getMap(
              client,
              ctx.accountId,
              ctx.importKey,
              'queue',
              queueLegacyId
            )
          : null;
        await ensureWhatsapp(client, ctx, row, departmentId);
      },
      { every: 1 }
    );
    summary.whatsapps = data.whatsapps.length;

    const mediaMode = args.dryRun ? 'skip' : args.media;

    await runPhase('contacts', data.contacts, (row) =>
      ensureContact(client, ctx, row, mediaMode, warnings)
    );
    summary.contacts = data.contacts.length;

    await runPhase('contact_custom_fields', data.contactFields, (row) =>
      ensureCustomFieldValue(client, ctx, row)
    );
    summary.contactCustomFields = data.contactFields.length;

    await runPhase('tickets', data.tickets, (row) =>
      ensureConversation(client, ctx, row)
    );
    summary.tickets = data.tickets.length;

    await runPhase(
      'messages',
      data.messages,
      (row) =>
        ensureMessage(client, ctx, row, ticketByLegacy, mediaMode, warnings),
      { every: 5000 }
    );
    summary.messages = data.messages.length;
    console.log('\n[quoted_messages] resolving message quotes');
    summary.quotedMessagesUpdated = await updateQuotedMessages(
      client,
      ctx,
      data.messages
    );
    console.log(
      `[quoted_messages] updated ${summary.quotedMessagesUpdated} quote links`
    );

    await runPhase('quick_answers', data.quickAnswers, (row) =>
      importQuickReply(client, ctx, row, mediaMode, warnings)
    );
    summary.quickAnswers = data.quickAnswers.length;

    if (statusEventsMode !== 'skip') {
      await runPhase(
        'ticket_status_events',
        data.ticketStatusEvents,
        (row) => importTicketStatusEvent(client, ctx, row),
        { every: 5000 }
      );
    } else {
      console.log(
        `\n[ticket_status_events] skipped ${data.ticketStatusEvents.length} rows`
      );
    }
    summary.ticketStatusEvents = data.ticketStatusEvents.length;

    if (args.dryRun) {
      await client.query('rollback');
      summary.dryRun = true;
    } else {
      await client.query('commit');
      summary.dryRun = false;
    }

    console.log(
      JSON.stringify(
        {
          account_id: ctx.accountId,
          import_key: ctx.importKey,
          summary,
          warnings,
        },
        null,
        2
      )
    );
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
