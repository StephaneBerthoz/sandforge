import { describe, expect, it } from 'vitest';
import { DeterministicPseudonymizer } from './DeterministicPseudonymizer.js';
import { FrozenDatasetAnonymizer } from './FrozenDatasetAnonymizer.js';
import { parsePseudonymRules } from './rulesFile.js';
import { to18 } from './salesforceId.js';
import type { ExtractedDataset } from './types.js';

const ACCOUNT_ID = to18('001A000000aaaaA');
const CONTACT_ID = to18('003A000000ccccC');
const OWNER_ID = to18('005A000000eeeeE');
const RT_BUSINESS = to18('012A000000bbbbB'); // RecordType keyprefix 012 — different pod
const RT_INDIVIDUAL = to18('012A000000iiiiI');
const PLATE_IN_TEXT = to18('a00A000000ttttT'); // ID pasted into a free-text field

const pseudonymizer = new DeterministicPseudonymizer('anonymizer-test-salt');

const rules = parsePseudonymRules({
  rulesVersion: '1.0.0',
  rules: {
    'Account.Name': { generator: 'companyName' },
    'Account.Industry': { generator: 'keep', approved: true },
    'Contact.LastName': { generator: 'lastName' },
    'Contact.Email': { generator: 'email' },
  },
});

function makeExtracted(): ExtractedDataset {
  return {
    asOf: '2026-08-01T00:00:00Z',
    recordTypeMap: [
      { id: RT_BUSINESS, sobjectType: 'Account', developerName: 'Business', name: 'Professionnel' },
      {
        id: RT_INDIVIDUAL,
        sobjectType: 'Account',
        developerName: 'Individual',
        name: 'Particulier',
      },
    ],
    objects: [
      {
        objectApiName: 'Account',
        records: [
          {
            referenceId: 'Account-000001',
            sourceId: ACCOUNT_ID,
            fields: {
              Id: ACCOUNT_ID,
              Name: 'Acme Assistance',
              Industry: 'Insurance',
              RecordTypeId: RT_BUSINESS,
              OwnerId: OWNER_ID,
              PersonContactId: CONTACT_ID,
              NotesInternes__c: `client relancé, dossier ${PLATE_IN_TEXT} en cours`,
            },
          },
        ],
      },
      {
        objectApiName: 'Contact',
        records: [
          {
            referenceId: 'Contact-000001',
            sourceId: CONTACT_ID,
            fields: {
              Id: CONTACT_ID,
              LastName: 'Dupont',
              Email: 'jean.dupont@example.com',
              AccountId: ACCOUNT_ID,
            },
          },
        ],
      },
    ],
  };
}

