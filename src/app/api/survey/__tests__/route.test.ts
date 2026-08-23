import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';

import type { SurveyTokenPayload } from '@/lib/crypto';
import type { SurveyConfig } from '@/lib/survey-config';

const executeMock = vi.fn();
const queryOneMock = vi.fn();
vi.mock('@/lib/db', () => ({
  execute: (...args: unknown[]) => executeMock(...args),
  queryOne: (...args: unknown[]) => queryOneMock(...args),
}));

const verifySurveyTokenMock = vi.fn();
vi.mock('@/lib/crypto', () => ({
  verifySurveyToken: (...args: unknown[]) => verifySurveyTokenMock(...args),
}));

// Partial mock: the route validates against the REAL BUILTIN_CANCELLATION_REASONS
// (so this test can't drift from the list the survey page renders) while
// loadSurveyConfig is stubbed to stand in for a given org's stored config.
const loadSurveyConfigMock = vi.fn();
vi.mock('@/lib/survey-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/survey-config')>();
  return {
    ...actual,
    loadSurveyConfig: (...args: unknown[]) => loadSurveyConfigMock(...args),
  };
});

import { POST } from '../route';
import { BUILTIN_CANCELLATION_REASONS } from '@/lib/survey-config';
import { MAX_COMEBACK_TEXT, MAX_OPEN_TEXT, MAX_REASON } from '@/lib/survey-limits';

const ORG_ID = 'org-abc';
const TOKEN = 'signed.token';
const BUILTIN_REASON = 'Too expensive for my budget';
const CUSTOM_REASON = 'Billing was confusing';

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

// Column order of the UPDATE's parameter array.
const P_REASON = 0;
const P_OPEN_TEXT = 1;
const P_COMEBACK_TEXT = 2;

function surveyRequest(fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new NextRequest('http://localhost/api/survey', { method: 'POST', body: form });
}

function tokenPayload(overrides: Partial<SurveyTokenPayload> = {}): SurveyTokenPayload {
  return {
    orgId: ORG_ID,
    customerId: 'cus_abc',
    subscriptionId: 'sub_xyz',
    exp: Date.now() + 60_000,
    ...overrides,
  };
}

function config(overrides: Partial<SurveyConfig> = {}): SurveyConfig {
  return { displayName: null, logoUrl: null, customReasons: [], ...overrides };
}

/** The params array of the single UPDATE the route issued. */
function updateParams(): unknown[] {
  expect(executeMock).toHaveBeenCalledTimes(1);
  return executeMock.mock.calls[0][1] as unknown[];
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.churnlens.com';
  executeMock.mockReset();
  executeMock.mockResolvedValue(1);
  queryOneMock.mockReset();
  verifySurveyTokenMock.mockReset();
  verifySurveyTokenMock.mockReturnValue(tokenPayload());
  loadSurveyConfigMock.mockReset();
  loadSurveyConfigMock.mockResolvedValue(config());
  // The route logs a warn on every truncation and every rejected reason; the
  // tests assert on those paths deliberately, so keep the output quiet.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

afterAll(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
});

// ─── free-text caps ──────────────────────────────────────────────────────────

