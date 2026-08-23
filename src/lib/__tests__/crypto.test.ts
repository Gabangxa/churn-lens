import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createCipheriv, randomBytes } from 'crypto';
import {
  encryptApiKey,
  decryptApiKey,
  signSurveyToken,
  verifySurveyToken,
  generateLoginToken,
  hashLoginToken,
} from '../crypto';

// 32-byte key expressed as 64 hex chars — used only in tests.
const TEST_KEY = 'a'.repeat(64);

beforeAll(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
});

/**
 * Writing the versioned format is opt-in (see the staged-rollout note in
 * crypto.ts). Tests that assert on v1 output have to turn the writer on; the
 * default stays off so the "what does an un-flagged deploy emit" tests are
 * exercising the real production default.
 */
function withV1Writes() {
  process.env.ENCRYPTION_WRITE_VERSION = '1';
}

afterEach(() => {
  delete process.env.ENCRYPTION_WRITE_VERSION;
});

// Byte offsets inside the decoded payload: iv[0..11] || authTag[12..27] || ciphertext[28..]
const IV_START = 0;
const AUTH_TAG_START = 12;
const CIPHERTEXT_START = 28;

/**
 * Build a ciphertext in the ORIGINAL, pre-versioning layout — plain
 * base64(iv || authTag || ciphertext) with no "v1." prefix. Deliberately
 * written out with node crypto rather than by stripping the prefix off a fresh
 * encryptApiKey call, so this stays a true reproduction of what is already
 * sitting in organizations.stripe_api_key_enc even if encryptApiKey changes.
 */
