import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

/**
 * The session signature must be compared in constant time. That property is
 * invisible in requireOrgId's return value — a forged cookie is rejected
 * either way — so this file is the deliberate exception to testing through
 * outputs alone: it pins the mechanism. It does so at the level that matters,
 * though: not "timingSafeEqual was called somewhere", but "its answer is the
 * verdict". Force it to say "equal" and a forged signature gets in; nothing
 * else in the path may be quietly comparing the bytes first.
 *
 * Its own file because mocking a Node built-in is module-wide.
 */
const timingSafeEqualSpy = vi.hoisted(() => ({ current: null as ReturnType<typeof vi.fn> | null }));
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  const spy = vi.fn(actual.timingSafeEqual);
  timingSafeEqualSpy.current = spy;
  return { ...actual, default: { ...actual, timingSafeEqual: spy }, timingSafeEqual: spy };
});

// "The org exists and was never signed out" — the database is not what this
// file is about (see auth.db.test.ts).
vi.mock('@/lib/db', () => ({
  queryOne: async () => ({ sessions_valid_after: null }),
}));

import { requireOrgId, setOrgCookie } from '../auth';

const COOKIE_NAME = 'churnlens_org_id';

function spy() {
  if (!timingSafeEqualSpy.current) throw new Error('crypto mock not installed');
  return timingSafeEqualSpy.current;
}

function forgedCookie(): { cookie: string; forgedSignature: string } {
  const carrier = new NextResponse();
  setOrgCookie(carrier, 'org-xyz');
  const [orgId, issuedAt, signature] = carrier.cookies.get(COOKIE_NAME)!.value.split('.');
  const forgedSignature = (signature[0] === '0' ? '1' : '0') + signature.slice(1);
  return { cookie: `${orgId}.${issuedAt}.${forgedSignature}`, forgedSignature };
}

function requestWithCookie(value: string) {
  return new NextRequest('http://localhost/', { headers: { cookie: `${COOKIE_NAME}=${value}` } });
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'b'.repeat(64);
  spy().mockClear();
});

describe('session signature comparison', () => {
  it('compares the presented signature with crypto.timingSafeEqual, on equal-length buffers', async () => {
    const { cookie, forgedSignature } = forgedCookie();

    const result = await requireOrgId(requestWithCookie(cookie));

    expect('error' in result).toBe(true);
    expect(spy()).toHaveBeenCalledTimes(1);
    const [a, b] = spy().mock.calls[0] as [Buffer, Buffer];
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    // One side is exactly what the client sent.
    expect([a.toString('hex'), b.toString('hex')]).toContain(forgedSignature);
  });

  it('lets timingSafeEqual alone decide — if it said "equal", the forged cookie would be accepted', async () => {
    const { cookie } = forgedCookie();
    spy().mockReturnValueOnce(true);

    const result = await requireOrgId(requestWithCookie(cookie));

    expect(result).toEqual({ orgId: 'org-xyz' });
  });
});