describe('POST /api/survey — free-text caps', () => {
  it('truncates over-long open_text to the cap and still persists it', async () => {
    const openText = 'a'.repeat(MAX_OPEN_TEXT + 100);

    const res = await POST(surveyRequest({ token: TOKEN, reason: BUILTIN_REASON, open_text: openText }));

    // The customer is not punished for verbosity: still a normal 303, not a 400.
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://app.churnlens.com/survey/thanks');

    const stored = updateParams()[P_OPEN_TEXT] as string;
    expect(stored).toHaveLength(MAX_OPEN_TEXT);
    expect(stored).toBe(openText.slice(0, MAX_OPEN_TEXT));
  });

  it('truncates over-long comeback_text to the cap and still persists it', async () => {
    const comebackText = 'b'.repeat(MAX_COMEBACK_TEXT + 1);

    const res = await POST(
      surveyRequest({ token: TOKEN, reason: BUILTIN_REASON, comeback_text: comebackText }),
    );

    expect(res.status).toBe(303);
    const stored = updateParams()[P_COMEBACK_TEXT] as string;
    expect(stored).toHaveLength(MAX_COMEBACK_TEXT);
    expect(stored).toBe(comebackText.slice(0, MAX_COMEBACK_TEXT));
  });

  it('caps the two free-text fields independently', async () => {
    const openText = 'a'.repeat(MAX_OPEN_TEXT + 500);
    const comebackText = 'b'.repeat(10);

    await POST(
      surveyRequest({
        token: TOKEN,
        reason: BUILTIN_REASON,
        open_text: openText,
        comeback_text: comebackText,
      }),
    );

    const params = updateParams();
    expect(params[P_OPEN_TEXT]).toHaveLength(MAX_OPEN_TEXT);
    expect(params[P_COMEBACK_TEXT]).toBe(comebackText);
  });

  it('stores text at exactly the cap unchanged', async () => {
    const openText = 'a'.repeat(MAX_OPEN_TEXT);
    const comebackText = 'b'.repeat(MAX_COMEBACK_TEXT);

    await POST(
      surveyRequest({
        token: TOKEN,
        reason: BUILTIN_REASON,
        open_text: openText,
        comeback_text: comebackText,
      }),
    );

    const params = updateParams();
    expect(params[P_OPEN_TEXT]).toBe(openText);
    expect(params[P_COMEBACK_TEXT]).toBe(comebackText);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stores under-cap text verbatim', async () => {
    await POST(
      surveyRequest({
        token: TOKEN,
        reason: BUILTIN_REASON,
        open_text: 'The price went up and I could not justify it.',
        comeback_text: 'Lower tier under $10.',
      }),
    );

    const params = updateParams();
    expect(params[P_OPEN_TEXT]).toBe('The price went up and I could not justify it.');
    expect(params[P_COMEBACK_TEXT]).toBe('Lower tier under $10.');
  });

  it('stores null for free-text fields the form did not submit', async () => {
    await POST(surveyRequest({ token: TOKEN, reason: BUILTIN_REASON }));

    const params = updateParams();
    expect(params[P_OPEN_TEXT]).toBeNull();
    expect(params[P_COMEBACK_TEXT]).toBeNull();
  });

  it('never stores a lone surrogate when the cut lands mid-emoji', async () => {
    // '🙂' is a surrogate pair, so a 1999-char prefix plus one emoji puts the
    // cut exactly between its two halves. Postgres rejects a lone surrogate.
    const openText = 'a'.repeat(MAX_OPEN_TEXT - 1) + '🙂'.repeat(10);

    await POST(surveyRequest({ token: TOKEN, reason: BUILTIN_REASON, open_text: openText }));

    const stored = updateParams()[P_OPEN_TEXT] as string;
    expect(stored).toHaveLength(MAX_OPEN_TEXT - 1);
    expect(stored).toBe('a'.repeat(MAX_OPEN_TEXT - 1));
    expect(stored).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

// ─── reason allow-list ───────────────────────────────────────────────────────

describe('POST /api/survey — reason validation', () => {
  it.each(BUILTIN_CANCELLATION_REASONS)('accepts the built-in reason %s', async (reason) => {
    const res = await POST(surveyRequest({ token: TOKEN, reason }));

    expect(res.status).toBe(303);
    expect(updateParams()[P_REASON]).toBe(reason);
  });

  it("accepts one of the org's own custom reasons", async () => {
    loadSurveyConfigMock.mockResolvedValue(config({ customReasons: [CUSTOM_REASON] }));

    const res = await POST(surveyRequest({ token: TOKEN, reason: CUSTOM_REASON }));

    expect(res.status).toBe(303);
    expect(updateParams()[P_REASON]).toBe(CUSTOM_REASON);
    expect(loadSurveyConfigMock).toHaveBeenCalledWith(ORG_ID);
  });

  it('stores an off-set reason rather than discarding the response', async () => {
    loadSurveyConfigMock.mockResolvedValue(config({ customReasons: ['Our own reason'] }));

    const res = await POST(surveyRequest({ token: TOKEN, reason: 'Some other org custom reason' }));

    // The reason set is per-org and editable, so a submission can legitimately
    // arrive carrying a reason the founder deleted after the page rendered.
    // Rejecting would throw away a churned customer's one-shot answer to catch
    // a case we cannot distinguish from tampering anyway.
    expect(res.status).toBe(303);
    expect(updateParams()[P_REASON]).toBe('Some other org custom reason');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/off-set reason/i));
  });

  it.each([
    ['an arbitrary injected string', '<script>alert(1)</script>'],
    ['a built-in with a trailing space', `${BUILTIN_REASON} `],
    ['a built-in in the wrong case', BUILTIN_REASON.toLowerCase()],
    ['an empty-ish whitespace value', '   '],
  ])('stores %s and flags it, without losing the free text', async (_label, reason) => {
    const res = await POST(
      surveyRequest({ token: TOKEN, reason, open_text: 'a'.repeat(MAX_OPEN_TEXT + 50) }),
    );

    expect(res.status).toBe(303);
    expect(updateParams()[P_REASON]).toBe(reason);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/off-set reason/i));
  });

  it('caps an over-long reason at MAX_REASON', async () => {
    const res = await POST(
      surveyRequest({ token: TOKEN, reason: 'x'.repeat(MAX_REASON + 200) }),
    );

    // The cap, not the allow-list, is what bounds this column: it is a grouping
    // key on the dashboard and an input to a paid OpenAI call.
    expect(res.status).toBe(303);
    expect(updateParams()[P_REASON]).toHaveLength(MAX_REASON);
  });

  it('still stores the response when the org config cannot be loaded', async () => {
    loadSurveyConfigMock.mockRejectedValue(new Error('db down'));

    const res = await POST(surveyRequest({ token: TOKEN, reason: BUILTIN_REASON }));

    // The config read only decides whether to flag the reason, so a transient
    // failure must not cost us the submission.
    expect(res.status).toBe(303);
    expect(updateParams()[P_REASON]).toBe(BUILTIN_REASON);
  });
});

