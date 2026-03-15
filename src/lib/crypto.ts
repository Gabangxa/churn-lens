import { randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) throw new Error('ENCRYPTION_KEY is not set');
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars)');
  return buf;
}

export function encryptApiKey(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export interface SurveyTokenPayload {
  orgId: string;
  customerId: string;
  subscriptionId: string;
  exp: number;
}

/**
 * Sign a survey token payload. Returns a tamper-proof base64url string.
 * Format: base64url(JSON(payload)).HMAC-SHA256(payload)
 */
export function signSurveyToken(payload: SurveyTokenPayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const key = getEncryptionKey();
  const sig = createHmac('sha256', key).update(`survey_token.${data}`).digest('base64url');
  return `${data}.${sig}`;
}

/**
 * Verify a survey token. Returns the decoded payload or null if invalid/tampered.
 */
export function verifySurveyToken(token: string): SurveyTokenPayload | null {
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return null;
  const data = token.substring(0, lastDot);
  const sig = token.substring(lastDot + 1);
  const key = getEncryptionKey();
  const expected = createHmac('sha256', key).update(`survey_token.${data}`).digest('base64url');
  const sigBuf = Buffer.from(sig, 'base64url');
  const expectedBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString()) as SurveyTokenPayload;
  } catch {
    return null;
  }
}

export function decryptApiKey(ciphertext: string): string {
  const key = getEncryptionKey();
  const data = Buffer.from(ciphertext, 'base64');
  const minLength = IV_LENGTH + AUTH_TAG_LENGTH + 1;
  if (data.length < minLength) {
    throw new Error('Invalid ciphertext: payload too short');
  }
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}
