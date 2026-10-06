import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ja from '../../i18n/locales/ja.json';
import ptBR from '../../i18n/locales/pt-BR.json';
import { FORGE_GUIDE_URL, guideAnchorOf, translateForgeError } from './forgeErrorTranslator';

/** A file of the repository, read from the package or from the repository root. */
function repositoryFile(...parts: string[]): string {
  // Vitest runs from the package or from the repository root.
  const path = [
    resolve(process.cwd(), ...parts),
    resolve(process.cwd(), '..', '..', ...parts),
  ].find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`${parts.join('/')} not found from ${process.cwd()}`);
  return readFileSync(path, 'utf8');
}

/**
 * The ten codes a clone met with nothing said under them but "look up this
 * error code": one message each, as the target words it, with the hint it
 * gets and how much it costs the clone.
 */
const TEN_CODES: ReadonlyArray<{
  raw: string;
  code: string;
  hint: string;
  severity: 'info' | 'warning' | 'error';
}> = [
  {
    raw: 'FIELD_FILTER_VALIDATION_EXCEPTION: Value does not exist or does not match filter criteria. [AccountId]',
    code: 'FIELD_FILTER_VALIDATION_EXCEPTION',
    hint: 'lookupFilter',
    severity: 'warning',
  },
  {
    raw: 'DUPLICATES_DETECTED: Use one of these records?',
    code: 'DUPLICATES_DETECTED',
    hint: 'duplicateRule',
    severity: 'warning',
  },
  {
    raw: 'INACTIVE_OWNER_OR_USER: operation performed with inactive user [005000000000001AAA] as owner of [case]',
    code: 'INACTIVE_OWNER_OR_USER',
    hint: 'inactiveUser',
    severity: 'error',
  },
  {
    raw: 'ENTITY_IS_DELETED: entity is deleted [ParentId]',
    code: 'ENTITY_IS_DELETED',
    hint: 'entityDeleted',
    severity: 'warning',
  },
  {
    raw: 'UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record or 200 records',
    code: 'UNABLE_TO_LOCK_ROW',
    hint: 'rowLocked',
    severity: 'warning',
  },
  {
    raw: 'REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.',
    code: 'REQUEST_LIMIT_EXCEEDED',
    hint: 'requestLimit',
    severity: 'error',
  },
  {
    raw: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: insufficient access rights on cross-reference id: 001000000000001AAA',
    code: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
    hint: 'crossReferenceAccess',
    severity: 'error',
  },
  {
    raw: 'NUMBER_OUTSIDE_VALID_RANGE: Discount: value outside of valid range on numeric field: 123456 [Discount__c]',
    code: 'NUMBER_OUTSIDE_VALID_RANGE',
    hint: 'numberOutOfRange',
    severity: 'warning',
  },
  {
    raw: 'MALFORMED_ID: Region: id value of incorrect type: North [Region__c]',
    code: 'MALFORMED_ID',
    hint: 'malformedId',
    severity: 'error',
  },
  {
    raw:
      'CANNOT_EXECUTE_FLOW_TRIGGER: We can’t save this record because the “Case Created” process failed. ' +
      'Give your Salesforce admin these details. An error occurred when executing a flow interview.',
    code: 'CANNOT_EXECUTE_FLOW_TRIGGER',
    hint: 'flowFailed',
    severity: 'error',
  },
];

/** One message per code of the guide's table the translator mapped before the ten. */
const SAMPLES_WITH_A_ROW: readonly string[] = [
  'DUPLICATE_VALUE: duplicate value found: ExternalId__c',
  'INVALID_CROSS_REFERENCE_KEY: Owner ID: cannot be blank',
  'REQUIRED_FIELD_MISSING: Required fields are missing: [AccountId]',
  'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: X',
  'FIELD_CUSTOM_VALIDATION_EXCEPTION: Enter the phone in international format [Phone]',
  'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: entity type cannot be inserted: Case History',
  'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: CaseTrigger: execution of BeforeInsert caused by: System.NullPointerException',
  'FIELD_INTEGRITY_EXCEPTION: Every asset needs an account, a contact, or both.',
];

