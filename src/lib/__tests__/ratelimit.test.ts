import { describe, it, expect } from 'vitest';
import { clientIp } from '../ratelimit';

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/whatever', { headers });
}

describe('clientIp', () => {
  it('takes the LAST hop of X-Forwarded-For, not the first', () => {
    // Railway's edge proxy is the last hop to touch the header before this
    // process sees it; every earlier entry is whatever the client (or an
    // upstream proxy relaying the client's own header) chose to send.
    const req = requestWithHeaders({ 'x-forwarded-for': '1.2.3.4, 10.0.0.5, 203.0.113.9' });
    expect(clientIp(req)).toBe('203.0.113.9');
  });

  it('trims whitespace around the last hop', () => {
    const req = requestWithHeaders({ 'x-forwarded-for': '1.2.3.4,  203.0.113.9  ' });
    expect(clientIp(req)).toBe('203.0.113.9');
  });

  it('returns the only hop when there is just one', () => {
    const req = requestWithHeaders({ 'x-forwarded-for': '203.0.113.9' });
    expect(clientIp(req)).toBe('203.0.113.9');
  });

  it('falls back to X-Real-IP when X-Forwarded-For is absent', () => {
    const req = requestWithHeaders({ 'x-real-ip': '203.0.113.9' });
    expect(clientIp(req)).toBe('203.0.113.9');
  });

  it('falls back to X-Real-IP when X-Forwarded-For is present but empty', () => {
    const req = requestWithHeaders({ 'x-forwarded-for': '', 'x-real-ip': '203.0.113.9' });
    expect(clientIp(req)).toBe('203.0.113.9');
  });

  it('returns "unknown" when neither header is present', () => {
    const req = requestWithHeaders({});
    expect(clientIp(req)).toBe('unknown');
  });

  it('is not fooled by a spoofed first hop claiming a different IP', () => {
    // A single attacker can put anything they like as the first entry
    // (X-Forwarded-For: 1.2.3.4) to try to dodge a per-IP rate limit keyed on
    // the first hop. Only the proxy-appended last hop is trustworthy.
    const spoofed = requestWithHeaders({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' });
    const real = requestWithHeaders({ 'x-forwarded-for': '2.2.2.2, 203.0.113.9' });
    expect(clientIp(spoofed)).toBe(clientIp(real));
  });
});
