import { describe, it, expect, beforeAll } from 'vitest';
import { encryptApiKey, decryptApiKey, signSurveyToken, verifySurveyToken } from '../crypto';

// 32-byte key expressed as 64 hex chars — used only in tests.
const TEST_KEY = 'a'.repeat(64);

beforeAll(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
});

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

  it('returns a payload even for an already-expired token (caller checks exp)', () => {
    const expired = signSurveyToken({ ...VALID_PAYLOAD, exp: Date.now() - 1 });
    const result = verifySurveyToken(expired);
    // verifySurveyToken only checks integrity, not expiry — the route handler checks exp.
    expect(result).not.toBeNull();
    expect(result!.exp).toBeLessThan(Date.now());
  });
});
