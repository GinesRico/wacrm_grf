import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const accountRoleEnum = pgEnum('account_role_enum', [
  'owner',
  'admin',
  'agent',
  'viewer',
]);

export const authUser = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const authSession = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_user_id_idx').on(table.userId)]
);

export const authAccount = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
    }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('account_user_id_idx').on(table.userId)]
);

export const authVerification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)]
);

export const crmAccounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('active'),
    plan: text('plan').notNull().default('starter'),
    maxUsers: integer('max_users').notNull().default(3),
    maxFlows: integer('max_flows').notNull().default(5),
    maxAutomations: integer('max_automations').notNull().default(5),
    maxWhatsappLines: integer('max_whatsapp_lines').notNull().default(1),
    allowAi: boolean('allow_ai').notNull().default(false),
    allowApi: boolean('allow_api').notNull().default(false),
    allowBroadcasts: boolean('allow_broadcasts').notNull().default(true),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    defaultCurrency: text('default_currency').notNull().default('USD'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex('idx_accounts_one_per_owner').on(table.ownerUserId)]
);

export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    email: text('email').notNull(),
    avatarUrl: text('avatar_url'),
    role: text('role').default('user'),
    betaFeatures: text('beta_features').array().notNull().default([]),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    accountRole: accountRoleEnum('account_role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('profiles_user_id_key').on(table.userId),
    index('idx_profiles_account_role').on(table.accountId, table.accountRole),
  ]
);

export const platformAdmins = pgTable(
  'platform_admins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    userId: text('user_id').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    createdByUserId: text('created_by_user_id').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('idx_platform_admins_email').on(table.email),
    index('idx_platform_admins_user_id').on(table.userId),
  ]
);

export const platformAccountInvites = pgTable(
  'platform_account_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    accountName: text('account_name').notNull(),
    ownerEmail: text('owner_email').notNull(),
    plan: text('plan').notNull().default('starter'),
    status: text('status').notNull().default('active'),
    maxUsers: integer('max_users').notNull().default(3),
    maxFlows: integer('max_flows').notNull().default(5),
    maxAutomations: integer('max_automations').notNull().default(5),
    maxWhatsappLines: integer('max_whatsapp_lines').notNull().default(1),
    allowAi: boolean('allow_ai').notNull().default(false),
    allowApi: boolean('allow_api').notNull().default(false),
    allowBroadcasts: boolean('allow_broadcasts').notNull().default(true),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    createdByUserId: text('created_by_user_id').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: text('accepted_by_user_id').references(
      () => authUser.id,
      {
        onDelete: 'set null',
      }
    ),
  },
  (table) => [index('idx_platform_account_invites_pending').on(table.expiresAt)]
);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    phone: text('phone').notNull(),
    phoneNormalized: text('phone_normalized'),
    name: text('name'),
    email: text('email'),
    company: text('company'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_contacts_account').on(table.accountId),
    index('idx_contacts_phone').on(table.phone),
    uniqueIndex('idx_contacts_account_phone_normalized').on(
      table.accountId,
      table.phoneNormalized
    ),
  ]
);

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#3b82f6'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('tags_account_name_key').on(table.accountId, table.name),
    index('idx_tags_account').on(table.accountId),
  ]
);

export const contactTags = pgTable(
  'contact_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('contact_tags_contact_tag_key').on(
      table.contactId,
      table.tagId
    ),
    index('idx_contact_tags_contact').on(table.contactId),
    index('idx_contact_tags_tag').on(table.tagId),
  ]
);

export const contactNotes = pgTable(
  'contact_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    noteText: text('note_text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_contact_notes_contact').on(table.contactId),
    index('idx_contact_notes_account').on(table.accountId),
  ]
);

export const customFields = pgTable(
  'custom_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    fieldName: text('field_name').notNull(),
    fieldType: text('field_type').notNull().default('text'),
    fieldOptions: jsonb('field_options'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('custom_fields_account_name_key').on(
      table.accountId,
      table.fieldName
    ),
    index('idx_custom_fields_account').on(table.accountId),
  ]
);

export const contactCustomValues = pgTable(
  'contact_custom_values',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    customFieldId: uuid('custom_field_id')
      .notNull()
      .references(() => customFields.id, { onDelete: 'cascade' }),
    value: text('value'),
  },
  (table) => [
    uniqueIndex('contact_custom_values_contact_field_key').on(
      table.contactId,
      table.customFieldId
    ),
    index('idx_contact_custom_values_contact').on(table.contactId),
  ]
);

