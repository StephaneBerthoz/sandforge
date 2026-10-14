/**
 * Gate: the Marketplace README and changelog are what
 * `sync-extension-readme.mjs` makes of the root ones.
 *
 * The two READMEs were kept by hand and drifted apart, each holding sentences
 * the other had corrected. The generator makes one of them a derivative; this
 * gate makes sure nobody edits the derivative instead, and that the rewriting
 * the listing depends on — absolute URLs, github-only blocks left out, the
 * listing's own badges — does what it says.
 *
 * Run: node --test scripts/sync-extension-readme.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BLOB_BASE,
  GENERATED_NOTICE,
  MARKETPLACE,
  RAW_BASE,
  TREE_BASE,
  dropGithubOnly,
  expectedFiles,
  marketplaceBadges,
  rewriteRelativeUrls,
} from './sync-extension-readme.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'sync-extension-readme.mjs');
const ROOT = join(dirname(SCRIPT), '..');
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');

/** `docs` and `assets` are directories; anything else is a file. */
const isDirectory = (path) => ['docs', 'assets', 'docs/modules'].includes(path);
const rewrite = (markdown) => rewriteRelativeUrls(markdown, { isDirectory });

// ── link rewriting ─────────────────────────────────────────────────────────

test('a relative image becomes a raw.githubusercontent.com URL', () => {
  assert.equal(
    rewrite('![Forge — the form](assets/screenshots/forge.png)'),
    `![Forge — the form](${RAW_BASE}assets/screenshots/forge.png)`,
  );
});

test('a relative link to a file becomes a blob URL, its anchor kept', () => {
  assert.equal(
    rewrite('[Guide](docs/modules/sync.md) and [the FAQ](docs/faq.md#slow-performance)'),
    `[Guide](${BLOB_BASE}docs/modules/sync.md) and [the FAQ](${BLOB_BASE}docs/faq.md#slow-performance)`,
  );
  assert.equal(rewrite('[MIT](LICENSE)'), `[MIT](${BLOB_BASE}LICENSE)`);
  assert.equal(rewrite('[Changelog](./changelog.md)'), `[Changelog](${BLOB_BASE}changelog.md)`);
});

test('a relative link to a directory becomes a tree URL', () => {
  assert.equal(rewrite('[the guides](docs/modules)'), `[the guides](${TREE_BASE}docs/modules)`);
  assert.equal(rewrite('[the docs](docs/)'), `[the docs](${TREE_BASE}docs)`);
});

test('absolute URLs, anchors and mail links are left alone', () => {
  const untouched = [
    '[Releases](https://github.com/StephaneBerthoz/sandforge/releases)',
    '[below](#first-steps-safely)',
    '[mail](mailto:someone@example.invalid)',
    `[![Version](https://img.shields.io/badge/version-1.0.0-blue)](${MARKETPLACE})`,
  ].join('\n');
  assert.equal(rewrite(untouched), untouched);
});

test('code is not rewritten, fenced or inline', () => {
  const code = [
    '```md',
    '![shot](assets/screenshots/forge.png)',
    '```',
    'Write `[Guide](docs/faq.md)` in a cell.',
  ].join('\n');
  assert.equal(rewrite(code), code);
});

test('HTML image sources and links are rewritten like their markdown forms', () => {
  assert.equal(
    rewrite('<img src="assets/brand/logo.png" alt="x"> <a href="docs/faq.md">FAQ</a>'),
    `<img src="${RAW_BASE}assets/brand/logo.png" alt="x"> <a href="${BLOB_BASE}docs/faq.md">FAQ</a>`,
  );
});

test('a path that leaves the repository is refused, not guessed at', () => {
  assert.throws(() => rewrite('[up](../elsewhere.md)'), /points outside the repository/);
});

// ── github-only blocks and badges ──────────────────────────────────────────

test('a github-only block is dropped with its markers, and the rest kept', () => {
  const source = [
    '# Title',
    '',
    '<!-- github-only:start -->',
    '',
    '## From Source',
    '',
    '<!-- github-only:end -->',
    '',
    '## Installation',
  ].join('\n');
  assert.equal(dropGithubOnly(source), ['# Title', '', '', '## Installation'].join('\n'));
});

test('an unpaired github-only marker is an error', () => {
  assert.throws(() => dropGithubOnly('a\n<!-- github-only:start -->\nb'), /never closed/);
  assert.throws(() => dropGithubOnly('a\n<!-- github-only:end -->\nb'), /end with no start/);
  assert.throws(
    () =>
      dropGithubOnly(
        '<!-- github-only:start -->\n<!-- github-only:start -->\n<!-- github-only:end -->',
      ),
    /opened inside/,
  );
});

