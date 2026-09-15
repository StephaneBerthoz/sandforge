/**
 * Gate: `sync-readme-badges.mjs` keeps SECURITY.md's supported-versions table
 * on the release in package.json.
 *
 * The script resolves the repository from its own location, so each case runs
 * a copy of it inside a throwaway tree holding only the files it reads. The
 * READMEs there carry no badge block, which the script leaves alone, so the
 * outcome depends on SECURITY.md alone.
 *
 * Run: node --test scripts/sync-readme-badges.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'sync-readme-badges.mjs');

function securityPage(supported, unsupported) {
  return [
    '# Security Policy',
    '',
    '## Supported versions',
    '',
    '| Version | Supported |',
    '| ------- | --------- |',
    `| ${supported.padEnd(7)} | Yes       |`,
    `| ${unsupported.padEnd(7)} | No        |`,
    '',
    '## Reporting a vulnerability',
    '',
  ].join('\n');
}

function withRepo(version, security, run) {
  const root = mkdtempSync(join(tmpdir(), 'sync-badges-'));
  try {
    const write = (relative, content) => {
      mkdirSync(dirname(join(root, relative)), { recursive: true });
      writeFileSync(join(root, relative), content);
    };
    mkdirSync(join(root, 'scripts'));
    copyFileSync(SCRIPT, join(root, 'scripts', 'sync-readme-badges.mjs'));
    write('package.json', JSON.stringify({ version }));
    write('README.md', '# Readme\n');
    write('packages/extension/README.md', '# Readme\n');
    write('packages/webview/src/i18n/locales/en.json', '{}');
    if (security !== undefined) write('SECURITY.md', security);

    const sync = (...args) =>
      spawnSync(process.execPath, [join(root, 'scripts', 'sync-readme-badges.mjs'), ...args], {
        encoding: 'utf8',
      });
    run({ sync, security: () => readFileSync(join(root, 'SECURITY.md'), 'utf8') });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('--check fails when SECURITY.md supports an older minor than package.json', () => {
  withRepo('1.22.0', securityPage('1.21.x', '< 1.21'), ({ sync }) => {
    const result = sync('--check');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /SECURITY\.md: STALE/);
  });
});

test('--check passes when SECURITY.md supports the minor of package.json', () => {
  withRepo('1.22.3', securityPage('1.22.x', '< 1.22'), ({ sync }) => {
    const result = sync('--check');

    assert.equal(result.status, 0, result.stderr);
  });
});

test('--check fails when the supported-versions table is missing', () => {
  withRepo('1.22.0', '# Security Policy\n\nNo table here.\n', ({ sync }) => {
    const result = sync('--check');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /SECURITY\.md: STALE — supported-versions table not found/);
  });
});

test('a sync rewrites the table to the current minor and leaves the rest of the page', () => {
  // A minor wider than the header, so the rewrite has to widen the column the
  // way Prettier would.
  withRepo('10.100.0', securityPage('1.21.x', '< 1.21'), ({ sync, security }) => {
    assert.equal(sync().status, 0);

    assert.equal(
      security(),
      [
        '# Security Policy',
        '',
        '## Supported versions',
        '',
        '| Version  | Supported |',
        '| -------- | --------- |',
        '| 10.100.x | Yes       |',
        '| < 10.100 | No        |',
        '',
        '## Reporting a vulnerability',
        '',
      ].join('\n'),
    );
    assert.equal(sync('--check').status, 0);
  });
});
