import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { publicAppUrl, redirectUrl } from '../app-url';

// The bug this guards against: behind Railway's proxy req.url is
// https://localhost:8080, so redirects built from it dead-end on a host the
// user's browser can't reach.
const PROXY_INTERNAL_URL = 'https://localhost:8080/api/auth/verify?token=abc';
const PUBLIC_URL = 'https://churn-lens-production.up.railway.app';

const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

describe('publicAppUrl', () => {
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  });

  it('returns the configured https origin', () => {
    process.env.NEXT_PUBLIC_APP_URL = PUBLIC_URL;
    expect(publicAppUrl()).toBe(PUBLIC_URL);
  });

  it('returns null when unset', () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(publicAppUrl()).toBeNull();
  });

  it('returns null for a non-https origin, so http dev URLs never leak into prod redirects', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:5000';
    expect(publicAppUrl()).toBeNull();
  });
});

describe('redirectUrl', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = PUBLIC_URL;
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  });

  it('resolves against the public URL, ignoring the proxy-internal req.url', () => {
    const req = new Request(PROXY_INTERNAL_URL);
    expect(redirectUrl('/dashboard', req).toString()).toBe(`${PUBLIC_URL}/dashboard`);
  });

  it('preserves query strings', () => {
    const req = new Request(PROXY_INTERNAL_URL);
    expect(redirectUrl('/login?error=expired', req).toString()).toBe(
      `${PUBLIC_URL}/login?error=expired`,
    );
  });

  it('never returns a localhost host when the public URL is set', () => {
    const req = new Request(PROXY_INTERNAL_URL);
    for (const path of ['/dashboard', '/survey/thanks', '/survey/unsubscribed', '/onboarding']) {
      expect(redirectUrl(path, req).host).toBe('churn-lens-production.up.railway.app');
    }
  });

  it('falls back to req.url in local dev, where the app URL is http', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:5000';
    const req = new Request('http://localhost:5000/api/survey');
    expect(redirectUrl('/survey/thanks', req).toString()).toBe(
      'http://localhost:5000/survey/thanks',
    );
  });

  it('falls back to req.url when the app URL is unset entirely', () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const req = new Request('http://localhost:5000/api/survey');
    expect(redirectUrl('/survey/thanks', req).toString()).toBe(
      'http://localhost:5000/survey/thanks',
    );
  });
});
