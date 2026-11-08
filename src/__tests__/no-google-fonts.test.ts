import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every page — the public exit-survey pages included, which are opened by a
 * founder's churned customers who never agreed to anything with us — used to
 * @import Google Fonts at runtime, so each visitor's browser sent its IP
 * address (plus Referer and User-Agent) to Google, a recipient the privacy
 * policy does not name. Fonts now come from next/font/google, which downloads
 * them at BUILD time and serves them from our own origin (/_next/static/media).
 *
 * This guards the one way that quietly comes back: someone pasting a Google
 * Fonts <link> or @import into a component or stylesheet. It reads files
 * rather than rendering pages because the leak is a literal URL in source;
 * `next build` + a grep of .next/ is the end-to-end check, but that cannot run
 * inside the unit suite.
 */

const SRC_DIR = resolve(__dirname, '..');
const THIS_FILE = fileURLToPath(import.meta.url);
const GOOGLE_FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe('fonts are self-hosted', () => {
  it('nothing under src/ references a Google Fonts host', () => {
    const offenders = filesUnder(SRC_DIR)
      // This file has to name the hosts to look for them.
      .filter((path) => path !== THIS_FILE)
      .flatMap((path) => {
        const content = readFileSync(path, 'utf8');
        return GOOGLE_FONT_HOSTS.filter((host) => content.includes(host)).map(
          (host) => `${relative(SRC_DIR, path)} → ${host}`,
        );
      });

    expect(offenders).toEqual([]);
  });
});
