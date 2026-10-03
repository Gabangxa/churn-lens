import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { withErrorReporting } from '@/lib/with-error-reporting';

/**
 * Every App Router route export goes through withErrorReporting
 * (src/lib/with-error-reporting.ts). Next 14 logs a throw that escapes an
 * unwrapped handler and answers 500, but reports nothing, so one forgotten
 * wrapper is a route whose failures nobody hears about.
 *
 * Every route handler file under src/app is checked, not only src/app/api: a
 * route can live anywhere in the app tree (an OG image, a feed), and Next
 * serves route.ts, route.tsx, route.js and route.jsx alike (its default
 * pageExtensions, which next.config.js does not change).
 *
 * Checked on what each route module actually exports, not on its source
 * text: withErrorReporting tags the handler it returns, so `export const GET:
 * T = h`, `export { h as POST }`, `export let PUT = h` and an alias of a
 * wrapped export are all judged by the value Next would call. A new route
 * file fails here until it is wrapped.
 *
 * Importing a route has no side effects worth mocking: the database pool,
 * Stripe, Polar and Resend clients are all created on first use, because
 * `next build` imports every route module the same way.
 */
const APP_DIR = join(__dirname, '..', '..');
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx)$/;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const WRAPPED_TAG = Symbol.for('churnlens.withErrorReporting');

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFiles(path);
    return ROUTE_FILE.test(entry.name) ? [path] : [];
  });
}

function isWrapped(value: unknown): boolean {
  return typeof value === 'function' && (value as unknown as Record<symbol, unknown>)[WRAPPED_TAG] === true;
}

/** What is wrong with one route module's exports; empty when every handler is wrapped. */
function unwrappedExports(routeModule: Record<string, unknown>): string[] {
  return Object.entries(routeModule)
    .filter(([name, value]) => METHODS.includes(name) && !isWrapped(value))
    .map(([name]) => `${name} is not a withErrorReporting(...) handler`);
}

describe('App Router route exports', () => {
  const files = routeFiles(APP_DIR);

  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('scans the whole app directory, not only api/', () => {
    // Pinned because narrowing the root back to src/app/api would still pass
    // every other test here while letting a route elsewhere ship unwrapped.
    expect(APP_DIR).toBe(resolve(process.cwd(), 'src/app'));
  });

  it('wraps every exported handler in withErrorReporting', async () => {
    const problems: string[] = [];
    let handlers = 0;
    for (const file of files) {
      const routeModule = (await import(file)) as Record<string, unknown>;
      handlers += Object.keys(routeModule).filter((name) => METHODS.includes(name)).length;
      problems.push(...unwrappedExports(routeModule).map((problem) => `${relative(APP_DIR, file)}: ${problem}`));
    }

    expect(problems).toEqual([]);
    // Every route file exports at least one handler, so a broken import
    // (say, a module namespace that came back empty) cannot pass as clean.
    expect(handlers).toBeGreaterThanOrEqual(files.length);
  }, 60_000);

  it('finds a route anywhere under the app directory, in every extension Next accepts', () => {
    // A route outside api/ (an OG image, a feed) or written as .tsx/.js/.jsx
    // is still a route Next serves, so it must not slip past the check above.
    const root = mkdtempSync(join(tmpdir(), 'routes-wrapped-'));
    try {
      const expected = ['api/a/route.ts', '(marketing)/og/route.tsx', 'feed.xml/route.js', 'b/route.jsx'];
      const ignored = ['api/a/__tests__/route.ts', 'page.tsx', 'b/route.test.ts', 'b/route.d.ts', 'b/route.mjs'];
      for (const file of [...expected, ...ignored]) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), '');
      }

      expect(routeFiles(root).map((file) => relative(root, file)).sort()).toEqual([...expected].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tags the handler withErrorReporting returns, without making the tag enumerable', () => {
    const handler = withErrorReporting('test.route', async () => new Response(null));

    expect(isWrapped(handler)).toBe(true);
    expect(Object.getOwnPropertySymbols(handler)).toContain(WRAPPED_TAG);
    expect(Object.keys(handler)).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(handler, WRAPPED_TAG)?.enumerable).toBe(false);
  });

  it('would catch an unwrapped handler however it is exported, so the check above can fail', () => {
    const wrapped = withErrorReporting('test.route', async () => new Response(null));
    const bare = async () => new Response(null);

    expect(
      unwrappedExports({ GET: bare, POST: wrapped, PUT: bare, HEAD: wrapped, dynamic: 'force-dynamic' }),
    ).toEqual(['GET is not a withErrorReporting(...) handler', 'PUT is not a withErrorReporting(...) handler']);
    // A handler wrapped by anything else is still unwrapped.
    expect(unwrappedExports({ POST: (req: Request) => wrapped(req) })).toHaveLength(1);
  });
});