describe('translateForgeError', () => {
  it('returns null on empty input', () => {
    expect(translateForgeError('')).toBeNull();
    expect(translateForgeError('   ')).toBeNull();
  });

  it('translates DUPLICATE_VALUE to its i18n keys (warning severity)', () => {
    const result = translateForgeError('DUPLICATE_VALUE: duplicate value found: ExternalId__c');
    expect(result?.code).toBe('DUPLICATE_VALUE');
    expect(result?.severity).toBe('warning');
    expect(result?.explanationKey).toBe('forge.error.duplicateValue.explanation');
    expect(result?.actionKey).toBe('forge.error.duplicateValue.action');
  });

  it('translates INVALID_CROSS_REFERENCE_KEY as info (auto-handled)', () => {
    const result = translateForgeError('INVALID_CROSS_REFERENCE_KEY: Owner ID: cannot be blank');
    expect(result?.code).toBe('INVALID_CROSS_REFERENCE_KEY');
    expect(result?.severity).toBe('info');
    expect(result?.explanationKey).toBe('forge.error.invalidCrossReferenceKey.explanation');
  });

  it('captures REQUIRED_FIELD_MISSING detail in vars', () => {
    const result = translateForgeError(
      'REQUIRED_FIELD_MISSING: Required fields are missing: [NameInsuredId]',
    );
    expect(result?.code).toBe('REQUIRED_FIELD_MISSING');
    expect(result?.severity).toBe('error');
    expect(result?.vars?.detail).toContain('Required fields');
  });

  it('translates INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST', () => {
    const result = translateForgeError(
      'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: UncertainContract',
    );
    expect(result?.code).toBe('INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST');
    expect(result?.severity).toBe('warning');
    expect(result?.explanationKey).toBe('forge.error.invalidPicklist.explanation');
  });

  it('still reads the code of a refusal followed by the fields it named', () => {
    // The extension names the fields after the message, where the platform's
    // words for a restricted picklist name the value alone.
    const result = translateForgeError(
      'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Gold [Rating__c]',
    );
    expect(result?.code).toBe('INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST');
    expect(result?.explanationKey).toBe('forge.error.invalidPicklist.explanation');
  });

  it('explains a restricted picklist refusal with what the clone does about it, and why the check let the value through', () => {
    const result = translateForgeError(
      'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Yes [Rating__c]',
    );
    expect(result?.explanationKey).toBe('forge.error.invalidPicklist.explanation');
    // What the Errors panel shows under such a message, in English: the
    // record went again without the field, and one listed could not.
    const explanation = en.forge.error.invalidPicklist.explanation;
    expect(explanation).toContain('one never given values of a field takes none of them');
    expect(explanation).toContain(
      'the clone writes the record again without that field; a record listed here could not be written that way',
    );
  });

  it('explains a validation rule the record was refused by, and what the clone does about it', () => {
    const result = translateForgeError(
      'FIELD_CUSTOM_VALIDATION_EXCEPTION: Enter the phone in international format [Phone]',
    );
    expect(result?.code).toBe('FIELD_CUSTOM_VALIDATION_EXCEPTION');
    expect(result?.severity).toBe('warning');
    expect(result?.explanationKey).toBe('forge.error.fieldCustomValidation.explanation');
    expect(result?.actionKey).toBe('forge.error.fieldCustomValidation.action');
  });

  it('captures FIELD_INTEGRITY_EXCEPTION detail', () => {
    const result = translateForgeError(
      'FIELD_INTEGRITY_EXCEPTION: Every asset needs an account, a contact, or both.: Account ID, Contact ID',
    );
    expect(result?.code).toBe('FIELD_INTEGRITY_EXCEPTION');
    expect(result?.severity).toBe('error');
    expect(result?.vars?.detail).toContain('Every asset needs');
  });

  it('translates CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY as info', () => {
    const result = translateForgeError(
      'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: entity type cannot be inserted: Case History',
    );
    expect(result?.code).toBe('CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY');
    expect(result?.severity).toBe('info');
    expect(result?.explanationKey).toBe('forge.error.cannotInsertEntity.explanation');
  });

  it("explains the same code from the target's automation as that automation failing, not as an object to leave out", () => {
    // An object that takes no insert is skipped before its write: what comes
    // under this code otherwise is a trigger, a Flow or a process of the
    // target failing on the record.
    const result = translateForgeError(
      'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: CaseTrigger: execution of BeforeInsert caused by: ' +
        'System.NullPointerException: Attempt to de-reference a null object: Trigger.CaseTrigger: line 12, column 1',
    );
    expect(result?.code).toBe('CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY');
    expect(result?.severity).toBe('error');
    expect(result?.explanationKey).toBe('forge.error.automationRefused.explanation');
    expect(result?.actionKey).toBe('forge.error.automationRefused.action');
    expect(en.forge.error.automationRefused.explanation).toContain(
      'a trigger, a Flow or a process',
    );
    expect(en.forge.error.automationRefused.action).not.toContain('Leave this object out');
  });

  it('explains a lookup left empty because its record is not in the clone, as a note, whether or not the run named its object', () => {
    // The extension's words, with the object pointed at when it can tell it,
    // and without it when it cannot.
    for (const raw of [
      'Written with the lookup empty: the InsurancePolicy record it points at is not in the clone.',
      'Written with the lookup empty: the record it points at is not in the clone.',
    ]) {
      const result = translateForgeError(raw);
      expect(result?.code).toBe('LOOKUP_OUTSIDE_THE_CLONE');
      expect(result?.severity).toBe('info');
      expect(result?.explanationKey).toBe('forge.error.lookupOutsideClone.explanation');
      expect(result?.actionKey).toBe('forge.error.lookupOutsideClone.action');
    }
    expect(en.forge.error.lookupOutsideClone.explanation).toContain('nothing failed');
  });

  it('explains an object the target describes but takes no insert of, skipped whole', () => {
    const result = translateForgeError('Object is not createable on target org');

    expect(result?.code).toBe('NOT_CREATEABLE_ON_TARGET');
    expect(result?.severity).toBe('warning');
    expect(result?.explanationKey).toBe('forge.error.notCreateable.explanation');
    expect(result?.actionKey).toBe('forge.error.notCreateable.action');
  });

  it('explains an object the target org does not have, or does not show the user the run writes as', () => {
    const result = translateForgeError(
      'Object is not in the target org, or the user the run writes as cannot see it: ' +
        'none of its records can be written there',
    );
    expect(result?.code).toBe('NOT_IN_TARGET_ORG');
    expect(result?.severity).toBe('error');
    expect(result?.explanationKey).toBe('forge.error.notInTarget.explanation');
    expect(result?.actionKey).toBe('forge.error.notInTarget.action');
  });

  it('says a lookup the second pass could not fill in points at a record the run did not write, which a retry writes', () => {
    // A lookup at a record outside the clone is a note of its own since
    // 1.40.2: one left for the second pass points at a record the run did not
    // write — it failed, or its object failed or was skipped. Raising the
    // depth reaches no such record.
    const result = translateForgeError(
      "Cycle FK 'OriginalPolicyId' could not be resolved — referenced parent (source 0YT000000000001AAA) was not cloned",
    );
    expect(result?.explanationKey).toBe('forge.error.cycleFkUnresolved.explanation');
    const { explanation, action } = en.forge.error.cycleFkUnresolved;
    expect(explanation).toContain('points to a record this run did not write');
    expect(action).toContain(
      'retry the failed objects: the retry writes it and fills in this link',
    );
    expect(action).not.toContain('Raise the depth');
  });

  it('translates Cycle FK with field name + source ref', () => {
    const result = translateForgeError(
      "Cycle FK 'PrimaryContactId' could not be resolved — referenced parent (source 003ABC123) was not cloned",
    );
    expect(result?.code).toBe('CYCLE_FK_UNRESOLVED');
    expect(result?.severity).toBe('warning');
    expect(result?.vars?.fieldName).toBe('PrimaryContactId');
    expect(result?.vars?.sourceRefId).toBe('003ABC123');
  });

  it('explains an object the run held back over a record type the running user cannot use', () => {
    const result = translateForgeError(
      'RECORD_TYPE_UNAVAILABLE: 2 Case records use record type Partner_Case (Partner Case), ' +
        'which the running user cannot use in the target org. Give the running user access to ' +
        'record type Partner_Case on Case, or map it to one they have.',
    );
    expect(result?.code).toBe('RECORD_TYPE_UNAVAILABLE');
    expect(result?.severity).toBe('error');
    expect(result?.explanationKey).toBe('forge.error.recordTypeHeldBack.explanation');
    expect(result?.actionKey).toBe('forge.error.recordTypeHeldBack.action');
  });

  it('translates out-of-scope messages as info', () => {
    const result = translateForgeError('no parent in cache and not the root');
    expect(result?.code).toBe('OUT_OF_SCOPE');
    expect(result?.severity).toBe('info');
    expect(result?.explanationKey).toBe('forge.error.outOfScope.explanation');
  });

  it('falls back to unknown keys with the raw detail', () => {
    const result = translateForgeError('SOMETHING_NEW: details about the new error');
    expect(result?.code).toBe('SOMETHING_NEW');
    expect(result?.severity).toBe('error');
    expect(result?.explanationKey).toBe('forge.error.unknown.explanation');
    expect(result?.vars?.detail).toContain('details about the new error');
  });

  it('returns null when message has no recognizable format', () => {
    expect(translateForgeError('not a salesforce error')).toBeNull();
  });

  it.each(TEN_CODES)(
    'says what $code means and what to do about it, as a $severity, with its row in the guide',
    ({ raw, code, hint, severity }) => {
      expect(translateForgeError(raw)).toEqual({
        code,
        explanationKey: `forge.error.${hint}.explanation`,
        actionKey: `forge.error.${hint}.action`,
        vars: undefined,
        severity,
        docUrl: `${FORGE_GUIDE_URL}#${guideAnchorOf(code)}`,
      });
    },
  );

  it('tells a duplicate rule that blocks apart from a unique value the target already holds', () => {
    // Every write saves past a rule set to Allow: a rule that still refuses
    // is set to Block, and the way out is in its settings, not in --upsert.
    expect(translateForgeError('DUPLICATES_DETECTED: Use one of these records?')?.actionKey).toBe(
      'forge.error.duplicateRule.action',
    );
    expect(en.forge.error.duplicateRule.explanation).toContain('set to Block');
    expect(en.forge.error.duplicateRule.action).not.toContain('--upsert');
    expect(
      translateForgeError('DUPLICATE_VALUE: duplicate value found: ExternalId__c')?.actionKey,
    ).toBe('forge.error.duplicateValue.action');
  });

  it('says a failed Flow may be a Send Email action the sandbox cannot send, and warns off opening every email', () => {
    const { explanation, action } = en.forge.error.flowFailed;
    expect(explanation).toContain('No access');
    expect(explanation).toContain('email template or logs the email');
    expect(explanation).toContain('System email only');
    expect(action).toContain('Deactivate that Flow');
    expect(action).toContain('the people on the cloned records');
  });

  it('says a lock is transient, and that retrying is the way through', () => {
    expect(en.forge.error.rowLocked.explanation).toContain('transient');
    expect(en.forge.error.rowLocked.action).toMatch(/^Retry the failed objects/);
  });

  it('names the inactive user as one of the target, since every record the clone creates is its running user', () => {
    expect(en.forge.error.inactiveUser.explanation).toContain(
      'The clone leaves each record it creates to the user it writes as',
    );
  });
});

