import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { withErrorReporting } from '@/lib/with-error-reporting';

/**
 * Every App Router route export goes through withErrorReporting
 * (src/lib/with-error-reporting.ts). Next 14 logs a throw that escapes an
 * unwrapped handler and answers 500, but reports nothing, so one forgotten
 * wrapper is a route whose failures nobody hears about.
 *
 * Checked on what each route module actually exports, not on its source
 * text: withErrorReporting tags the handler it returns, so `export const GET:
 * T = h`, `export { h as POST }`, `export let PUT = h` and an alias of a
 * wrapped export are all judged by the value Next would call. A new
 * route.ts fails here until it is wrapped.
 *
 * Importing a route has no side effects worth mocking: the database pool,
 * Stripe, Polar and Resend clients are all created on first use, because
 * `next build` imports every route module the same way.
 */
const API_DIR = join(__dirname, '..');
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const WRAPPED_TAG = Symbol.for('churnlens.withErrorReporting');

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFiles(path);
    return entry.name === 'route.ts' ? [path] : [];
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

describe('API route exports', () => {
  const files = routeFiles(API_DIR);

  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('wraps every exported handler in withErrorReporting', async () => {
    const problems: string[] = [];
    let handlers = 0;
    for (const file of files) {
      const routeModule = (await import(file)) as Record<string, unknown>;
      handlers += Object.keys(routeModule).filter((name) => METHODS.includes(name)).length;
      problems.push(...unwrappedExports(routeModule).map((problem) => `${relative(API_DIR, file)}: ${problem}`));
    }

    expect(problems).toEqual([]);
    // Every route file exports at least one handler, so a broken import
    // (say, a module namespace that came back empty) cannot pass as clean.
    expect(handlers).toBeGreaterThanOrEqual(files.length);
  }, 60_000);

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
