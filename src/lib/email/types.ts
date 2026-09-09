export type EmailMailboxKind = 'personal' | 'shared';
export type EmailFolderKind = 'inbox' | 'sent' | 'archive' | 'trash' | 'custom';
export type EmailRuleField =
  | 'from'
  | 'from_domain'
  | 'subject'
  | 'body'
  | 'to'
  | 'cc'
  | 'to_or_cc'
  | 'recipients'
  | 'age_days'
  | 'size_kb'
  | 'has_attachment';
export type EmailRuleOperator =
  | 'contains'
  | 'not_contains'
  | 'equals'
  | 'not_equals'
  | 'starts_with'
  | 'ends_with'
  | 'exists'
  | 'not_exists'
  | 'greater_than'
  | 'less_than';
export type EmailRuleAction =
  | 'move_to'
  | 'copy_to'
  | 'mark_read'
  | 'mark_unread'
  | 'star'
  | 'label';

export interface EmailPermissionSet {
  canRead: boolean;
  canMove: boolean;
  canClassify: boolean;
  canSend: boolean;
}

export interface CreateEmailAccountInput {
  label: string;
  emailAddress: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string;
  imapPassword: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  syncMailbox: string;
  mailboxKind: EmailMailboxKind;
  ownerUserId?: string | null;
}

export interface ThunderbirdRuleInput {
  name: string;
  field: EmailRuleField;
  operator: EmailRuleOperator;
  value: string;
  targetFolderName: string;
  action: EmailRuleAction;
  actionValue?: string;
  enabled: boolean;
}