describe('the way from a hint to the Forge guide', () => {
  /** The anchors of the rows of the guide's table of common errors. */
  const guideAnchors = (): string[] => {
    const guide = repositoryFile('docs', 'forge-quickstart.md');
    const table = guide.split('## Common errors and what they mean')[1]?.split('\n## ')[0] ?? '';
    return [...table.matchAll(/<a name="([^"]+)"><\/a>/g)].map((m) => m[1]);
  };

  it('links each hint whose code the table lists to that row, and every row has a hint linking to it', () => {
    const anchors = guideAnchors();
    // Positive control: the walk reads the table's anchors.
    expect(anchors.length).toBeGreaterThanOrEqual(17);
    const linked = new Set<string>();
    for (const raw of [...SAMPLES_WITH_A_ROW, ...TEN_CODES.map((c) => c.raw)]) {
      const docUrl = translateForgeError(raw)?.docUrl;
      expect({ raw, docUrl }).toEqual({ raw, docUrl: expect.any(String) });
      const [base, anchor] = (docUrl as string).split('#');
      expect(base).toBe(FORGE_GUIDE_URL);
      expect(anchors).toContain(anchor);
      linked.add(anchor);
    }
    expect([...linked].sort()).toEqual([...new Set(anchors)].sort());
  });

  it('gives each row an anchor of its own', () => {
    const anchors = guideAnchors();
    expect(anchors).toHaveLength(new Set(anchors).size);
  });

  it('links no hint whose code the table has no row for', () => {
    for (const raw of [
      'SOMETHING_NEW: details about the new error',
      'STRING_TOO_LONG: Name: data value too large',
      "INVALID_CROSS_REFERENCE_KEY: Record Type ID: this ID value isn't valid for the user",
      'Object is not createable on target org',
      "Cycle FK 'ParentId' could not be resolved",
    ]) {
      const result = translateForgeError(raw);
      expect(result).not.toBeNull();
      expect({ raw, docUrl: result?.docUrl }).toEqual({ raw, docUrl: undefined });
    }
  });

  it('links the guide at the address the Marketplace README gives it, which the public-links check fetches', () => {
    // scripts/check-public-links.mjs fetches every link of that README
    // anonymously before a release: the address the hints open is one of them.
    const readme = repositoryFile('packages', 'extension', 'README.md');
    expect(readme).toContain(`](${FORGE_GUIDE_URL})`);
  });
});

