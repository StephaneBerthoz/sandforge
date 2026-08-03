import { describe, expect, it } from 'vitest';
import { DeterministicPseudonymizer } from './DeterministicPseudonymizer.js';
import { FrozenDatasetAnonymizer } from './FrozenDatasetAnonymizer.js';
import { NonReidentificationControl } from './NonReidentificationControl.js';
import { parsePseudonymRules, type PseudonymRulesFile } from './rulesFile.js';
import { to18 } from './salesforceId.js';
import type { ExtractedDataset, FrozenDataset } from './types.js';

const SRC_ACCOUNT = to18('001A000000aaaaA');
const VALID_ID = to18('001A000000zzzzZ');
const NOW = new Date('2026-08-03T10:00:00Z');

const pseudonymizer = new DeterministicPseudonymizer('control-test-salt');
const control = new NonReidentificationControl();

function makeExtracted(): ExtractedDataset {
  return {
    asOf: '2026-08-01T00:00:00Z',
    recordTypeMap: [],
    objects: [
      {
        objectApiName: 'Account',
        records: [
          {
            referenceId: 'Account-000001',
            sourceId: SRC_ACCOUNT,
            fields: {
              Id: SRC_ACCOUNT,
              Name: 'Acme Corp',
              Plate__c: 'AB-123-CD',
              Free__c: 'texte libre',
            },
          },
        ],
      },
    ],
  };
}

const rules: PseudonymRulesFile = parsePseudonymRules({
  rulesVersion: '1.0.0',
  rules: {
    'Account.Name': { generator: 'companyName' },
    'Account.Plate__c': { generator: 'registrationSIV' },
  },
});

function frozenWith(fields: Record<string, unknown>): FrozenDataset {
  return {
    datasetVersion: '1.0.0',
    objects: [{ objectApiName: 'Account', records: [{ referenceId: 'Account-000001', fields }] }],
    recordTypes: {},
    personContactSidecar: [],
  };
}

function checkByName(report: ReturnType<typeof control.run>, name: string) {
  const check = report.checks.find((c) => c.name === name);
  expect(check).toBeDefined();
  return check!;
}

describe('NonReidentificationControl — gate PASS', () => {
  it('passes on a properly anonymized dataset', () => {
    const extracted = makeExtracted();
    const frozen = new FrozenDatasetAnonymizer().anonymize({
      extracted,
      rules,
      pseudonymizer,
      datasetVersion: '1.0.0',
    });
    const report = control.run(extracted, frozen, rules, { author: 'qa-bot', now: () => NOW });
    expect(report.passed).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      'substitution',
      'clear-empty',
      'formats',
      'no-residual-id',
    ]);
    for (const check of report.checks) {
      expect(check.violations).toEqual([]);
    }
    expect(report.author).toBe('qa-bot');
    expect(report.checkedAt).toBe(NOW.toISOString());
  });
});

