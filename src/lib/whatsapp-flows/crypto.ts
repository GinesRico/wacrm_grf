import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  privateDecrypt,
} from 'crypto';
import { readFileSync } from 'fs';

export interface EncryptedMetaFlowRequest {
  encrypted_flow_data: string;
  encrypted_aes_key: string;
  initial_vector: string;
}

export interface DecryptedMetaFlowRequest<T = Record<string, unknown>> {
  body: T;
  aesKey: Buffer;
  initialVector: Buffer;
}

export function decryptMetaFlowRequest<T = Record<string, unknown>>(
  request: EncryptedMetaFlowRequest
): DecryptedMetaFlowRequest<T> {
  const aesKey = privateDecrypt(
    {
      key: createPrivateKey({
        key: getPrivateKey(),
        passphrase: process.env.WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE,
      }),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(request.encrypted_aes_key, 'base64')
  );
  const initialVector = Buffer.from(request.initial_vector, 'base64');
  const encryptedFlowData = Buffer.from(request.encrypted_flow_data, 'base64');
  const tag = encryptedFlowData.subarray(encryptedFlowData.length - 16);
  const ciphertext = encryptedFlowData.subarray(
    0,
    encryptedFlowData.length - 16
  );
  const decipher = createDecipheriv('aes-128-gcm', aesKey, initialVector);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');

  return {
    body: JSON.parse(decrypted) as T,
    aesKey,
    initialVector,
  };
}

export function encryptMetaFlowResponse(
  response: Record<string, unknown>,
  aesKey: Buffer,
  initialVector: Buffer
): string {
  const responseIv = Buffer.from(initialVector.map((byte) => byte ^ 0xff));
  const cipher = createCipheriv('aes-128-gcm', aesKey, responseIv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(response), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64');
}

function getPrivateKey(): string {
  if (process.env.WHATSAPP_FLOW_PRIVATE_KEY) {
    return process.env.WHATSAPP_FLOW_PRIVATE_KEY.replace(/\\n/g, '\n');
  }
  if (process.env.WHATSAPP_FLOW_PRIVATE_KEY_PATH) {
    return readFileSync(process.env.WHATSAPP_FLOW_PRIVATE_KEY_PATH, 'utf8');
  }
  throw new Error(
    'Set WHATSAPP_FLOW_PRIVATE_KEY or WHATSAPP_FLOW_PRIVATE_KEY_PATH.'
  );
}
