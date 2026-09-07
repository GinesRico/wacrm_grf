export type EmailMailboxKind = 'personal' | 'shared';
export type EmailFolderKind = 'inbox' | 'sent' | 'archive' | 'trash' | 'custom';
export type EmailRuleField = 'from' | 'from_domain' | 'subject' | 'to' | 'cc';
export type EmailRuleOperator = 'contains' | 'equals' | 'starts_with' | 'ends_with';

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
  enabled: boolean;
}
