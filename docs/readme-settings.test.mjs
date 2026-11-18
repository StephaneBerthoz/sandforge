/**
 * The Settings table against the settings the extension declares.
 *
 * Since 1.83.0 the table lives in docs/configuration.md alone, and both READMEs
 * link it: one table cannot drift from a second.
 *
 * Both READMEs list `sandforge.*` in a table, and the two drifted apart: the
 * Marketplace one gained `sandforge.orgs.validateOnStartup` and the repository
 * one did not, and neither picked up the three `sandforge.grappe.*` keys added
 * with the module. A reader who opens the Settings editor after reading either
 * page meets rows nothing told them about, and a setting listed but removed
 * would be worse — so the check is an equality, not a subset, in both
 * directions and in both files.
 *
 * The default column is checked too: a documented default that is not the
 * manifest's is the same defect one column over.
 *
 *   node --test docs/readme-settings.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(docsDir, '..');
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');

const READMES = ['README.md', 'packages/extension/README.md'];
const TABLES = ['docs/configuration.md'];

const manifest = () => JSON.parse(read('packages', 'extension', 'package.json'));

/** The settings the manifest declares, as `key → default`. */
function declaredSettings() {
  const properties = manifest().contributes?.configuration?.properties ?? {};
  const keys = Object.keys(properties);
  assert.ok(keys.length > 10, `the manifest declares ${keys.length} settings — re-read this gate`);
  return Object.fromEntries(keys.map((key) => [key, properties[key].default]));
}

/**
 * The rows of a README's Settings table, as `key → [description, default]`,
 * read from the rows whose first cell is a backticked `sandforge.*` key. The
 * default is the last cell, backticked in every row the table shipped.
 */
function documentedRows(relativePath) {
  const rows = read(...relativePath.split('/'))
    .split('\n')
    .filter((line) => /^\|\s*`sandforge\.[\w.]+`\s*\|/.test(line));
  assert.ok(rows.length > 0, `${relativePath}: no settings table found — re-point this gate`);
  const settings = {};
  for (const row of rows) {
    const cells = row.split('|').map((cell) => cell.trim());
    const key = cells[1].replace(/`/g, '');
    settings[key] = [cells[2], cells[cells.length - 2].replace(/`/g, '')];
  }
  return settings;
}

/** The same table, as `key → default`. */
function documentedSettings(relativePath) {
  return Object.fromEntries(
    Object.entries(documentedRows(relativePath)).map(([key, [, fallback]]) => [key, fallback]),
  );
}

test('the configuration page lists exactly the settings the manifest declares', () => {
  const declared = Object.keys(declaredSettings()).sort();
  for (const relativePath of TABLES) {
    const documented = Object.keys(documentedSettings(relativePath)).sort();
    assert.deepEqual(
      documented,
      declared,
      `${relativePath}: the Settings table and the manifest disagree — a key here and not in ` +
        'the manifest is a setting that does nothing, and a key there and not here is a setting ' +
        'nobody is told about',
    );
  }
});

test('the READMEs carry no second Settings table, and link the one there is', () => {
  // Two tables drifted apart the first time; a copy in a README would again.
  for (const relativePath of READMES) {
    const text = read(...relativePath.split('/'));
    assert.ok(
      !text.split('\n').some((line) => /^\|\s*`sandforge\.[\w.]+`\s*\|/.test(line)),
      `${relativePath}: a Settings table is back; the one table is docs/configuration.md`,
    );
    assert.match(
      text,
      /\]\((?:https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/master\/)?docs\/configuration\.md\)/,
      `${relativePath}: no link to the Settings table`,
    );
  }
});

test('the documented default is the manifest default', () => {
  const declared = declaredSettings();
  const offenders = [];
  for (const relativePath of TABLES) {
    for (const [key, documented] of Object.entries(documentedSettings(relativePath))) {
      const expected = String(declared[key]);
      if (documented !== expected) {
        offenders.push(
          `${relativePath} ${key}: says ${documented}, the manifest ships ${expected}`,
        );
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these rows document a default the extension does not have:\n  ' + offenders.join('\n  '),
  );
});
