import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Documentation gate for what a reader needs before a command works.
 *
 * The command-line scripts are not an installed binary: they run with tsx from
 * a checkout whose shared package has been built. The guides used to present
 * them as a headless CLI, called them with `pnpm tsx` and no setup, and sent
 * readers who hit DUPLICATE_VALUE to a wizard upsert toggle that does not
 * exist. The cleanup recipe also called its sweep "what you cloned today"
 * while it matches every record the user created in the window. Each of those
 * read fine and failed on the first paste.
 *
 * Run from the repo root: npx vitest run docs/setup-prerequisites.test.ts
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const read = (relativePath: string): string =>
  readFileSync(resolve(REPO_ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');

const QUICKSTART = read('docs/forge-quickstart.md');
const GETTING_STARTED = read('docs/getting-started.md');

/** Each `sandforge-cleanup.ts` call in the guide, with its continued lines. */
const cleanupCalls = (source: string): string[] =>
  [...source.matchAll(/sandforge-cleanup\.ts(?:[^\n]*\\\n)*[^\n]*/g)].map(([call]) => call);

describe('docs/forge-quickstart.md', () => {
  it('lists the checkout steps the command-line scripts need', () => {
    expect(QUICKSTART).toContain('pnpm install');
    expect(QUICKSTART).toContain('pnpm build:shared');
    expect(QUICKSTART).toContain('pnpm exec tsx');
    expect(QUICKSTART).not.toMatch(/pnpm tsx /);
  });

  it('sends DUPLICATE_VALUE to the upsert flag, not to a wizard toggle', () => {
    const row = QUICKSTART.split('\n').find((line) => line.startsWith('| `DUPLICATE_VALUE`'));

    expect(row).toBeDefined();
    expect(row).toContain('--upsert');
    expect(QUICKSTART).not.toMatch(/Enable upsert mode/i);
  });

  it('describes the cleanup by what it matches and narrows the real delete', () => {
    expect(QUICKSTART).not.toMatch(/delete what you cloned/i);
    expect(QUICKSTART).toMatch(/every record[^\n]*created/);

    const calls = cleanupCalls(QUICKSTART);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toMatch(/\s--dry-run\b/);
    for (const call of calls.filter((c) => !/\s--dry-run\b/.test(c))) {
      expect(call).toMatch(/\s--objects\s/);
    }
  });
});

describe('docs/getting-started.md', () => {
  it('does not present the scripts as an installed headless CLI', () => {
    expect(GETTING_STARTED).not.toMatch(/headless CLI/);
    expect(GETTING_STARTED).toContain('pnpm exec tsx');
    expect(GETTING_STARTED).toContain('pnpm build:shared');
  });

  it('names SFDX Import as the way to add an org on another Salesforce cloud', () => {
    // OAuth Web and Username/Password refuse any host outside the Salesforce
    // login hosts, so an org on another cloud has exactly one way in.
    const section = GETTING_STARTED.split('## Connect Your Org')[1]?.split('\n## ')[0] ?? '';
    const paragraph = section.split('\n\n').find((p) => /another Salesforce cloud/.test(p));

    expect(paragraph).toBeDefined();
    expect(paragraph).toContain('sf org login web --instance-url');
    expect(paragraph).toContain('SFDX Import');
    for (const host of [
      'login.salesforce.com',
      'test.salesforce.com',
      'force.com',
      'cloudforce.com',
    ]) {
      expect(section).toContain(host);
    }
    expect(section).toMatch(/My Domain/);
  });
});

describe('CONTRIBUTING.md', () => {
  it('cites no pnpm release other than the packageManager pin', () => {
    // A copied patch number goes stale on the next bump while the sentence
    // around it still says the version is pinned in package.json.
    const pin = (JSON.parse(read('package.json')) as { packageManager: string }).packageManager;
    const cited = [...read('CONTRIBUTING.md').matchAll(/pnpm@\d+\.\d+\.\d+/g)].map(([v]) => v);

    expect(cited.filter((version) => !pin.startsWith(version))).toEqual([]);
  });
});
