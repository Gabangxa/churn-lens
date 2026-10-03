import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { notFound, redirect } from 'next/navigation';
import { DynamicServerError } from 'next/dist/client/components/hooks-server-context';

/**
 * withErrorReporting is driven the way Next drives a route export: called with
 * the request and the `{ params }` context, its Response read back. What it
 * reported is read from the real report-error module (ALERT_EMAIL is pinned
 * empty for every suite, so nothing is emailed). Postgres's own errors are
 * classified against a real engine in with-error-reporting.db.test.ts.
 */

import { withErrorReporting } from '../with-error-reporting';
import { getErrorReportSnapshot, resetErrorReports } from '../report-error';

const URL_ = 'https://app.churnlens.test/api/things/abc';

function post() {
  return new NextRequest(URL_, { method: 'POST' });
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetErrorReports();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  resetErrorReports();
  vi.restoreAllMocks();
});

describe('withErrorReporting — a handler that answers', () => {
  it('hands the request and route context through and returns its response untouched', async () => {
    const seen: unknown[] = [];
    const route = withErrorReporting(
      'test.route',
      async (req: NextRequest, ctx: { params: { orgId: string } }) => {
        seen.push(req.method, ctx.params.orgId);
        return NextResponse.json({ ok: true }, { status: 202, headers: { 'x-kept': '1' } });
      },
    );

    const res = await route(post(), { params: { orgId: 'org_1' } });

    expect(seen).toEqual(['POST', 'org_1']);
    expect(res.status).toBe(202);
    expect(res.headers.get('x-kept')).toBe('1');
    expect(await res.json()).toEqual({ ok: true });
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });

  it('leaves an error response the handler built itself alone, so nothing is reported twice', async () => {
    // The handler's own catch already reported and chose the answer.
    const route = withErrorReporting('test.route', async () =>
      NextResponse.json({ error: 'Failed to save' }, { status: 500 }),
    );

    const res = await route(post());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to save' });
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });
});

describe('withErrorReporting — a handler that throws', () => {
  it('answers 500 with a generic body and reports the error with the method and route params', async () => {
    const route = withErrorReporting(
      'webhook.stripe',
      async (_req: NextRequest, _ctx: { params: { orgId: string } }): Promise<NextResponse> => {
        throw new Error('decrypt failed: unsupported state or unable to authenticate data');
      },
    );

    const res = await route(post(), { params: { orgId: 'org_1' } });

    expect(res.status).toBe(500);
    // Nothing about the failure leaks to the caller; Stripe and Polar still retry a 5xx.
    expect(await res.json()).toEqual({ error: 'Internal error' });
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({
        context: 'webhook.stripe',
        message: 'decrypt failed: unsupported state or unable to authenticate data',
        meta: { step: 'unhandled', method: 'POST', orgId: 'org_1' },
      }),
    ]);
  });

  it('reports a handler with no route context too, and a thrown non-Error', async () => {
    const route = withErrorReporting('settings.status', async (): Promise<Response> => {
      throw 'a bare string';
    });

    const res = await route(new NextRequest(URL_));

    expect(res.status).toBe(500);
    expect(getErrorReportSnapshot().recent).toEqual([
      expect.objectContaining({ context: 'settings.status', message: 'a bare string', meta: { step: 'unhandled', method: 'GET' } }),
    ]);
  });

  it('joins a catch-all param and redacts an email-shaped one, since params are request input', async () => {
    const route = withErrorReporting(
      'test.route',
      async (_req: NextRequest, _ctx: { params: { slug: string[]; who: string } }): Promise<Response> => {
        throw new Error('boom');
      },
    );

    await route(post(), { params: { slug: ['a', 'b'], who: 'jane@customer.example' } });

    expect(getErrorReportSnapshot().recent[0].meta).toEqual({
      step: 'unhandled',
      method: 'POST',
      slug: 'a/b',
      who: '[redacted email]',
    });
    expect(errorSpy.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain('jane');
  });
});

describe("withErrorReporting — Next's own control flow", () => {
  // Next throws these on purpose and catches them itself: redirect() and
  // notFound() become responses, and DynamicServerError is how a GET handler
  // that reads cookies or headers tells `next build` it cannot be prerendered.
  // Swallowed and reported, every build logged (and could email) one bogus
  // error per such route.
  it.each([
    ['redirect()', () => redirect('/login')],
    ['notFound()', () => notFound()],
    ['DynamicServerError', () => {
      throw new DynamicServerError('Route /api/settings/status used `request.cookies`');
    }],
  ])('rethrows %s untouched and reports nothing', async (_label, control) => {
    let thrown: unknown;
    const route = withErrorReporting('test.route', async (): Promise<Response> => {
      try {
        control();
      } catch (err) {
        thrown = err;
        throw err;
      }
      return NextResponse.json({ unreachable: true });
    });

    await expect(route(post())).rejects.toBe(thrown);
    expect(thrown).toBeDefined();
    expect(getErrorReportSnapshot().totalReported).toBe(0);
  });
});
