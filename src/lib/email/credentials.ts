import { decrypt, encrypt } from '@/lib/whatsapp/encryption';

export interface EmailCredentials {
  imap_user: string;
  imap_password: string;
  smtp_user: string;
  smtp_password: string;
}

export function encryptEmailCredentials(input: {
  imapUser: string;
  imapPassword: string;
  smtpUser: string;
  smtpPassword: string;
}): Record<keyof EmailCredentials, string> {
  return {
    imap_user: encrypt(input.imapUser),
    imap_password: encrypt(input.imapPassword),
    smtp_user: encrypt(input.smtpUser),
    smtp_password: encrypt(input.smtpPassword),
  };
}

export function decryptEmailCredentials(
  encrypted: Record<string, unknown>,
): EmailCredentials {
  const imapUser = encrypted.imap_user;
  const imapPassword = encrypted.imap_password;
  const smtpUser = encrypted.smtp_user;
  const smtpPassword = encrypted.smtp_password;
  if (
    typeof imapUser !== 'string' ||
    typeof imapPassword !== 'string' ||
    typeof smtpUser !== 'string' ||
    typeof smtpPassword !== 'string'
  ) {
    throw new Error('Email credentials are incomplete.');
  }

  return {
    imap_user: decrypt(imapUser),
    imap_password: decrypt(imapPassword),
    smtp_user: decrypt(smtpUser),
    smtp_password: decrypt(smtpPassword),
  };
}
