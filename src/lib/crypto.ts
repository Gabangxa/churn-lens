import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  timingSafeEqual,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Stored wire format for encrypted secrets (organizations.stripe_api_key_enc,
 * organizations.stripe_webhook_secret_enc):
 *
 *   v1  "v1." + base64(iv[12] || authTag[16] || ciphertext)   aes-256-gcm
 *   v0          base64(iv[12] || authTag[16] || ciphertext)   aes-256-gcm  (legacy, unprefixed)
 *
 * v0 and v1 are byte-identical apart from the prefix. The prefix buys nothing
 * today; it exists so the NEXT change is cheap. Without a version marker,
 * rotating ENCRYPTION_KEY or moving off aes-256-gcm means every stored row has
 * to be rewritten in a single flag-day migration, because nothing can tell old
 * ciphertext from new. With it, a v2 writer ships alongside a reader that still
 * accepts v0 and v1, and rows get re-encrypted at their own pace.
 *
 * '.' is the separator because it is outside the base64 alphabet
 * (A-Za-z0-9+/=), so it can never occur inside the payload — the split is
 * unambiguous.
 *
 * To add v2: bump CURRENT_VERSION, emit the new payload in encryptApiKey, and
 * add one branch to decryptApiKey. Old branches stay until the old rows are gone.
 *
 * WRITES ARE STAGED, READS ARE NOT. The reader accepts v0 and v1 from the moment
 * it ships; the writer keeps emitting v0 until ENCRYPTION_WRITE_VERSION=1 is set.
 * That ordering is what keeps a rollback survivable: the previous build's reader
 * has no prefix handling and Node's base64 decoder is non-strict, so it would
 * decode a 'v1.'-prefixed value misaligned rather than fail fast, and every
 * Stripe webhook for that org would 500 until Stripe disabled the endpoint.
 * Flip the flag only once THIS build is the confirmed rollback target.
 */
const CURRENT_VERSION = 1;
const LEGACY_VERSION = 0;
const VERSION_PREFIX = /^v(\d+)\./;

/**
 * Which format new ciphertext is written in. Defaults to v0 (unprefixed), the
 * format every already-deployed build can read.
 */
function getWriteVersion(): number {
  return process.env.ENCRYPTION_WRITE_VERSION === '1' ? CURRENT_VERSION : LEGACY_VERSION;
}

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
  const payload = Buffer.concat([iv, authTag, encrypted]).toString('base64');
  const version = getWriteVersion();
  return version === LEGACY_VERSION ? payload : `v${version}.${payload}`;
}

export interface SurveyTokenPayload {
  orgId: string;
  customerId: string;
  subscriptionId: string;
  exp: number;
  /**
   * Distinguishes non-production tokens: 'preview' renders the survey without
   * persisting anything; 'test' behaves like a real survey but the response
   * row is flagged is_test. Absent for real customer surveys.
   */
  kind?: 'preview' | 'test';
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

/**
 * Generate a magic-link login token. Returns the raw token (goes in the emailed
 * link) and its SHA-256 hash (the only form stored in the DB, so a database leak
 * yields no usable links). The raw token is 32 random bytes = 256 bits, so it is
 * not feasibly guessable and lookup-by-hash needs no constant-time compare.
 */
export function generateLoginToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashLoginToken(token) };
}

/** SHA-256 hex of a login token, for verify-time lookup. */
export function hashLoginToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Split a stored value into its version and its base64 payload. A value with no
 * recognized `v<N>.` prefix is legacy v0, written before versioning existed.
 */
function parseVersionedPayload(stored: string): { version: number; payload: string } {
  const match = VERSION_PREFIX.exec(stored);
  if (!match) return { version: LEGACY_VERSION, payload: stored };
  return { version: Number(match[1]), payload: stored.slice(match[0].length) };
}

/** Decrypt the aes-256-gcm layout shared by v0 and v1: iv || authTag || ciphertext. */
function decryptAesGcmPayload(payload: string): string {
  const key = getEncryptionKey();
  const data = Buffer.from(payload, 'base64');
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

export function decryptApiKey(stored: string): string {
  const { version, payload } = parseVersionedPayload(stored);

  // v0 (legacy, unprefixed) and v1 share the same layout, so one reader serves
  // both. An unrecognized version means the value was written by a build we do
  // not understand — say so, rather than handing it to the v0 parser and
  // surfacing it as a misleading auth-tag failure.
  if (version === LEGACY_VERSION || version === CURRENT_VERSION) {
    return decryptAesGcmPayload(payload);
  }
  throw new Error(
    `Unsupported encrypted payload version "v${version}": this build reads v${LEGACY_VERSION} (legacy, unprefixed) and v${CURRENT_VERSION}. The value was likely written by a newer deploy.`,
  );
}