export const departments = pgTable(
  'departments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#22c55e'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('departments_account_name_key').on(table.accountId, table.name),
    index('idx_departments_account').on(table.accountId),
  ]
);

export const departmentMembers = pgTable(
  'department_members',
  {
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('department_members_department_user_key').on(
      table.departmentId,
      table.userId
    ),
    index('idx_department_members_account_user').on(
      table.accountId,
      table.userId
    ),
  ]
);

export const accountInvitations = pgTable(
  'account_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    role: accountRoleEnum('role').notNull(),
    createdByUserId: text('created_by_user_id').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: text('accepted_by_user_id').references(
      () => authUser.id,
      {
        onDelete: 'set null',
      }
    ),
  },
  (table) => [
    index('idx_account_invitations_account_pending').on(
      table.accountId,
      table.expiresAt
    ),
  ]
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    scopes: text('scopes').array().notNull().default([]),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('api_keys_account_id_idx').on(table.accountId),
    index('api_keys_key_hash_idx').on(table.keyHash),
  ]
);

export const quickReplies = pgTable(
  'quick_replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    kind: text('kind').notNull().default('text'),
    contentText: text('content_text'),
    interactivePayload: jsonb('interactive_payload'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('idx_quick_replies_account').on(table.accountId)]
);

export const messageTemplates = pgTable(
  'message_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: text('category').notNull().default('Marketing'),
    language: text('language').default('en_US'),
    headerType: text('header_type'),
    headerContent: text('header_content'),
    headerHandle: text('header_handle'),
    headerMediaUrl: text('header_media_url'),
    bodyText: text('body_text').notNull(),
    footerText: text('footer_text'),
    buttons: jsonb('buttons'),
    sampleValues: jsonb('sample_values'),
    status: text('status').default('Draft'),
    metaTemplateId: text('meta_template_id'),
    rejectionReason: text('rejection_reason'),
    qualityScore: text('quality_score'),
    submissionError: text('submission_error'),
    lastSubmittedAt: timestamp('last_submitted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_message_templates_account').on(table.accountId),
    index('idx_message_templates_meta_id').on(table.metaTemplateId),
  ]
);

export const pipelines = pgTable(
  'pipelines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('idx_pipelines_account').on(table.accountId)]
);

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    color: text('color').notNull().default('#3b82f6'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('idx_pipeline_stages_pipeline').on(table.pipelineId)]
);

