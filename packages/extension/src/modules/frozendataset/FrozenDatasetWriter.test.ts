import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DeterministicPseudonymizer } from './DeterministicPseudonymizer.js';
import { FrozenDatasetAnonymizer } from './FrozenDatasetAnonymizer.js';
import { ControlNotPassedError, FrozenDatasetWriter } from './FrozenDatasetWriter.js';
import { buildFrozenManifest } from './manifest.js';
import { NonReidentificationControl } from './NonReidentificationControl.js';
import { parsePseudonymRules } from './rulesFile.js';
import { InsideRepoPathError, SasPathGuard } from './SasPathGuard.js';
import { isValidSalesforceId18, to18 } from './salesforceId.js';
import type { ExtractedDataset } from './types.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-writer-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SRC_ACCOUNT = to18('001A000000aaaaA');
const SRC_CONTACT = to18('003A000000ccccC');
const NOW = new Date('2026-08-03T12:00:00Z');

const rules = parsePseudonymRules({
  rulesVersion: '1.0.0',
  rules: {
    'Account.Name': { generator: 'companyName' },
    'Contact.LastName': { generator: 'lastName' },
    'Contact.Email': { generator: 'email' },
  },
});

/** Real pipeline fixture: extract-shaped raw data → anonymize → control. */
function runPipeline() {
  const extracted: ExtractedDataset = {
    asOf: '2026-08-01T00:00:00Z',
    recordTypeMap: [
      {
        id: to18('012A000000bbbbB'),
        sobjectType: 'Account',
        developerName: 'Business',
        name: 'Professionnel',
      },
    ],
    objects: [
      {
        objectApiName: 'Account',
        records: [
          {
            referenceId: 'Account-000001',
            sourceId: SRC_ACCOUNT,
            fields: {
              Id: SRC_ACCOUNT,
              Name: 'REDACTED-CLIENT Assistance',
              RecordTypeId: to18('012A000000bbbbB'),
              PersonContactId: SRC_CONTACT,
            },
          },
        ],
      },
      {
        objectApiName: 'Contact',
        records: [
          {
            referenceId: 'Contact-000001',
            sourceId: SRC_CONTACT,
            fields: {
              Id: SRC_CONTACT,
              LastName: 'Dupont',
              Email: 'jean.dupont@REDACTED-CLIENT.fr',
              AccountId: SRC_ACCOUNT,
            },
          },
        ],
      },
    ],
  };
  const pseudonymizer = new DeterministicPseudonymizer('writer-test-salt');
  const frozen = new FrozenDatasetAnonymizer().anonymize({
    extracted,
    rules,
    pseudonymizer,
    datasetVersion: '1.0.0',
  });
  const control = new NonReidentificationControl().run(extracted, frozen, rules, {
    author: 'qa-bot',
    now: () => NOW,
  });
  const manifest = buildFrozenManifest({
    version: '1.0.0',
    source: { orgId: '00DFAKEORGID', decisionDate: '2026-08-01' },
    saltFingerprint: pseudonymizer.saltFingerprint,
    rulesVersion: rules.rulesVersion,
    volumetry: {
      budgetMax: 2500,
      measured: { Account: 1, Contact: 1 },
      measuredAt: NOW.toISOString(),
    },
    nonReidentification: control,
    author: 'qa-bot',
    now: () => NOW,
  });
  return { extracted, frozen, control, manifest };
}

describe('FrozenDatasetWriter', () => {
  it('writes manifest, per-object data, record-types and sidecar on PASS', () => {
    const dir = makeTmpDir();
    const { frozen, control, manifest } = runPipeline();
    expect(control.passed).toBe(true);

    const writer = new FrozenDatasetWriter(new SasPathGuard(path.join(dir, 'fake-repo')));
    const result = writer.write(path.join(dir, 'dataset'), frozen, manifest, control);

    expect(fs.existsSync(path.join(result.dir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'data', 'Account.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'data', 'Contact.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'record-types.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'personcontact-sidecar.json'))).toBe(true);

    const accountData = JSON.parse(
      fs.readFileSync(path.join(result.dir, 'data', 'Account.json'), 'utf8'),
    );
    expect(accountData.records[0].referenceId).toBe('Account-000001');
    const sidecar = JSON.parse(
      fs.readFileSync(path.join(result.dir, 'personcontact-sidecar.json'), 'utf8'),
    );
    expect(sidecar).toEqual([
      { accountReferenceId: 'Account-000001', contactReferenceId: 'Contact-000001' },
    ]);
  });

  it('refuses to write anything on control FAIL (spec §5 gate)', () => {
    const dir = makeTmpDir();
    const { frozen, manifest } = runPipeline();
    const failedControl = {
      passed: false,
      checks: [
        {
          name: 'substitution' as const,
          passed: false,
          violations: [
            {
              check: 'substitution' as const,
              objectApiName: 'Account',
              referenceId: 'Account-000001',
              field: 'Name',
              detail: 'original value still present',
            },
          ],
        },
        { name: 'clear-empty' as const, passed: true, violations: [] },
        { name: 'formats' as const, passed: true, violations: [] },
        { name: 'no-residual-id' as const, passed: true, violations: [] },
      ],
      author: 'qa-bot',
      checkedAt: NOW.toISOString(),
    };
    const writer = new FrozenDatasetWriter(new SasPathGuard(path.join(dir, 'fake-repo')));
    const outDir = path.join(dir, 'dataset-fail');
    expect(() => writer.write(outDir, frozen, manifest, failedControl)).toThrow(
      ControlNotPassedError,
    );
    // Nothing was written — nothing can be versioned.
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it('refuses an output directory inside the repository even on PASS', () => {
    const { frozen, control, manifest } = runPipeline();
    const guard = new SasPathGuard();
    const writer = new FrozenDatasetWriter(guard);
    const insideRepo = path.join(guard.repoRoot, 'frozen-dataset-out');
    expect(() => writer.write(insideRepo, frozen, manifest, control)).toThrow(InsideRepoPathError);
    expect(fs.existsSync(insideRepo)).toBe(false);
  });

  it('non-leak: no original value and no source ID appears in any written artifact', () => {
    const dir = makeTmpDir();
    const { extracted, frozen, control, manifest } = runPipeline();
    const writer = new FrozenDatasetWriter(new SasPathGuard(path.join(dir, 'fake-repo')));
    const result = writer.write(path.join(dir, 'dataset'), frozen, manifest, control);

    const originalValues = [
      'REDACTED-CLIENT Assistance',
      'Dupont',
      'jean.dupont@REDACTED-CLIENT.fr',
      SRC_ACCOUNT,
      SRC_CONTACT,
    ];
    for (const file of result.files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const value of originalValues) {
        expect(content).not.toContain(value);
      }
      // Defense in depth: no checksum-valid 18-char string anywhere.
      for (const token of content.match(/[a-zA-Z0-9]{18}/g) ?? []) {
        expect(isValidSalesforceId18(token)).toBe(false);
      }
    }
    // Sanity: the fixture DID contain those values before anonymization.
    expect(JSON.stringify(extracted)).toContain('REDACTED-CLIENT Assistance');
  });
});
