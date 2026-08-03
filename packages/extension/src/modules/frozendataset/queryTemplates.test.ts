import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTokensFromSas, QueryTemplateError, renderQueryTemplate } from './queryTemplates.js';
import { InsideRepoPathError, SasPathGuard } from './SasPathGuard.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-tokens-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('renderQueryTemplate', () => {
  it('substitutes every {{TOKEN}} with its sas-provided value', () => {
    const rendered = renderQueryTemplate(
      'SELECT Id FROM Dossier__c WHERE Id IN ({{ROOT_IDS}}) AND CreatedDate <= {{AS_OF}}',
      { ROOT_IDS: "'001AAA'", AS_OF: '2026-08-01T00:00:00Z' },
    );
    expect(rendered).toBe(
      "SELECT Id FROM Dossier__c WHERE Id IN ('001AAA') AND CreatedDate <= 2026-08-01T00:00:00Z",
    );
  });

  it('refuses to render when a referenced token has no value', () => {
    expect(() => renderQueryTemplate('SELECT Id FROM X WHERE Id IN ({{ROOT_IDS}})', {})).toThrow(
      QueryTemplateError,
    );
    expect(() => renderQueryTemplate('{{A}} {{B}}', { A: '1' })).toThrow(/B/);
  });

  it('rejects invalid token names on both sides', () => {
    expect(() => renderQueryTemplate('SELECT 1', { 'bad name': 'x' })).toThrow(QueryTemplateError);
  });
});

describe('loadTokensFromSas', () => {
  it('loads token values from a JSON file in the sas', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ ROOT_IDS: "'001'" }));
    // Guard rooted at a fake repo dir: the tmp sas is outside it.
    const tokens = loadTokensFromSas(dir, 'tokens.json', new SasPathGuard(path.join(dir, 'repo')));
    expect(tokens).toEqual({ ROOT_IDS: "'001'" });
  });

  it('refuses a token file inside the repository', () => {
    const guard = new SasPathGuard();
    expect(() =>
      loadTokensFromSas(path.join(guard.repoRoot, 'packages'), 'tokens.json', guard),
    ).toThrow(InsideRepoPathError);
  });

  it('rejects malformed token files', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify(['not-an-object']));
    const guard = new SasPathGuard(path.join(dir, 'repo'));
    expect(() => loadTokensFromSas(dir, 'tokens.json', guard)).toThrow(QueryTemplateError);
  });
});