export const deals = pgTable(
  'deals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => pipelineStages.id),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    conversationId: uuid('conversation_id').references(() => conversations.id),
    assignedTo: uuid('assigned_to').references(() => profiles.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    value: numeric('value', { precision: 12, scale: 2 }).notNull().default('0'),
    currency: text('currency').default('USD'),
    notes: text('notes'),
    expectedCloseDate: date('expected_close_date'),
    status: text('status').default('open'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_deals_account').on(table.accountId),
    index('idx_deals_pipeline').on(table.pipelineId),
    index('idx_deals_stage').on(table.stageId),
    index('idx_deals_assigned_to').on(table.assignedTo),
  ]
);

export const broadcasts = pgTable(
  'broadcasts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    templateName: text('template_name').notNull(),
    templateLanguage: text('template_language').notNull().default('en_US'),
    templateVariables: jsonb('template_variables'),
    audienceFilter: jsonb('audience_filter'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    status: text('status').notNull().default('draft'),
    totalRecipients: integer('total_recipients').default(0),
    sentCount: integer('sent_count').default(0),
    deliveredCount: integer('delivered_count').default(0),
    readCount: integer('read_count').default(0),
    repliedCount: integer('replied_count').default(0),
    failedCount: integer('failed_count').default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('idx_broadcasts_account').on(table.accountId)]
);

export const broadcastRecipients = pgTable(
  'broadcast_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    broadcastId: uuid('broadcast_id')
      .notNull()
      .references(() => broadcasts.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('pending'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    whatsappMessageId: text('whatsapp_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_broadcast_recipients_broadcast').on(table.broadcastId),
    index('idx_broadcast_recipients_broadcast_status').on(
      table.broadcastId,
      table.status
    ),
    uniqueIndex('idx_broadcast_recipients_wamid').on(table.whatsappMessageId),
  ]
);

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    url: text('url').notNull(),
    secret: text('secret').notNull(),
    events: text('events').array().notNull().default([]),
    isActive: boolean('is_active').notNull().default(true),
    lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
    failureCount: integer('failure_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('webhook_endpoints_account_id_idx').on(table.accountId)]
);

export const whatsappConfig = pgTable(
  'whatsapp_config',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    label: text('label'),
    phoneNumberId: text('phone_number_id').notNull(),
    wabaId: text('waba_id'),
    accessToken: text('access_token').notNull(),
    verifyToken: text('verify_token'),
    status: text('status').notNull().default('disconnected'),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    registeredAt: timestamp('registered_at', { withTimezone: true }),
    subscribedAppsAt: timestamp('subscribed_apps_at', { withTimezone: true }),
    lastRegistrationError: text('last_registration_error'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('whatsapp_config_account_phone_number_id_key').on(
      table.accountId,
      table.phoneNumberId
    ),
    index('idx_whatsapp_config_account_default').on(
      table.accountId,
      table.isDefault
    ),
  ]
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    whatsappConfigId: uuid('whatsapp_config_id'),
    departmentId: uuid('department_id'),
    status: text('status').notNull().default('open'),
    assignedAgentId: text('assigned_agent_id'),
    lastMessageText: text('last_message_text'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    unreadCount: integer('unread_count').notNull().default(0),
    aiAutoreplyDisabled: boolean('ai_autoreply_disabled')
      .notNull()
      .default(false),
    aiReplyCount: integer('ai_reply_count').notNull().default(0),
    aiHandoffSummary: text('ai_handoff_summary'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_conversations_account').on(table.accountId),
    index('idx_conversations_contact').on(table.contactId),
    index('idx_conversations_last_message').on(
      table.accountId,
      table.lastMessageAt
    ),
  ]
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderType: text('sender_type').notNull(),
    senderId: text('sender_id'),
    contentType: text('content_type').notNull().default('text'),
    contentText: text('content_text'),
    mediaUrl: text('media_url'),
    templateName: text('template_name'),
    messageId: text('message_id'),
    status: text('status').notNull().default('sent'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    replyToMessageId: uuid('reply_to_message_id'),
    interactiveReplyId: text('interactive_reply_id'),
    interactivePayload: jsonb('interactive_payload'),
    isForwarded: boolean('is_forwarded').notNull().default(false),
    forwardedFromMessageId: uuid('forwarded_from_message_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: text('deleted_by_user_id'),
    isStarred: boolean('is_starred').notNull().default(false),
    aiGenerated: boolean('ai_generated').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_messages_conversation').on(table.conversationId),
    index('idx_messages_message_id').on(table.messageId),
    index('idx_messages_created').on(table.conversationId, table.createdAt),
  ]
);

export const messageReactions = pgTable(
  'message_reactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    emoji: text('emoji').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_message_reactions_conversation').on(table.conversationId),
    uniqueIndex('message_reactions_unique_actor').on(
      table.messageId,
      table.actorType,
      table.actorId
    ),
  ]
);

export const automations = pgTable(
  'automations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    triggerType: text('trigger_type').notNull(),
    triggerConfig: jsonb('trigger_config').notNull().default({}),
    isActive: boolean('is_active').notNull().default(false),
    executionCount: integer('execution_count').notNull().default(0),
    lastExecutedAt: timestamp('last_executed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_automations_account').on(table.accountId),
    index('idx_automations_user_id').on(table.userId),
    index('idx_automations_account_active_trigger').on(
      table.accountId,
      table.triggerType
    ),
  ]
);

export const automationSteps = pgTable(
  'automation_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    automationId: uuid('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    parentStepId: uuid('parent_step_id'),
    branch: text('branch'),
    stepType: text('step_type').notNull(),
    stepConfig: jsonb('step_config').notNull().default({}),
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_automation_steps_automation_id').on(
      table.automationId,
      table.position
    ),
    index('idx_automation_steps_parent').on(table.parentStepId),
    check(
      'automation_steps_branch_check',
      sql`${table.branch} in ('yes', 'no')`
    ),
  ]
);