// ─── ordering and short-circuits ─────────────────────────────────────────────

describe('POST /api/survey — token handling still precedes reason validation', () => {
  it('returns 400 for a missing token without loading the org config', async () => {
    const res = await POST(surveyRequest({ reason: BUILTIN_REASON }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing required fields' });
    expect(loadSurveyConfigMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing reason before the allow-list check', async () => {
    const res = await POST(surveyRequest({ token: TOKEN }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing required fields' });
    expect(loadSurveyConfigMock).not.toHaveBeenCalled();
  });

  it('returns 400 "Invalid token" for a bad signature even when the reason is valid', async () => {
    verifySurveyTokenMock.mockReturnValue(null);

    const res = await POST(surveyRequest({ token: TOKEN, reason: BUILTIN_REASON }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid token' });
    expect(loadSurveyConfigMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('returns 410 for an expired token before validating the reason', async () => {
    verifySurveyTokenMock.mockReturnValue(tokenPayload({ exp: Date.now() - 1 }));

    const res = await POST(surveyRequest({ token: TOKEN, reason: 'anything at all' }));

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'Survey link expired' });
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/survey — preview tokens', () => {
  it('short-circuits a valid preview submission without writing', async () => {
    verifySurveyTokenMock.mockReturnValue(tokenPayload({ kind: 'preview' }));

    const res = await POST(
      surveyRequest({
        token: TOKEN,
        reason: BUILTIN_REASON,
        open_text: 'a'.repeat(MAX_OPEN_TEXT + 10),
      }),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://app.churnlens.com/survey/thanks');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('flags an off-set reason on a preview without ever writing', async () => {
    verifySurveyTokenMock.mockReturnValue(tokenPayload({ kind: 'preview' }));

    const res = await POST(surveyRequest({ token: TOKEN, reason: 'not a real reason' }));

    // A preview runs the same reason handling a real submission does, so the
    // form is provably previewed as-shipped — but still writes nothing.
    expect(res.status).toBe(303);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/off-set reason/i));
    expect(executeMock).not.toHaveBeenCalled();
  });
});

// ─── persistence outcomes ────────────────────────────────────────────────────

describe('POST /api/survey — write outcomes', () => {
  it('returns 404 when the row is missing or already submitted', async () => {
    executeMock.mockResolvedValue(0);

    const res = await POST(surveyRequest({ token: TOKEN, reason: BUILTIN_REASON }));

    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/already submitted/i);
  });

  it('returns 500 without leaking the DB error when the write fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    executeMock.mockRejectedValue(new Error('connection reset'));

    const res = await POST(surveyRequest({ token: TOKEN, reason: BUILTIN_REASON }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to save response' });
    errorSpy.mockRestore();
  });

  it('scopes the UPDATE to the token and the org from the payload', async () => {
    await POST(surveyRequest({ token: TOKEN, reason: BUILTIN_REASON }));

    const [sql, params] = executeMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE survey_responses/);
    expect(params[4]).toBe(TOKEN);
    expect(params[5]).toBe(ORG_ID);
  });
});
