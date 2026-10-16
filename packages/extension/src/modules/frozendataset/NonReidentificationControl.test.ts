import { describe, expect, it } from 'vitest';
import { PIIDetector } from '../../core/precheck/PIIDetector.js';
import { DeterministicPseudonymizer } from './DeterministicPseudonymizer.js';
import { FrozenDatasetAnonymizer } from './FrozenDatasetAnonymizer.js';
import { NonReidentificationControl } from './NonReidentificationControl.js';
import { parsePseudonymRules, withSchemaDefaults, type PseudonymRulesFile } from './rulesFile.js';
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
    unboundedObjects: [],
    fileFields: {},
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

describe('NonReidentificationControl — what a record keeps on purpose', () => {
  const RECORD_TYPE = to18('012A00000000001');
  const OTHER_TYPE = to18('012A00000000002');
  const empty = parsePseudonymRules({ rulesVersion: '1.0.0', rules: {} });

  /** An account of a record type whose name is its developer name, with fields that mirror it. */
  function mirrored(fields: Record<string, unknown>): ExtractedDataset {
    return {
      asOf: '2026-08-01T00:00:00Z',
      unboundedObjects: [],
      fileFields: {},
      recordTypeMap: [
        {
          id: RECORD_TYPE,
          sobjectType: 'Account',
          developerName: 'Particulier',
          name: 'Particulier',
        },
        { id: OTHER_TYPE, sobjectType: 'Account', developerName: 'Societe', name: 'Société' },
      ],
      objects: [
        {
          objectApiName: 'Account',
          records: [
            {
              referenceId: 'Account-000001',
              sourceId: SRC_ACCOUNT,
              fields: { Id: SRC_ACCOUNT, RecordTypeId: RECORD_TYPE, ...fields },
            },
          ],
        },
      ],
    };
  }

  it("does not count a field that mirrors the record type's name as a leak into RecordTypeId", () => {
    // Run against a real org, three such fields made fifty "leaks".
    const extracted = mirrored({
      TECH_RecordTypeDeveloperName__c: 'Particulier',
      RecordtypeName__c: 'Particulier',
      LastName: 'Martin',
    });
    const frozen = new FrozenDatasetAnonymizer().anonymize({
      extracted,
      rules: empty,
      pseudonymizer,
      datasetVersion: '1.0.0',
    });

    expect(frozen.objects[0].records[0].fields.RecordTypeId).toBe('Particulier');
    const report = control.run(extracted, frozen, empty, { now: () => NOW });
    expect(checkByName(report, 'substitution').violations).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('does not count a value a kept picklist holds as a leak of a field that repeats it', () => {
    const extracted = mirrored({ Segment_Text__c: 'Premium', Segment__c: 'Premium' });
    const rules = withSchemaDefaults(
      empty,
      new Map([['Account', [{ name: 'Segment__c', type: 'picklist', restrictedPicklist: true }]]]),
      new PIIDetector(),
    );
    const frozen = new FrozenDatasetAnonymizer().anonymize({
      extracted,
      rules,
      pseudonymizer,
      datasetVersion: '1.0.0',
    });

    expect(frozen.objects[0].records[0].fields.Segment__c).toBe('Premium');
    expect(control.run(extracted, frozen, rules, { now: () => NOW }).passed).toBe(true);
  });

  it('still fails a cleared personal value found in another field', () => {
    const rules = parsePseudonymRules({
      rulesVersion: '1.0.0',
      rules: { 'Account.Description': { generator: 'contractNumber' } },
    });
    const report = control.run(
      mirrored({ LastName: 'Martin', Description: 'Dossier' }),
      frozenWith({ RecordTypeId: 'Particulier', LastName: '', Description: 'Martin' }),
      rules,
      { now: () => NOW },
    );

    expect(report.passed).toBe(false);
    expect(checkByName(report, 'substitution').violations).toEqual([
      expect.objectContaining({
        field: 'Description',
        detail: 'transversal leak: original value of "LastName" found in "Description"',
      }),
    ]);
  });

  it("still fails a personal value found in RecordTypeId that is not the record type's name", () => {
    const report = control.run(
      mirrored({ LastName: 'Martin', RecordtypeName__c: 'Société' }),
      frozenWith({ RecordTypeId: 'Martin', LastName: '', RecordtypeName__c: '' }),
      empty,
      { now: () => NOW },
    );

    expect(checkByName(report, 'substitution').violations).toEqual([
      expect.objectContaining({
        field: 'RecordTypeId',
        detail: 'transversal leak: original value of "LastName" found in "RecordTypeId"',
      }),
    ]);
  });

  it("still fails the name of another record type than the record's own in RecordTypeId", () => {
    const report = control.run(
      mirrored({ RecordtypeName__c: 'Société' }),
      frozenWith({ RecordTypeId: 'Société', RecordtypeName__c: '' }),
      empty,
      { now: () => NOW },
    );

    expect(report.passed).toBe(false);
  });
});

describe('NonReidentificationControl — absence vs emptiness semantics', () => {
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

describe('NonReidentificationControl — objects left out on purpose', () => {
  it('does not report an object the anonymizer left out as a missing record', () => {
    // Files the rules do not keep leave their object out of the dataset; the
    // control read their absence as a record lost, and failed every
    // extraction that reached a quote document.
    const extracted = makeExtracted();
    extracted.fileFields = { QuoteDocument: ['Document'] };
    extracted.objects.push({
      objectApiName: 'QuoteDocument',
      records: [
        {
          referenceId: 'QuoteDocument-000001',
          sourceId: 'doc',
          fields: { Id: 'doc', Document: 'JVBERi0xLjQK' },
        },
      ],
    });
    const frozen = new FrozenDatasetAnonymizer().anonymize({
      extracted,
      rules,
      pseudonymizer,
      datasetVersion: '1.0.0',
    });
    expect(frozen.filesLeftOut).toEqual(['QuoteDocument']);

    const report = control.run(extracted, frozen, rules, { now: () => NOW });

    expect(checkByName(report, 'substitution').violations).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('still reports a record lost from an object that was kept', () => {
    const extracted = makeExtracted();
    const frozen = new FrozenDatasetAnonymizer().anonymize({
      extracted,
      rules,
      pseudonymizer,
      datasetVersion: '1.0.0',
    });
    frozen.objects[0].records = [];

    const report = control.run(extracted, frozen, rules, { now: () => NOW });

    expect(checkByName(report, 'substitution').violations[0].detail).toBe(
      'record missing from the frozen dataset',
    );
  });
});
