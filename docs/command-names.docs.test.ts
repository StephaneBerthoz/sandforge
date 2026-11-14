import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TOOLS } from '../packages/extension/cli/sandforge.js';

/**
 * Documentation gate for the name a page gives a command line.
 *
 * The pages said `sandforge-env plan …`, `sandforge-checkpoint rewind …`,
 * `sandforge-clone --remove …`: names that exist only on the PATH of a global
 * install of the `sandforge` npm package. Copied as `npx sandforge-checkpoint
 * …`, such a line asks the registry for a package of that name, which anybody
 * can publish. A page names the command as the package does, `sandforge
 * checkpoint`, and a line to run says it the way it runs: `npx sandforge
 * checkpoint …`, or the script's own file under tsx from a checkout. The
 * hyphenated name stays where `cli/invocation.test.ts` lets it stand in the
 * scripts' own strings: a file, an identifier quoted as a value, and the start
 * of an id or of a folder's name.
 *
 * Run from the repo root: npx vitest run docs/command-names.docs.test.ts
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A script's hyphenated name, `sandforge-checkpoint`, wherever a page holds it. */
const HYPHENATED = new RegExp(`sandforge-(?:${Object.keys(TOOLS).join('|')})(?![a-z])`, 'g');

/** Every Markdown page under `dir`, as a path from the repository's root. */
function pagesUnder(dir: string): string[] {
  return readdirSync(resolve(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pagesUnder(path);
    return entry.name.endsWith('.md') ? [path] : [];
  });
}

/**
 * What a reader is shown a command line in: the guides, the two READMEs and
 * the package's, the hovers of the schema the editor checks a `sandforge.yaml`
 * with, the CI guide and the pipelines it hands out, whose step names a job's
 * log shows.
 */
const PAGES = [
  ...pagesUnder('docs'),
  'README.md',
  'packages/extension/README.md',
  'packages/cli/README.md',
  'packages/extension/resources/schemas/sandforge.schema.json',
  ...readdirSync(resolve(REPO_ROOT, 'ci-examples'))
    .filter((file) => !/\.test\.ts$/.test(file))
    .map((file) => `ci-examples/${file}`),
];

/**
 * Why the hyphenated name may stand where it does, or nothing when a reader
 * would read it as a command to type: the whitelist of `cli/invocation.test.ts`,
 * read on a page's text rather than on a string of the source. A file is named
 * by its file; an identifier — a run summary's `tool`, a state's `script` — is
 * the name alone between quotes; the start of an id or of a folder's name — a
 * cache key, a run id — is the name and the dash the rest of it follows.
 */
function allowedBecause(text: string, at: number, name: string): string | undefined {
  const after = text.slice(at + name.length);
  if (/^\.(?:ts|js|mjs)\b/.test(after)) return 'a file';
  const quote = text.charAt(at - 1);
  if ((quote === '"' || quote === "'") && after.startsWith(quote)) return 'an identifier';
  if (/^-[\w$<{]/.test(after) || /^-(?:$|[\s'"`])/.test(after)) {
    return "the start of an id or a folder's name";
  }
  return undefined;
}

/** Each place a text holds a script's hyphenated name a reader would type. */
function bareNames(path: string, text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(HYPHENATED)) {
    if (allowedBecause(text, match.index, match[0]) !== undefined) continue;
    const line = text.slice(0, match.index).split('\n').length;
    const around = text.slice(Math.max(0, match.index - 30), match.index + 40);
    found.push(`${path}:${line}: …${around.replace(/\n/g, ' ')}…`);
  }
  return found;
}

describe('the name a page gives a command line', () => {
  it('reads every page a command is shown in', () => {
    // Positive control: the environments guide, the CI guide and the
    // pipelines, the MCP guide, and the module guides beneath docs/.
    for (const page of [
      'docs/environments.md',
      'ci-examples/README.md',
      'ci-examples/github-actions.yml',
      'ci-examples/Jenkinsfile',
      'docs/mcp.md',
      'docs/modules/checkpoint.md',
      'packages/extension/resources/schemas/sandforge.schema.json',
    ]) {
      expect(PAGES).toContain(page);
    }
  });

  it('never names a script by the name only a global install puts on the PATH', () => {
    const found = PAGES.flatMap((page) =>
      bareNames(page, readFileSync(resolve(REPO_ROOT, page), 'utf8')),
    );
    expect(found).toEqual([]);
  });

  it('finds the name in a sentence, a line to run and a step name, and lets a file and an id be', () => {
    const probe = [
      'rewind with `sandforge-checkpoint rewind --org DEV`.',
      '$ sandforge-env plan --file sandforge.yaml --org pool-1',
      '      - name: Remove what the clone created (sandforge-clone --remove)',
      'run it with `npx sandforge-seed --target DEV`',
      'pnpm exec tsx packages/extension/cli/sandforge-clone.ts --help',
      '`sandforge-cleanup.ts` remains for a run whose summary you did not keep',
      '  key: sandforge-env-${{ vars.SF_ENV_USERNAME }}-${{ github.run_id }}',
      '{ "tool": "sandforge-sync", "status": "success" }',
      'sandforge-backup-<operation id>.json',
      'the `sandforge seed` command, `npx sandforge checkpoint rewind`',
    ].join('\n');
    expect(bareNames('probe', probe).map((line) => line.split(': …')[0])).toEqual([
      'probe:1',
      'probe:2',
      'probe:3',
      'probe:4',
    ]);
  });
});