describe('FrozenDatasetAnonymizer', () => {
  const anonymizer = new FrozenDatasetAnonymizer();

  it('drops the source Id field — referenceId is the identity', () => {
    const frozen = anonymizer.anonymize({
      extracted: makeExtracted(),
      rules,
      pseudonymizer,
      datasetVersion: '1.0.0',
    });
    const account = frozen.objects[0].records[0];
    expect(account.referenceId).toBe('Account-000001');
    expect(account.fields.Id).toBeUndefined();
    expect(JSON.stringify(frozen)).not.toContain(ACCOUNT_ID);
  });

  it('applies rules per Object.Field and clears fields without rule by default', () => {
    const frozen = anonymizer.anonymize({
      extracted: makeExtracted(),
      rules,
      pseudonymizer,
      datasetVersion: '1.0.0',
    });
    const account = frozen.objects[0].records[0];
    expect(account.fields.Name).toBe(pseudonymizer.pseudonymize('companyName', 'Acme Assistance'));
    expect(account.fields.Industry).toBe('Insurance'); // approved keep
    const contact = frozen.objects[1].records[0];
    expect(contact.fields.LastName).toBe(pseudonymizer.pseudonymize('lastName', 'Dupont'));
    expect(contact.fields.Email).toMatch(/@example\.invalid$/);
  });

  it('rewrites in-scope lookups to referenceIds', () => {
    const frozen = anonymizer.anonymize({
      extracted: makeExtracted(),
      rules,
      pseudonymizer,
      datasetVersion: '1.0.0',
    });
    const contact = frozen.objects[1].records[0];
    expect(contact.fields.AccountId).toBe('Account-000001');
  });

  it('replaces RecordTypeId by the RecordType Name and exposes name/developerName refs', () => {
    const frozen = anonymizer.anonymize({
      extracted: makeExtracted(),
      rules,
      pseudonymizer,
      datasetVersion: '1.0.0',
    });
    const account = frozen.objects[0].records[0];
    expect(account.fields.RecordTypeId).toBe('Professionnel');
    expect(frozen.recordTypes.Account).toEqual([
      { name: 'Professionnel', developerName: 'Business' },
      { name: 'Particulier', developerName: 'Individual' },
    ]);
  });

  it('dead-ID sweep empties out-of-scope lookups (18-char checksum discriminant)', () => {
    const frozen = anonymizer.anonymize({
      extracted: makeExtracted(),
      rules,
      pseudonymizer,
      datasetVersion: '1.0.0',
    });
    const account = frozen.objects[0].records[0];
    // OwnerId has no rule → clear would already empty it; prove the SWEEP
    // works independently with a keep-approved field carrying an ID below.
    expect(account.fields.OwnerId).toBe('');
  });

  it('dead-ID sweep empties checksum-valid IDs even under an approved keep rule', () => {
    const keepRules = parsePseudonymRules({
      rulesVersion: '1.0.0',
      rules: { 'Account.ExternalRef__c': { generator: 'keep', approved: true } },
    });
    const extracted = makeExtracted();
    extracted.objects[0].records[0].fields.ExternalRef__c = PLATE_IN_TEXT;
    const frozen = anonymizer.anonymize({
      extracted,
      rules: keepRules,
      pseudonymizer,
      datasetVersion: '1.0.0',
    });
    expect(frozen.objects[0].records[0].fields.ExternalRef__c).toBe('');
  });

  it('dead-ID sweep catches RecordType IDs (different pod) left in free text, preserves non-IDs', () => {
    const freeTextRules = parsePseudonymRules({
      rulesVersion: '1.0.0',
      rules: { 'Account.NotesInternes__c': { generator: 'keep', approved: true } },
    });
    const extracted = makeExtracted();
    extracted.objects[0].records[0].fields.NotesInternes__c = RT_INDIVIDUAL;
    const frozen = anonymizer.anonymize({
      extracted,
      rules: freeTextRules,
      pseudonymizer,
      datasetVersion: '1.0.0',
    });
    const account = frozen.objects[0].records[0];
    // A RecordType ID (pod 012) pasted in free text: swept like any ID.
    expect(account.fields.NotesInternes__c).toBe('');
  });

  it('preserves non-ID strings untouched by the sweep', () => {
    const freeTextRules = parsePseudonymRules({
      rulesVersion: '1.0.0',
      rules: { 'Account.NotesInternes__c': { generator: 'keep', approved: true } },
    });
    const extracted = makeExtracted();
    extracted.objects[0].records[0].fields.NotesInternes__c = 'client premium depuis 2019';
    const frozen = anonymizer.anonymize({
      extracted,
      rules: freeTextRules,
      pseudonymizer,
      datasetVersion: '1.0.0',
    });
    expect(frozen.objects[0].records[0].fields.NotesInternes__c).toBe('client premium depuis 2019');
  });

  it('emits the PersonContact sidecar as referenceId → referenceId (spec §6)', () => {
    const frozen = anonymizer.anonymize({
      extracted: makeExtracted(),
      rules,
      pseudonymizer,
      datasetVersion: '1.0.0',
    });
    expect(frozen.personContactSidecar).toEqual([
      { accountReferenceId: 'Account-000001', contactReferenceId: 'Contact-000001' },
    ]);
    // No source ID anywhere in the sidecar.
    expect(JSON.stringify(frozen.personContactSidecar)).not.toContain(CONTACT_ID);
  });

  it('keeps nulls null and absences absent (pitfall 6)', () => {
    const extracted = makeExtracted();
    extracted.objects[1].records[0].fields.MobilePhone = null;
    const frozen = anonymizer.anonymize({
      extracted,
      rules,
      pseudonymizer,
      datasetVersion: '1.0.0',
    });
    const contact = frozen.objects[1].records[0];
    expect(contact.fields.MobilePhone).toBeNull();
    expect('NeverPresent__c' in contact.fields).toBe(false);
  });

  it('cross-object join: the same value under the same generator yields the same pseudonym', () => {
    const joinRules = parsePseudonymRules({
      rulesVersion: '1.0.0',
      rules: {
        'Account.Name': { generator: 'lastName' },
        'Contact.LastName': { generator: 'lastName' },
      },
    });
    const extracted = makeExtracted();
    extracted.objects[0].records[0].fields.Name = 'Dupont';
    const frozen = anonymizer.anonymize({
      extracted,
      rules: joinRules,
      pseudonymizer,
      datasetVersion: '1.0.0',
    });
    expect(frozen.objects[0].records[0].fields.Name).toBe(
      frozen.objects[1].records[0].fields.LastName,
    );
    expect(frozen.objects[0].records[0].fields.Name).not.toBe('Dupont');
  });
});