function encryptLegacyV0(plaintext: string): string {
  const key = Buffer.from(TEST_KEY, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

/** Split a "v1.<base64>" value into its prefix and its decoded payload bytes. */
function decodeV1(stored: string): { prefix: string; bytes: Buffer } {
  const dot = stored.indexOf('.');
  return {
    prefix: stored.slice(0, dot + 1),
    bytes: Buffer.from(stored.slice(dot + 1), 'base64'),
  };
}

/** Flip one byte of a v1 payload and re-wrap it in its original prefix. */
function tamperV1ByteAt(stored: string, index: number): string {
  const { prefix, bytes } = decodeV1(stored);
  bytes[index] ^= 0xff;
  return prefix + bytes.toString('base64');
}

// ─── encryptApiKey / decryptApiKey ───────────────────────────────────────────

describe('encryptApiKey / decryptApiKey', () => {
  it('round-trips plaintext correctly', () => {
    const plaintext = 'rk_live_supersecretkey';
    const ciphertext = encryptApiKey(plaintext);
    expect(decryptApiKey(ciphertext)).toBe(plaintext);
  });

  it('produces different ciphertext on each call (random IV)', () => {
    const a = encryptApiKey('same-value');
    const b = encryptApiKey('same-value');
    expect(a).not.toBe(b);
  });

  it('throws when ciphertext is truncated', () => {
    const ciphertext = encryptApiKey('value');
    const truncated = Buffer.from(ciphertext, 'base64').subarray(0, 5).toString('base64');
    expect(() => decryptApiKey(truncated)).toThrow();
  });

  it('throws when ciphertext is tampered', () => {
    const ciphertext = encryptApiKey('value');
    const buf = Buffer.from(ciphertext, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip last byte
    expect(() => decryptApiKey(buf.toString('base64'))).toThrow();
  });
});

// ─── ciphertext versioning ───────────────────────────────────────────────────

describe('encrypted payload versioning', () => {
  // THE rollback guarantee. The reader below accepts v0 and v1, but the
  // PREVIOUS build's reader has no prefix handling at all, and Node's base64
  // decoder is non-strict — it drops the '.' and decodes the rest misaligned
  // rather than failing fast. So a deploy that writes v1 immediately is a
  // one-way door: rolling back bricks every org that reconnected Stripe in the
  // window. Writes stay v0 until the flag is set, which is what makes the two
  // deploys independent.
  it('writes the unprefixed v0 format by default, so a rollback can still read it', () => {
    const stored = encryptApiKey('rk_live_abc');

    expect(stored).not.toMatch(/^v\d+\./);
    expect(stored).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(decryptApiKey(stored)).toBe('rk_live_abc');
  });

  it.each([undefined, '', '0', 'true', 'yes', '2'])(
    'keeps writing v0 when ENCRYPTION_WRITE_VERSION is %o',
    (value) => {
      if (value === undefined) delete process.env.ENCRYPTION_WRITE_VERSION;
      else process.env.ENCRYPTION_WRITE_VERSION = value;

      expect(encryptApiKey('rk_live_abc')).not.toMatch(/^v\d+\./);
    },
  );

  it('tags new ciphertext with the v1 prefix once ENCRYPTION_WRITE_VERSION=1', () => {
    withV1Writes();

    expect(encryptApiKey('rk_live_abc')).toMatch(/^v1\./);
  });

  it('reads v1 back regardless of which format the writer is currently emitting', () => {
    withV1Writes();
    const stored = encryptApiKey('rk_live_abc');

    delete process.env.ENCRYPTION_WRITE_VERSION; // deploy rolled the flag back off

    expect(decryptApiKey(stored)).toBe('rk_live_abc');
  });

  it('round-trips a v1 value, including multi-byte UTF-8', () => {
    withV1Writes();
    const plaintext = 'rk_live_ünïcødé_🔑_密鑰';
    const stored = encryptApiKey(plaintext);

    expect(stored.startsWith('v1.')).toBe(true);
    expect(decryptApiKey(stored)).toBe(plaintext);
  });

  it('keeps the version separator out of the payload', () => {
    // '.' is outside the base64 alphabet, so the split must stay unambiguous no
    // matter which random IV comes up. Repeat to cover many payloads.
    withV1Writes();
    for (let i = 0; i < 25; i++) {
      const stored = encryptApiKey('same-value');
      const [prefix, payload, ...rest] = stored.split('.');
      expect(prefix).toBe('v1');
      expect(rest).toEqual([]);
      expect(payload).toMatch(/^[A-Za-z0-9+/=]+$/);
    }
  });

  // THE compatibility guarantee: every key already stored in the database was
  // written without a prefix. If this fails, shipping the change silently
  // breaks every existing Stripe connection.
  it('LEGACY: decrypts an unprefixed v0 ciphertext written before versioning existed', () => {
    const plaintext = 'rk_live_written_before_the_prefix';
    const legacy = encryptLegacyV0(plaintext);

    expect(legacy).not.toMatch(/^v\d+\./);
    expect(decryptApiKey(legacy)).toBe(plaintext);
  });

  it('LEGACY: v0 and v1 payloads are byte-identical apart from the prefix', () => {
    // Same reader serves both, so a v1 value with its prefix removed must
    // decrypt as a legacy value — and vice versa.
    withV1Writes();
    const plaintext = 'rk_live_shared_layout';
    const stored = encryptApiKey(plaintext);
    const withoutPrefix = stored.slice('v1.'.length);

    expect(decryptApiKey(withoutPrefix)).toBe(plaintext);
    expect(decryptApiKey(`v1.${encryptLegacyV0(plaintext)}`)).toBe(plaintext);
  });

  it('names the unrecognized version when the prefix is from a newer build', () => {
    withV1Writes();
    const payload = encryptApiKey('value').slice('v1.'.length);

    // Asserting on the message matters: falling through to the v0 parser would
    // also throw, but with a misleading auth-tag error.
    expect(() => decryptApiKey(`v9.${payload}`)).toThrow(/v9/);
    expect(() => decryptApiKey(`v9.${payload}`)).toThrow(/version/i);
  });

  it.each([
    ['IV', IV_START],
    ['auth tag', AUTH_TAG_START],
    ['ciphertext', CIPHERTEXT_START],
  ])('fails the GCM auth tag when the %s region of a v1 value is tampered', (_region, index) => {
    withV1Writes();
    const stored = encryptApiKey('value-long-enough-to-tamper');

    expect(() => decryptApiKey(tamperV1ByteAt(stored, index))).toThrow();
  });

  it.each([
    ['prefixed', (payload: string) => `v1.${payload}`],
    ['unprefixed legacy', (payload: string) => payload],
  ])('rejects a %s payload that is too short to hold an IV and tag', (_form, wrap) => {
    const short = randomBytes(20).toString('base64'); // < 12 + 16 + 1 bytes

    expect(() => decryptApiKey(wrap(short))).toThrow('Invalid ciphertext: payload too short');
  });

  it('treats an empty string as a too-short legacy value, not an unknown version', () => {
    expect(() => decryptApiKey('')).toThrow('Invalid ciphertext: payload too short');
  });
});

// ─── signSurveyToken / verifySurveyToken ─────────────────────────────────────

const VALID_PAYLOAD = {
  orgId: 'org-123',
  customerId: 'cus_abc',
  subscriptionId: 'sub_xyz',
  exp: Date.now() + 60_000,
};

describe('signSurveyToken / verifySurveyToken', () => {
  it('round-trips a valid payload', () => {
    const token = signSurveyToken(VALID_PAYLOAD);
    const result = verifySurveyToken(token);
    expect(result).toMatchObject(VALID_PAYLOAD);
  });

  it('returns null for a plain base64 token (unsigned legacy format)', () => {
    const legacy = Buffer.from(JSON.stringify(VALID_PAYLOAD)).toString('base64url');
    expect(verifySurveyToken(legacy)).toBeNull();
  });

  it('returns null when the signature is tampered', () => {
    const token = signSurveyToken(VALID_PAYLOAD);
    const tampered = token.slice(0, -4) + 'AAAA';
    expect(verifySurveyToken(tampered)).toBeNull();
  });

  it('returns null when the payload is tampered', () => {
    const token = signSurveyToken(VALID_PAYLOAD);
    const [data, sig] = [token.substring(0, token.lastIndexOf('.')), token.substring(token.lastIndexOf('.') + 1)];
    const mutated = Buffer.from(data, 'base64url').toString().replace('org-123', 'org-evil');
    const tamperedToken = `${Buffer.from(mutated).toString('base64url')}.${sig}`;
    expect(verifySurveyToken(tamperedToken)).toBeNull();
  });

  it('returns null when token has no dot separator', () => {
    expect(verifySurveyToken('nodothere')).toBeNull();
  });

  // The ciphertext version prefix also uses '.', but survey tokens are a
  // separate format and must not have picked one up.
  it('is unaffected by the ciphertext version prefix', () => {
    const token = signSurveyToken(VALID_PAYLOAD);

    expect(token).not.toMatch(/^v\d+\./);
    expect(token.split('.')).toHaveLength(2);
    expect(token).toMatch(/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/);
    expect(verifySurveyToken(token)).toMatchObject(VALID_PAYLOAD);
  });

  it('returns a payload even for an already-expired token (caller checks exp)', () => {
    const expired = signSurveyToken({ ...VALID_PAYLOAD, exp: Date.now() - 1 });
    const result = verifySurveyToken(expired);
    // verifySurveyToken only checks integrity, not expiry — the route handler checks exp.
    expect(result).not.toBeNull();
    expect(result!.exp).toBeLessThan(Date.now());
  });
});

// ─── generateLoginToken / hashLoginToken ─────────────────────────────────────

describe('generateLoginToken / hashLoginToken', () => {
  it('hash matches the token it was generated from', () => {
    const { token, tokenHash } = generateLoginToken();
    expect(hashLoginToken(token)).toBe(tokenHash);
  });

  it('is a stable 64-char hex sha256', () => {
    const { tokenHash } = generateLoginToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a unique token on each call', () => {
    const a = generateLoginToken();
    const b = generateLoginToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});