/*
 * ForgeResults renders `t(explanationKey)` and `t(actionKey)` with no default,
 * so a key missing from a locale shows up in the Errors panel as the raw
 * `forge.error.…` path instead of a hint.
 */
describe('forge.error hint keys', () => {
  const LOCALES: Record<string, unknown> = { en, fr, de, es, ja, 'pt-BR': ptBR };

  /** One raw Salesforce or executor message per translator branch. */
  const SAMPLES: readonly string[] = [
    'DUPLICATE_VALUE: duplicate value found: ExternalId__c',
    'INVALID_CROSS_REFERENCE_KEY: Owner ID: cannot be blank',
    'REQUIRED_FIELD_MISSING: Required fields are missing: [AccountId]',
    'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: X',
    'FIELD_CUSTOM_VALIDATION_EXCEPTION: Enter the phone in international format [Phone]',
    'INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: Name',
    'FIELD_INTEGRITY_EXCEPTION: Every asset needs an account, a contact, or both.',
    'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: entity type cannot be inserted: Case History',
    'INSUFFICIENT_ACCESS_OR_READONLY: insufficient access rights on object id',
    'INSUFFICIENT_ACCESS: insufficient access rights',
    'STORAGE_LIMIT_EXCEEDED: storage limit exceeded',
    'INVALID_TYPE: sObject type is not supported',
    'NOT_FOUND: The requested resource does not exist',
    'STRING_TOO_LONG: Name: data value too large',
    'SOMETHING_NEW: details about the new error',
    "Cycle FK 'PrimaryContactId' could not be resolved — referenced parent (source 003ABC123) was not cloned",
    "Cycle FK 'ParentId' could not be resolved",
    'no parent in cache and not the root',
    'STANDARD_PRICE_NOT_DEFINED: Before creating a custom price, create a standard price.',
    "INVALID_CROSS_REFERENCE_KEY: Record Type ID: this ID value isn't valid for the user",
    'RECORD_TYPE_UNAVAILABLE: 1 Case record uses record type Partner_Case, which the running user cannot use in the target org.',
    'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: CaseTrigger: execution of BeforeInsert caused by: System.NullPointerException',
    'Written with the lookup empty: the InsurancePolicy record it points at is not in the clone.',
    'Object is not in the target org, or the user the run writes as cannot see it: none of its records can be written there',
    'Object is not createable on target org',
    ...TEN_CODES.map(({ raw }) => raw),
  ];

  /** Walk a dotted key through a locale object. */
  const lookup = (bundle: unknown, key: string): unknown =>
    key
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          node !== null && typeof node === 'object'
            ? (node as Record<string, unknown>)[part]
            : undefined,
        bundle,
      );

  /** The `{{name}}` placeholders a value interpolates, sorted. */
  const placeholders = (value: unknown): string[] =>
    typeof value === 'string' ? [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]) : [];

  const translated = SAMPLES.map((raw) => {
    const result = translateForgeError(raw);
    if (!result) throw new Error(`no translation for sample: ${raw}`);
    return result;
  });
  const keys = [...new Set(translated.flatMap((r) => [r.explanationKey, r.actionKey]))].sort();

  it('samples every key the translator can produce', () => {
    // Vitest runs from the package or from the repository root.
    const path = ['src/pages/Forge', 'packages/webview/src/pages/Forge']
      .map((dir) => resolve(process.cwd(), dir, 'forgeErrorTranslator.ts'))
      .find((candidate) => existsSync(candidate));
    if (!path) throw new Error('forgeErrorTranslator.ts not found from ' + process.cwd());
    const written = new Set(
      [
        ...readFileSync(path, 'utf8').matchAll(/'(forge\.error\.\w+\.(?:explanation|action))'/g),
      ].map((m) => m[1]),
    );
    expect(keys).toEqual([...written].sort());
  });

  for (const [locale, bundle] of Object.entries(LOCALES)) {
    it(`resolves every generated key to text in ${locale}`, () => {
      const missing = keys.filter((key) => {
        const value = lookup(bundle, key);
        return typeof value !== 'string' || value.trim() === '';
      });
      expect(missing).toEqual([]);
    });
  }

  it('interpolates, in every locale, exactly the variables the translator passes', () => {
    for (const result of translated) {
      const expected = Object.keys(result.vars ?? {}).sort();
      for (const [locale, bundle] of Object.entries(LOCALES)) {
        const used = [
          ...new Set([
            ...placeholders(lookup(bundle, result.explanationKey)),
            ...placeholders(lookup(bundle, result.actionKey)),
          ]),
        ].sort();
        expect({ locale, key: result.explanationKey, used }).toEqual({
          locale,
          key: result.explanationKey,
          used: expected,
        });
      }
    }
  });
});