describe('NonReidentificationControl — one failure per check', () => {
  it('check 1 fails when an original value survives in its own field', () => {
    const report = control.run(
      makeExtracted(),
      frozenWith({
        Name: 'Acme Corp', // not substituted
        Plate__c: pseudonymizer.pseudonymize('registrationSIV', 'AB-123-CD'),
        Free__c: '',
      }),
      rules,
      { now: () => NOW },
    );
    expect(report.passed).toBe(false);
    const substitution = checkByName(report, 'substitution');
    expect(substitution.passed).toBe(false);
    expect(substitution.violations.some((v) => v.field === 'Name')).toBe(true);
  });

  it('check 1 catches a TRANSVERSAL leak (original value in another field)', () => {
    // Free__c has a non-clear, non-keep rule so clear-empty stays green:
    // the only possible violation is the transversal one.
    const transversalRules = parsePseudonymRules({
      rulesVersion: '1.0.0',
      rules: {
        'Account.Name': { generator: 'companyName' },
        'Account.Plate__c': { generator: 'registrationSIV' },
        'Account.Free__c': { generator: 'contractNumber' },
      },
    });
    const report = control.run(
      makeExtracted(),
      frozenWith({
        Name: pseudonymizer.pseudonymize('companyName', 'Acme Corp'),
        Plate__c: pseudonymizer.pseudonymize('registrationSIV', 'AB-123-CD'),
        Free__c: 'Acme Corp', // plate-in-brand-style leak: Name's value migrated here
      }),
      transversalRules,
      { now: () => NOW },
    );
    expect(report.passed).toBe(false);
    const substitution = checkByName(report, 'substitution');
    expect(substitution.passed).toBe(false);
    expect(substitution.violations.some((v) => v.detail.includes('transversal'))).toBe(true);
    // The leak is the ONLY violation: isolation proves the check discriminates.
    expect(report.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual(['substitution']);
  });

  it('check 2 fails on residue in a clear field', () => {
    const report = control.run(
      makeExtracted(),
      frozenWith({
        Name: pseudonymizer.pseudonymize('companyName', 'Acme Corp'),
        Plate__c: pseudonymizer.pseudonymize('registrationSIV', 'AB-123-CD'),
        Free__c: 'résidu', // no rule → clear expected → must be empty
      }),
      rules,
      { now: () => NOW },
    );
    expect(report.passed).toBe(false);
    const clearEmpty = checkByName(report, 'clear-empty');
    expect(clearEmpty.passed).toBe(false);
    expect(clearEmpty.violations.some((v) => v.field === 'Free__c')).toBe(true);
  });

  it('check 3 fails when a format is not conserved (SIV)', () => {
    const report = control.run(
      makeExtracted(),
      frozenWith({
        Name: pseudonymizer.pseudonymize('companyName', 'Acme Corp'),
        Plate__c: 'XX-99', // invalid SIV shape
        Free__c: '',
      }),
      rules,
      { now: () => NOW },
    );
    expect(report.passed).toBe(false);
    const formats = checkByName(report, 'formats');
    expect(formats.passed).toBe(false);
    expect(formats.violations.some((v) => v.field === 'Plate__c')).toBe(true);
  });

  it('check 4 fails on a residual checksum-valid source ID', () => {
    const idRules = parsePseudonymRules({
      rulesVersion: '1.0.0',
      rules: {
        'Account.Name': { generator: 'companyName' },
        'Account.Plate__c': { generator: 'registrationSIV' },
        // A non-clear rule so only check 4 can fire on the residual ID.
        'Account.Free__c': { generator: 'contractNumber' },
      },
    });
    const report = control.run(
      makeExtracted(),
      frozenWith({
        Name: pseudonymizer.pseudonymize('companyName', 'Acme Corp'),
        Plate__c: pseudonymizer.pseudonymize('registrationSIV', 'AB-123-CD'),
        Free__c: VALID_ID,
      }),
      idRules,
      { now: () => NOW },
    );
    expect(report.passed).toBe(false);
    const noResidualId = checkByName(report, 'no-residual-id');
    expect(noResidualId.passed).toBe(false);
    expect(noResidualId.violations.some((v) => v.field === 'Free__c')).toBe(true);
    expect(report.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual(['no-residual-id']);
  });
});

describe('NonReidentificationControl — pitfall 6 semantics', () => {
  it('absent and null clear-fields are NOT confounded with non-empty residue', () => {
    const extracted = makeExtracted();
    // Original Free__c was already null → nothing to substitute, and the
    // frozen record may omit the field entirely (tree-export semantics).
    extracted.objects[0].records[0].fields.Free__c = null;
    const frozen: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Account',
          records: [
            {
              referenceId: 'Account-000001',
              fields: {
                Name: pseudonymizer.pseudonymize('companyName', 'Acme Corp'),
                Plate__c: pseudonymizer.pseudonymize('registrationSIV', 'AB-123-CD'),
                // Free__c absent — acceptable, not a residue.
              },
            },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
    };
    const report = control.run(extracted, frozen, rules, { now: () => NOW });
    expect(report.passed).toBe(true);
  });
});