test('the listing drops the CI badge and links the version badge to itself', () => {
  const block = [
    '<!-- badges:start -->',
    '',
    '![Version](https://img.shields.io/badge/version-1.2.3-blue)',
    '[![CI](https://github.com/o/r/actions/workflows/ci.yml/badge.svg)](https://github.com/o/r/actions/workflows/ci.yml)',
    '![License](https://img.shields.io/badge/license-MIT-green)',
    '',
    '<!-- badges:end -->',
    '',
    '[![CI](elsewhere)](kept)',
  ].join('\n');
  assert.equal(
    marketplaceBadges(block),
    [
      '<!-- badges:start -->',
      '',
      `[![Version](https://img.shields.io/badge/version-1.2.3-blue)](${MARKETPLACE})`,
      '![License](https://img.shields.io/badge/license-MIT-green)',
      '',
      '<!-- badges:end -->',
      '',
      '[![CI](elsewhere)](kept)',
    ].join('\n'),
  );
});

// ── drift: the committed files are the generator's ─────────────────────────

test('the committed Marketplace README and changelog are what the generator makes of the root ones', async () => {
  const expected = await expectedFiles(ROOT);
  // Positive control: both files are compared, and the README went through
  // the generator rather than being copied.
  assert.deepEqual(Object.keys(expected).sort(), [
    'packages/extension/CHANGELOG.md',
    'packages/extension/README.md',
  ]);
  assert.ok(expected['packages/extension/README.md'].startsWith(GENERATED_NOTICE));
  for (const [file, content] of Object.entries(expected)) {
    assert.ok(
      read(file) === content,
      `${file} differs from what the generator makes of the root file: edit README.md or ` +
        'changelog.md, then run `node scripts/sync-extension-readme.mjs`',
    );
  }
});

test('the Marketplace README carries no relative URL and nothing github-only', () => {
  const listing = read('packages/extension/README.md');
  const relative = [
    ...[...listing.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1]),
    ...[...listing.matchAll(/\b(?:src|srcset|href)="([^"]+)"/g)].map((m) => m[1]),
  ].filter((url) => !/^(?:https:\/\/|mailto:|#)/.test(url));
  assert.deepEqual(relative, [], 'the Marketplace resolves these against packages/extension/');
  assert.doesNotMatch(listing, /github-only/);
  assert.doesNotMatch(listing, /actions\/workflows\/ci\.yml\/badge\.svg/);
  // Positive control: the root README does hold a github-only block and the
  // CI badge, so the two checks above have something to find.
  assert.match(read('README.md'), /<!-- github-only:start -->/);
  assert.match(read('README.md'), /actions\/workflows\/ci\.yml\/badge\.svg/);
});

// ── the command line ───────────────────────────────────────────────────────

/** A throwaway checkout holding the script, the root files and Prettier. */
function withTree(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'sync-extension-readme-'));
  try {
    const write = (relative, content) => {
      mkdirSync(dirname(join(root, relative)), { recursive: true });
      writeFileSync(join(root, relative), content);
    };
    mkdirSync(join(root, 'scripts'));
    copyFileSync(SCRIPT, join(root, 'scripts', 'sync-extension-readme.mjs'));
    copyFileSync(join(ROOT, '.prettierrc'), join(root, '.prettierrc'));
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
    for (const [relative, content] of Object.entries(files)) write(relative, content);
    const sync = (...args) =>
      spawnSync(process.execPath, [join(root, 'scripts', 'sync-extension-readme.mjs'), ...args], {
        encoding: 'utf8',
      });
    run({ sync, read: (relative) => readFileSync(join(root, relative), 'utf8') });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('--check fails on a hand-edited copy, and a sync writes the copies --check accepts', () => {
  withTree(
    {
      'README.md': '# Title\n\nSee [the FAQ](docs/faq.md).\n',
      'changelog.md': '# Changelog\n\n## [1.0.0]\n',
      'docs/faq.md': '# FAQ\n',
      'packages/extension/README.md': '# Title\n\nEdited by hand.\n',
      'packages/extension/CHANGELOG.md': '# Changelog\n',
    },
    ({ sync, read: readTree }) => {
      const stale = sync('--check');
      assert.equal(stale.status, 1);
      assert.match(stale.stderr, /packages\/extension\/README\.md: STALE/);
      assert.match(stale.stderr, /packages\/extension\/CHANGELOG\.md: STALE/);
      assert.equal(readTree('packages/extension/README.md'), '# Title\n\nEdited by hand.\n');

      assert.equal(sync().status, 0);
      assert.equal(
        readTree('packages/extension/README.md'),
        `${GENERATED_NOTICE}\n\n# Title\n\nSee [the FAQ](${BLOB_BASE}docs/faq.md).\n`,
      );
      assert.equal(readTree('packages/extension/CHANGELOG.md'), '# Changelog\n\n## [1.0.0]\n');
      assert.equal(sync('--check').status, 0);
    },
  );
});