export const automationLogs = pgTable(
  'automation_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    automationId: uuid('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    triggerEvent: text('trigger_event').notNull(),
    stepsExecuted: jsonb('steps_executed').notNull().default([]),
    status: text('status').notNull(),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_automation_logs_account').on(table.accountId),
    index('idx_automation_logs_automation').on(
      table.automationId,
      table.createdAt
    ),
    index('idx_automation_logs_user').on(table.userId),
    check(
      'automation_logs_status_check',
      sql`${table.status} in ('success', 'partial', 'failed')`
    ),
  ]
);

export const automationPendingExecutions = pgTable(
  'automation_pending_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    automationId: uuid('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    logId: uuid('log_id').references(() => automationLogs.id, {
      onDelete: 'cascade',
    }),
    parentStepId: uuid('parent_step_id').references(() => automationSteps.id, {
      onDelete: 'set null',
    }),
    branch: text('branch'),
    nextStepPosition: integer('next_step_position').notNull(),
    context: jsonb('context').notNull().default({}),
    status: text('status').notNull().default('pending'),
    runAt: timestamp('run_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_automation_pending_due').on(table.runAt),
    check(
      'automation_pending_executions_branch_check',
      sql`${table.branch} in ('yes', 'no')`
    ),
    check(
      'automation_pending_executions_status_check',
      sql`${table.status} in ('pending', 'running', 'done', 'failed')`
    ),
  ]
);

export const flows = pgTable(
  'flows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull().default('draft'),
    triggerType: text('trigger_type').notNull(),
    triggerConfig: jsonb('trigger_config').notNull().default({}),
    entryNodeId: text('entry_node_id'),
    fallbackPolicy: jsonb('fallback_policy').notNull().default({
      on_unknown_reply: 'reprompt',
      max_reprompts: 2,
      on_timeout_hours: 24,
      on_exhaust: 'handoff',
    }),
    executionCount: integer('execution_count').notNull().default(0),
    lastExecutedAt: timestamp('last_executed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_flows_account').on(table.accountId),
    index('idx_flows_account_trigger').on(table.accountId, table.triggerType),
    check(
      'flows_status_check',
      sql`${table.status} in ('draft', 'active', 'archived')`
    ),
    check(
      'flows_trigger_type_check',
      sql`${table.triggerType} in ('keyword', 'first_inbound_message', 'manual')`
    ),
  ]
);

export const flowNodes = pgTable(
  'flow_nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    nodeKey: text('node_key').notNull(),
    nodeType: text('node_type').notNull(),
    config: jsonb('config').notNull().default({}),
    positionX: integer('position_x').notNull().default(0),
    positionY: integer('position_y').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('flow_nodes_flow_id_node_key_key').on(
      table.flowId,
      table.nodeKey
    ),
    index('idx_flow_nodes_flow').on(table.flowId),
    check(
      'flow_nodes_node_type_check',
      sql`${table.nodeType} in ('start', 'send_buttons', 'send_list', 'send_message', 'send_media', 'collect_input', 'condition', 'set_tag', 'handoff', 'http_fetch', 'end')`
    ),
  ]
);

export const flowRuns = pgTable(
  'flow_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('active'),
    currentNodeKey: text('current_node_key'),
    lastPromptMessageId: uuid('last_prompt_message_id').references(
      () => messages.id,
      {
        onDelete: 'set null',
      }
    ),
    vars: jsonb('vars').notNull().default({}),
    repromptCount: integer('reprompt_count').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastAdvancedAt: timestamp('last_advanced_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: text('end_reason'),
  },
  (table) => [
    index('idx_flow_runs_account').on(table.accountId),
    index('idx_flow_runs_active_advanced').on(table.lastAdvancedAt),
    index('idx_flow_runs_flow_started').on(table.flowId, table.startedAt),
    check(
      'flow_runs_status_check',
      sql`${table.status} in ('active', 'completed', 'handed_off', 'timed_out', 'paused_by_agent', 'failed')`
    ),
  ]
);

export const flowRunEvents = pgTable(
  'flow_run_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flowRunId: uuid('flow_run_id')
      .notNull()
      .references(() => flowRuns.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    nodeKey: text('node_key'),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_flow_run_events_run_type').on(table.flowRunId, table.eventType),
    index('idx_flow_run_events_run_time').on(table.flowRunId, table.createdAt),
    check(
      'flow_run_events_event_type_check',
      sql`${table.eventType} in ('started', 'node_entered', 'message_sent', 'reply_received', 'fallback_fired', 'handoff', 'timeout', 'error', 'completed')`
    ),
  ]
);

