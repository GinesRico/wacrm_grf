import type {
  contactCustomValues,
  contactNotes,
  contacts,
  customFields,
  tags,
} from "@/db/schema";

export function serializeContact(row: typeof contacts.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    phone: row.phone,
    phone_normalized: row.phoneNormalized,
    name: row.name,
    email: row.email,
    company: row.company,
    avatar_url: row.avatarUrl,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function serializeTag(row: typeof tags.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    name: row.name,
    color: row.color,
    created_at: row.createdAt.toISOString(),
  };
}

export function serializeNote(row: typeof contactNotes.$inferSelect) {
  return {
    id: row.id,
    contact_id: row.contactId,
    account_id: row.accountId,
    user_id: row.userId,
    note_text: row.noteText,
    created_at: row.createdAt.toISOString(),
  };
}

export function serializeCustomField(row: typeof customFields.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    field_name: row.fieldName,
    field_type: row.fieldType,
    field_options: row.fieldOptions,
    created_at: row.createdAt.toISOString(),
  };
}

export function serializeCustomValue(row: typeof contactCustomValues.$inferSelect) {
  return {
    id: row.id,
    contact_id: row.contactId,
    custom_field_id: row.customFieldId,
    value: row.value,
  };
}
