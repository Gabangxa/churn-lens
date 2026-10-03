import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every App Router route export goes through withErrorReporting
 * (src/lib/with-error-reporting.ts). Next 14 logs a throw that escapes an
 * unwrapped handler and answers 500, but reports nothing, so one forgotten
 * wrapper is a route whose failures nobody hears about. A guard over the
 * source, like a lint rule: a new route.ts fails here until it is wrapped.
 */
const API_DIR = join(__dirname, '..');
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFiles(path);
    return entry.name === 'route.ts' ? [path] : [];
  });
}

/** What is wrong with one route file's exports; empty when every one is wrapped. */
function unwrappedExports(source: string): string[] {
  const problems: string[] = [];
  const methods = METHODS.join('|');
  // Array.from: tsconfig has no target, so tsc's ES5 default cannot iterate a matchAll.
  const bareFunctions = Array.from(
    source.matchAll(new RegExp(`export\\s+(?:async\\s+)?function\\s+(${methods})\\b`, 'g')),
  );
  for (const match of bareFunctions) {
    problems.push(`${match[1]} is exported as a bare function`);
  }
  const constExports = Array.from(
    source.matchAll(new RegExp(`export\\s+const\\s+(${methods})\\s*=\\s*([^;]+);`, 'g')),
  );
  const wrapped = new Set(
    constExports.filter(([, , value]) => value.trim().startsWith('withErrorReporting(')).map(([, method]) => method),
  );
  for (const [, method, value] of constExports) {
    const alias = value.trim();
    // `export const GET = POST;` reuses a wrapped handler.
    if (!alias.startsWith('withErrorReporting(') && !wrapped.has(alias)) {
      problems.push(`${method} = ${alias} is not withErrorReporting(...) or an alias of a wrapped export`);
    }
  }
  return problems;
}

describe('API route exports', () => {
  const files = routeFiles(API_DIR);

  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('wraps every exported handler in withErrorReporting', () => {
    const problems = files.flatMap((file) =>
      unwrappedExports(readFileSync(file, 'utf8')).map((problem) => `${relative(API_DIR, file)}: ${problem}`),
    );
    expect(problems).toEqual([]);
  });

  it('would catch a bare export, so the check above can fail', () => {
    expect(unwrappedExports('export async function POST(req: Request) {}')).toHaveLength(1);
    expect(unwrappedExports('export const GET = handler;')).toHaveLength(1);
    expect(
      unwrappedExports("export const POST = withErrorReporting('x', run);\nexport const GET = POST;"),
    ).toEqual([]);
  });
});