export const integrationApps = pgTable('integration_apps', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    appSlug: text('app_slug')
      .notNull()
      .references(() => integrationApps.slug, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    encryptedCredentials: jsonb('encrypted_credentials').notNull().default({}),
    config: jsonb('config').notNull().default({}),
    status: text('status').notNull().default('not_configured'),
    lastError: text('last_error'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('integration_connections_account_app_key').on(
      table.accountId,
      table.appSlug
    ),
    index('idx_integration_connections_account').on(table.accountId),
    check(
      'integration_connections_status_check',
      sql`${table.status} in ('not_configured', 'active', 'disabled', 'error')`
    ),
  ]
);

export const paymentLinks = pgTable(
  'payment_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull().default('arvera-payments'),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('EUR'),
    concept: text('concept').notNull(),
    email: text('email'),
    phone: text('phone'),
    orderId: text('order_id').notNull(),
    paymentUrl: text('payment_url').notNull(),
    status: text('status').notNull().default('pending'),
    rawResponse: jsonb('raw_response').notNull().default({}),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('payment_links_account_provider_order_key').on(
      table.accountId,
      table.provider,
      table.orderId
    ),
    index('idx_payment_links_account_created').on(
      table.accountId,
      table.createdAt
    ),
    index('idx_payment_links_status').on(table.accountId, table.status),
    index('idx_payment_links_contact').on(table.contactId),
    index('idx_payment_links_conversation').on(table.conversationId),
    check('payment_links_amount_cents_check', sql`${table.amountCents} > 0`),
    check(
      'payment_links_status_check',
      sql`${table.status} in ('pending', 'paid', 'failed', 'expired', 'cancelled')`
    ),
  ]
);

export const appointmentRecords = pgTable(
  'appointment_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull().default('arvera-appointments'),
    externalId: text('external_id').notNull(),
    status: text('status'),
    service: text('service'),
    customerName: text('customer_name'),
    phone: text('phone'),
    email: text('email'),
    startTime: timestamp('start_time', { withTimezone: true }),
    endTime: timestamp('end_time', { withTimezone: true }),
    cancelUrl: text('cancel_url'),
    rawPayload: jsonb('raw_payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('appointment_records_account_provider_external_key').on(
      table.accountId,
      table.provider,
      table.externalId
    ),
    index('idx_appointment_records_account_start').on(
      table.accountId,
      table.startTime
    ),
    index('idx_appointment_records_contact').on(table.contactId),
  ]
);

export const appointmentWebhookEvents = pgTable(
  'appointment_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    externalId: text('external_id').notNull(),
    eventTimestamp: integer('event_timestamp').notNull(),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_appointment_webhook_events_account').on(table.accountId),
  ]
);

export const whaticketLegacyMap = pgTable(
  'whaticket_legacy_map',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    importKey: text('import_key').notNull(),
    entityType: text('entity_type').notNull(),
    legacyId: text('legacy_id').notNull(),
    newId: text('new_id'),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('whaticket_legacy_map_unique').on(
      table.accountId,
      table.importKey,
      table.entityType,
      table.legacyId
    ),
    index('idx_whaticket_legacy_map_lookup').on(
      table.accountId,
      table.importKey,
      table.entityType
    ),
  ]
);

export const appointmentAvailabilityMessages = pgTable(
  'appointment_availability_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull().default('arvera-appointments'),
    date: date('date').notNull(),
    endDate: date('end_date'),
    sendMode: text('send_mode').notNull().default('booking_link'),
    service: text('service'),
    slots: jsonb('slots').notNull().default([]),
    shortUrl: text('short_url'),
    messageText: text('message_text').notNull(),
    rawResponse: jsonb('raw_response').notNull().default({}),
    createdBy: text('created_by').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_appointment_availability_account_created').on(
      table.accountId,
      table.createdAt
    ),
    index('idx_appointment_availability_contact').on(table.contactId),
    index('idx_appointment_availability_conversation').on(table.conversationId),
    check(
      'appointment_availability_send_mode_check',
      sql`${table.sendMode} in ('booking_link', 'interactive_list', 'cta_url')`
    ),
  ]
);

