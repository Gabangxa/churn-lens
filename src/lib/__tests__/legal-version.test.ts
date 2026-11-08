import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { LEGAL, SUB_PROCESSORS, DPA_SUB_PROCESSORS } from '../legal';
import { LEGAL_DOCS_VERSION, LEGAL_DOCS_SHA256 } from '../legal-version';

/**
 * What a founder's acceptance is recorded against. The version string is the
 * only link between an acceptance row and the wording it covered, so the two
 * ways that link silently breaks are pinned here: the documents changing under
 * an unchanged version, and an acceptance of the DRAFT documents reading as an
 * acceptance of the finished ones.
 */

const REPO_ROOT = resolve(__dirname, '../../..');

// Everything the /legal/terms, /legal/dpa and /legal/privacy pages render
// from: the values legal.ts feeds them, and the source of the pages and their
// shared chrome. Source text, not rendered HTML, so this needs no React and
// errs towards flagging a change (a className edit) over missing one.
const LEGAL_PAGE_SOURCES = [
  'src/app/legal/terms/page.tsx',
  'src/app/legal/dpa/page.tsx',
  'src/app/legal/privacy/page.tsx',
  'src/components/LegalPage.tsx',
];

function legalDocsSha256(): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ LEGAL, SUB_PROCESSORS, DPA_SUB_PROCESSORS }));
  for (const path of LEGAL_PAGE_SOURCES) {
    // CRLF normalised: a Windows checkout must not read as a wording change.
    const source = readFileSync(resolve(REPO_ROOT, path), 'utf8').replace(/\r\n/g, '\n');
    hash.update(`\n--- ${path}\n${source}`);
  }
  return hash.digest('hex');
}

describe('LEGAL_DOCS_VERSION', () => {
  it('is bumped whenever the legal documents change', () => {
    const actual = legalDocsSha256();
    expect(
      actual,
      `The legal documents changed but LEGAL_DOCS_VERSION (${LEGAL_DOCS_VERSION}) did not. ` +
        'Every recorded acceptance of that version would now read as acceptance of the new text. ' +
        'In src/lib/legal-version.ts: bump LEGAL_DOCS_VERSION (every org is asked to accept again), ' +
        `then set LEGAL_DOCS_SHA256 to '${actual}'. ` +
        'Update the hash alone only if no reader could see the change (formatting, styling).',
    ).toBe(LEGAL_DOCS_SHA256);
  });
});

describe('currentLegalDocsVersion', () => {
  afterEach(() => {
    vi.doUnmock('../legal');
    vi.resetModules();
  });

  // Loaded fresh against a legal.ts that is, or is not, still a draft.
  async function versionWhenPlaceholdersUnfilled(unfilled: boolean): Promise<string> {
    vi.resetModules();
    vi.doMock('../legal', () => ({ hasUnfilledPlaceholders: () => unfilled }));
    const { currentLegalDocsVersion } = await import('../legal-version');
    return currentLegalDocsVersion();
  }

  it('labels the version a draft while legal.ts still has placeholders', async () => {
    // Those pages say "Draft — do not rely on it". An acceptance of them must
    // stay distinguishable from an acceptance of the finished contract.
    expect(await versionWhenPlaceholdersUnfilled(true)).toBe(`${LEGAL_DOCS_VERSION}-draft`);
  });

  it('drops the label once legal.ts is filled, so filling it alone re-asks everyone', async () => {
    expect(await versionWhenPlaceholdersUnfilled(false)).toBe(LEGAL_DOCS_VERSION);
  });
});