export const aiUsageLog = pgTable(
  'ai_usage_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    mode: text('mode').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_ai_usage_log_account_created').on(
      table.accountId,
      table.createdAt
    ),
    check(
      'ai_usage_log_mode_check',
      sql`${table.mode} in ('auto_reply', 'draft')`
    ),
    check(
      'ai_usage_log_provider_check',
      sql`${table.provider} in ('openai', 'anthropic')`
    ),
  ]
);

export const aiConfigs = pgTable(
  'ai_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .unique()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    apiKey: text('api_key').notNull(),
    systemPrompt: text('system_prompt'),
    isActive: boolean('is_active').notNull().default(false),
    autoReplyEnabled: boolean('auto_reply_enabled').notNull().default(false),
    autoReplyMaxPerConversation: integer('auto_reply_max_per_conversation')
      .notNull()
      .default(3),
    handoffAgentId: text('handoff_agent_id').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    embeddingsApiKey: text('embeddings_api_key'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      'ai_configs_provider_check',
      sql`${table.provider} in ('openai', 'anthropic')`
    ),
    check(
      'ai_configs_auto_reply_max_check',
      sql`${table.autoReplyMaxPerConversation} between 1 and 20`
    ),
  ]
);

export const aiKnowledgeDocuments = pgTable(
  'ai_knowledge_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('ai_knowledge_documents_account_id_idx').on(table.accountId),
  ]
);

export const aiKnowledgeChunks = pgTable(
  'ai_knowledge_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => aiKnowledgeDocuments.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    embedding: text('embedding'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('ai_knowledge_chunks_account_id_idx').on(table.accountId),
    index('ai_knowledge_chunks_document_id_idx').on(table.documentId),
    uniqueIndex('ai_knowledge_chunks_document_index_key').on(
      table.documentId,
      table.chunkIndex
    ),
  ]
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('conversation_assigned'),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    actorUserId: text('actor_user_id').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    body: text('body'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_notifications_user_created').on(table.userId, table.createdAt),
    index('idx_notifications_user_unread').on(table.userId),
  ]
);

export const memberPresence = pgTable(
  'member_presence',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => crmAccounts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('online'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('member_presence_account_user_key').on(
      table.accountId,
      table.userId
    ),
    index('idx_member_presence_account').on(table.accountId),
  ]
);

export const authUserRelations = relations(authUser, ({ many }) => ({
  sessions: many(authSession),
  authAccounts: many(authAccount),
  profiles: many(profiles),
}));

export const authSessionRelations = relations(authSession, ({ one }) => ({
  user: one(authUser, {
    fields: [authSession.userId],
    references: [authUser.id],
  }),
}));

export const authAccountRelations = relations(authAccount, ({ one }) => ({
  user: one(authUser, {
    fields: [authAccount.userId],
    references: [authUser.id],
  }),
}));

export const crmAccountRelations = relations(crmAccounts, ({ one, many }) => ({
  owner: one(authUser, {
    fields: [crmAccounts.ownerUserId],
    references: [authUser.id],
  }),
  profiles: many(profiles),
  contacts: many(contacts),
  conversations: many(conversations),
}));

export const profileRelations = relations(profiles, ({ one }) => ({
  user: one(authUser, {
    fields: [profiles.userId],
    references: [authUser.id],
  }),
  account: one(crmAccounts, {
    fields: [profiles.accountId],
    references: [crmAccounts.id],
  }),
}));

export const contactRelations = relations(contacts, ({ one, many }) => ({
  account: one(crmAccounts, {
    fields: [contacts.accountId],
    references: [crmAccounts.id],
  }),
  conversations: many(conversations),
}));

export const conversationRelations = relations(
  conversations,
  ({ one, many }) => ({
    account: one(crmAccounts, {
      fields: [conversations.accountId],
      references: [crmAccounts.id],
    }),
    contact: one(contacts, {
      fields: [conversations.contactId],
      references: [contacts.id],
    }),
    messages: many(messages),
  })
);

export const messageRelations = relations(messages, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  reactions: many(messageReactions),
}));

export const messageReactionRelations = relations(
  messageReactions,
  ({ one }) => ({
    message: one(messages, {
      fields: [messageReactions.messageId],
      references: [messages.id],
    }),
    conversation: one(conversations, {
      fields: [messageReactions.conversationId],
      references: [conversations.id],
    }),
  })
);
