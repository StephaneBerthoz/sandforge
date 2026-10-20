import { describe, it, expect } from 'vitest';
import {
  FORGE_GUIDE_URL,
  bannerHintOf,
  cataloguedErrorCodes,
  guideAnchorOf,
  helpSearchUrlOf,
  isCataloguedErrorCode,
  panelWordingOf,
  translateError,
} from './error-hints.js';

/** What Forge makes of a message. */
const forge = (raw: string, code?: string) => translateError(raw, { code, module: 'forge' });

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

/**
 * SandForge's own refusals of a Forge run before it wrote anything, as the
 * extension sends them: the message it words, and the code beside it.
 */
const REFUSALS: ReadonlyArray<{
  message: string;
  code: string;
  hint: string;
  severity: 'info' | 'warning' | 'error';
}> = [
  {
    message: 'Operation blocked by Production Guard: insert is not allowed on production org',
    code: 'GUARD_BLOCKED',
    hint: 'guardBlocked',
    severity: 'error',
  },
  {
    message: 'Operation cancelled by user (production confirmation declined).',
    code: 'GUARD_DECLINED',
    hint: 'guardDeclined',
    severity: 'info',
  },
  {
    message: 'Production Guard is not initialized — infrastructure services missing',
    code: 'NOT_INITIALIZED',
    hint: 'notInitialized',
    severity: 'error',
  },
  {
    message:
      'Another Forge run is still under way in this window: start this one once it has ended. A run asked to stop ends once the step under way is done.',
    code: 'FORGE_RUNNING',
    hint: 'forgeRunning',
    severity: 'warning',
  },
  {
    message: 'Duplicate forge operation: forge:src:tgt:001:Account:1',
    code: 'DUPLICATE',
    hint: 'duplicateRun',
    severity: 'warning',
  },
  {
    message:
      'The run to retry is no longer in the history, so what it wrote is not known. Run the clone again from Review.',
    code: 'RETRY_UNAVAILABLE',
    hint: 'retryUnavailable',
    severity: 'warning',
  },
  {
    message:
      'This run anonymizes its records, and the content of a file cannot be anonymized: files are copied only once you accept that they are copied as they are. Nothing was read or written.',
    code: 'FILES_NOT_ACCEPTED',
    hint: 'filesNotAccepted',
    severity: 'warning',
  },
  {
    message: 'Forge execution was aborted before it started. Nothing was written.',
    code: 'ABORTED_BEFORE_START',
    hint: 'abortedBeforeStart',
    severity: 'info',
  },
  {
    message:
      'This run was taken up already, or its run ended: only the last part of a run that stopped can be resumed.',
    code: 'RESUME_UNAVAILABLE',
    hint: 'resumeUnavailable',
    severity: 'warning',
  },
  {
    message:
      'DEV is no longer the org this run wrote to — refreshed or replaced since: what the run wrote is not there.',
    code: 'RESUME_TARGET_CHANGED',
    hint: 'resumeTargetChanged',
    severity: 'warning',
  },
  {
    message:
      'The clone on this page is set up otherwise than the run to resume: its objects, filters or decisions changed since.',
    code: 'RESUME_CHANGED',
    hint: 'resumeChanged',
    severity: 'warning',
  },
  {
    message:
      '200 row(s) may already be in DEV (200 Contact): the insert call that sent them was under way when the run stopped.',
    code: 'RESUME_UNCERTAIN',
    hint: 'resumeUncertain',
    severity: 'warning',
  },
];

/** The session an org's request went with, refused: the platform's words, its code in front. */
const SESSION_REFUSED = 'INVALID_SESSION_ID: Session expired or invalid';

describe('translateError in Forge', () => {
  it('returns null on empty input', () => {
    expect(forge('')).toBeNull();
    expect(forge('   ')).toBeNull();
  });

  it('translates DUPLICATE_VALUE to Forge’s own keys (warning severity)', () => {
    const result = forge('DUPLICATE_VALUE: duplicate value found: ExternalId__c');
    expect(result?.code).toBe('DUPLICATE_VALUE');
    expect(result?.severity).toBe('warning');
    expect(result?.explanationKey).toBe('errors.duplicateValue.forge.explanation');
    expect(result?.actionKey).toBe('errors.duplicateValue.forge.action');
  });

  it('translates INVALID_CROSS_REFERENCE_KEY as info', () => {
    const result = forge('INVALID_CROSS_REFERENCE_KEY: Owner ID: cannot be blank');
    expect(result?.code).toBe('INVALID_CROSS_REFERENCE_KEY');
    expect(result?.severity).toBe('info');
    expect(result?.explanationKey).toBe('errors.invalidCrossReferenceKey.forge.explanation');
  });

  it('captures REQUIRED_FIELD_MISSING detail in vars', () => {
    const result = forge('REQUIRED_FIELD_MISSING: Required fields are missing: [NameInsuredId]');
    expect(result?.code).toBe('REQUIRED_FIELD_MISSING');
    expect(result?.severity).toBe('error');
    expect(result?.vars?.detail).toContain('Required fields');
  });

  it('still reads the code of a refusal followed by the fields it named', () => {
    const result = forge(
      'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Gold [Rating__c]',
    );
    expect(result?.code).toBe('INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST');
    expect(result?.explanationKey).toBe('errors.invalidPicklist.forge.explanation');
  });

  it('captures FIELD_INTEGRITY_EXCEPTION detail', () => {
    const result = forge(
      'FIELD_INTEGRITY_EXCEPTION: Every asset needs an account, a contact, or both.: Account ID, Contact ID',
    );
    expect(result?.code).toBe('FIELD_INTEGRITY_EXCEPTION');
    expect(result?.severity).toBe('error');
    expect(result?.vars?.detail).toContain('Every asset needs');
  });

  it('translates an object that takes no insert as info', () => {
    const result = forge(
      'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: entity type cannot be inserted: Case History',
    );
    expect(result?.code).toBe('CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY');
    expect(result?.severity).toBe('info');
    expect(result?.explanationKey).toBe('errors.cannotInsertEntity.forge.explanation');
  });

  it("explains the same code from the target's automation as that automation failing", () => {
    const result = forge(
      'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: CaseTrigger: execution of BeforeInsert caused by: ' +
        'System.NullPointerException: Attempt to de-reference a null object: Trigger.CaseTrigger: line 12, column 1',
    );
    expect(result?.code).toBe('CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY');
    expect(result?.severity).toBe('error');
    expect(result?.explanationKey).toBe('errors.automationRefused.forge.explanation');
    expect(result?.actionKey).toBe('errors.automationRefused.forge.action');
  });

  it('explains a lookup left empty because its record is not in the clone, as a note', () => {
    for (const raw of [
      'Written with the lookup empty: the InsurancePolicy record it points at is not in the clone.',
      'Written with the lookup empty: the record it points at is not in the clone.',
    ]) {
      const result = forge(raw);
      expect(result?.code).toBe('LOOKUP_OUTSIDE_THE_CLONE');
      expect(result?.severity).toBe('info');
      expect(result?.explanationKey).toBe('errors.lookupOutsideClone.explanation');
      expect(result?.actionKey).toBe('errors.lookupOutsideClone.action');
    }
  });

  it('explains an object the target describes but takes no insert of, skipped whole', () => {
    const result = forge('Object is not createable on target org');
    expect(result?.code).toBe('NOT_CREATEABLE_ON_TARGET');
    expect(result?.severity).toBe('warning');
    expect(result?.explanationKey).toBe('errors.notCreateable.explanation');
  });

  it('explains an object the target org does not have, or does not show the user the run writes as', () => {
    const result = forge(
      'Object is not in the target org, or the user the run writes as cannot see it: ' +
        'none of its records can be written there',
    );
    expect(result?.code).toBe('NOT_IN_TARGET_ORG');
    expect(result?.severity).toBe('error');
    expect(result?.explanationKey).toBe('errors.notInTarget.explanation');
  });

  it('translates Cycle FK with field name + source ref', () => {
    const result = forge(
      "Cycle FK 'PrimaryContactId' could not be resolved — referenced parent (source 003ABC123) was not cloned",
    );
    expect(result?.code).toBe('CYCLE_FK_UNRESOLVED');
    expect(result?.severity).toBe('warning');
    expect(result?.vars?.fieldName).toBe('PrimaryContactId');
    expect(result?.vars?.sourceRefId).toBe('003ABC123');
  });

  it('explains an object the run held back over a record type the running user cannot use', () => {
    const result = forge(
      'RECORD_TYPE_UNAVAILABLE: 2 Case records use record type Partner_Case (Partner Case), ' +
        'which the running user cannot use in the target org.',
    );
    expect(result?.code).toBe('RECORD_TYPE_UNAVAILABLE');
    expect(result?.severity).toBe('error');
    expect(result?.explanationKey).toBe('errors.recordTypeHeldBack.forge.explanation');
    expect(result?.actionKey).toBe('errors.recordTypeHeldBack.forge.action');
    // A code of SandForge's own: there is nothing to search Salesforce Help for.
    expect(result?.docUrl).toBeUndefined();
  });

  it('translates out-of-scope messages as info', () => {
    const result = forge('no parent in cache and not the root');
    expect(result?.code).toBe('OUT_OF_SCOPE');
    expect(result?.severity).toBe('info');
  });

  it('returns null when message has no recognizable format', () => {
    expect(forge('not a salesforce error')).toBeNull();
  });

  it.each(TEN_CODES)(
    'says what $code means and what to do about it, as a $severity, with its row in the guide',
    ({ raw, code, hint, severity }) => {
      expect(forge(raw)).toEqual({
        code,
        explanationKey: `errors.${hint}.forge.explanation`,
        actionKey: `errors.${hint}.forge.action`,
        vars: undefined,
        severity,
        docUrl: `${FORGE_GUIDE_URL}#${guideAnchorOf(code)}`,
        docKind: 'guide',
      });
    },
  );

  it('says an expired session is fixed by reconnecting the org, with its row in the guide', () => {
    expect(forge(SESSION_REFUSED)).toEqual({
      code: 'INVALID_SESSION_ID',
      explanationKey: 'errors.sessionExpired.explanation',
      actionKey: 'errors.sessionExpired.action',
      vars: undefined,
      severity: 'error',
      docUrl: `${FORGE_GUIDE_URL}#${guideAnchorOf('INVALID_SESSION_ID')}`,
      docKind: 'guide',
    });
  });

  it.each(REFUSALS)(
    'says what SandForge’s own $code refusal means by its code, whatever its message says',
    ({ message, code, hint, severity }) => {
      expect(forge(message)?.code).not.toBe(code);
      expect(forge(message, code)).toEqual({
        code,
        explanationKey: `errors.${hint}.explanation`,
        actionKey: `errors.${hint}.action`,
        severity,
      });
    },
  );

  it('reads the message as before when the code the error carries is not a refusal of its own', () => {
    // A run that failed once it had started is sent as EXECUTE_ERROR: what
    // stopped it is in its message.
    expect(forge(SESSION_REFUSED, 'EXECUTE_ERROR')).toEqual(forge(SESSION_REFUSED));
    expect(forge('not a salesforce error', 'EXECUTE_ERROR')).toBeNull();
  });

  it('leaves the run gate’s codes to the Review notice that says them', () => {
    for (const code of [
      'PRODUCTION_TARGET',
      'AUTOMATION_DECLINED',
      'READ_DECLINED',
      'WRITE_DECLINED',
      'STORAGE_EXCEEDED',
      'CONFIRMATION_UNAVAILABLE',
    ]) {
      expect(forge('Nothing was written.', code)).toBeNull();
    }
  });
});

describe('translateError in every other module', () => {
  it('words a code both Forge and the others meet in the shared wording, which names no clone', () => {
    const raw = 'DUPLICATE_VALUE: duplicate value found: ExternalId__c';
    expect(translateError(raw)).toEqual({
      code: 'DUPLICATE_VALUE',
      explanationKey: 'errors.duplicateValue.explanation',
      actionKey: 'errors.duplicateValue.action',
      vars: undefined,
      severity: 'warning',
      docUrl: helpSearchUrlOf('DUPLICATE_VALUE'),
      docKind: 'search',
    });
  });

  it('gives a seed what a seed does about it, under the shared explanation', () => {
    const result = translateError('REQUIRED_FIELD_MISSING: Required fields are missing: [Name]', {
      module: 'seed',
    });
    expect(result?.explanationKey).toBe('errors.requiredFieldMissing.explanation');
    expect(result?.actionKey).toBe('errors.requiredFieldMissing.seed.action');
    // The org's line is shown right above the hint: the shared wording does
    // not say it again, where Forge's names the fields in its sentence.
    expect(result?.vars).toBeUndefined();
    expect(
      translateError('REQUIRED_FIELD_MISSING: Required fields are missing: [Name]', {
        module: 'forge',
      })?.vars,
    ).toEqual({ detail: 'Required fields are missing: [Name]' });
  });

  it('falls back to the shared action for a code a seed has no wording of its own for', () => {
    const result = translateError('ENTITY_IS_LOCKED: entity is locked', { module: 'seed' });
    expect(result?.actionKey).toBe('errors.entityLocked.action');
  });

  it('keeps Forge’s refusals to Forge: another module’s panel words the guard itself', () => {
    expect(
      translateError('Operation blocked by Production Guard: delete', { code: 'GUARD_BLOCKED' }),
    ).toBeNull();
  });

  it('links a code it does not know to a search of Salesforce Help, and repeats nothing', () => {
    // The fallback was "{{detail}}": the raw line, said again under itself,
    // and an action telling the reader to look the code up, with no link.
    expect(translateError('SOMETHING_NEW: details about the new error')).toEqual({
      code: 'SOMETHING_NEW',
      severity: 'error',
      docUrl: helpSearchUrlOf('SOMETHING_NEW'),
      docKind: 'search',
    });
    expect(helpSearchUrlOf('SOMETHING_NEW')).toBe(
      'https://help.salesforce.com/s/search-result?language=en_US#q=SOMETHING_NEW',
    );
  });

  it('says nothing of a code that names no reason, which a search cannot answer', () => {
    expect(translateError('UNKNOWN_ERROR: No result returned for the record')).toBeNull();
  });

  it('reads the code the host sent before the message', () => {
    const result = translateError('FLS violation on Account: fields [Rating] are not updateable', {
      code: 'CRUD_FLS_DENIED',
    });
    expect(result?.explanationKey).toBe('errors.permissionDenied.explanation');
    // SandForge's own code: there is nothing of it in Salesforce Help.
    expect(result?.docUrl).toBeUndefined();
  });

  it('reads the message when the code the host sent is one it does not know', () => {
    expect(
      translateError('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.', { code: 'UNKNOWN' })
        ?.code,
    ).toBe('REQUEST_LIMIT_EXCEEDED');
    expect(translateError('Something broke', { code: 'SFDX_IMPORT_FAILED' })).toBeNull();
  });

  it('finds a code it knows after a sentence of SandForge’s own, as a connection failure says it', () => {
    const result = translateError(
      'Connection failed for "Dev": API_DISABLED_FOR_ORG: API is not enabled for this Organization or Partner',
    );
    expect(result?.code).toBe('API_DISABLED_FOR_ORG');
    expect(result?.explanationKey).toBe('errors.apiDisabledForOrg.explanation');
  });

  it('takes no word in capitals inside a sentence for a code it does not know', () => {
    expect(translateError('Pipeline did not start: SOME_STEP: is not allowed')).toBeNull();
  });

  it('explains the codes the connect flow meets: an edition without the API, a user without API Enabled', () => {
    expect(translateError('API_DISABLED_FOR_ORG: API is not enabled')?.actionKey).toBe(
      'errors.apiDisabledForOrg.action',
    );
    expect(translateError('API_CURRENTLY_DISABLED: API is disabled for this User')?.actionKey).toBe(
      'errors.apiDisabledForUser.action',
    );
  });

  it('explains every code the extension’s table answered, and the ones neither answered', () => {
    for (const code of [
      'DELETE_FAILED',
      'INVALID_EMAIL_ADDRESS',
      'SERVER_UNAVAILABLE',
      'REQUEST_RUNNING_TOO_LONG',
      'ALL_OR_NONE_OPERATION_ROLLED_BACK',
      'INVALID_FIELD',
      'LIMIT_EXCEEDED',
      'CIRCULAR_DEPENDENCY',
      'INVALID_OPERATION',
      'TRANSFER_REQUIRES_READ',
      'ENTITY_IS_LOCKED',
      'API_DISABLED_FOR_ORG',
      'API_CURRENTLY_DISABLED',
      'CANNOT_UPDATE_CONVERTED_LEAD',
      'LICENSE_LIMIT_EXCEEDED',
      'DUPLICATE_USERNAME',
      'ORG_AUTH_EXPIRED',
      'ORG_TEMPORARILY_UNREACHABLE',
      'NO_CLI_ORGS',
    ]) {
      expect({ code, known: isCataloguedErrorCode(code) }).toEqual({ code, known: true });
    }
    expect(isCataloguedErrorCode('constructor')).toBe(false);
  });

  it('explains Autopilot’s own reasons for holding a record back', () => {
    for (const code of [
      'PARENT_REFUSED',
      'PERSON_ACCOUNT_NOT_WRITTEN',
      'PERSON_CONTACT_NOT_LOOKED_UP',
    ]) {
      const hint = translateError(`${code}: held back`);
      expect(hint?.explanationKey).toMatch(/^errors\.\w+\.explanation$/);
      expect(hint?.docUrl).toBeUndefined();
    }
  });
});

describe('the connection errors a panel words by their code', () => {
  it('gives the keys the panel words an expired session, an unreachable org and an empty CLI with', () => {
    expect(panelWordingOf('ORG_AUTH_EXPIRED')).toEqual({
      explanationKey: 'errors.orgAuthExpired.explanation',
      actionKey: 'errors.orgAuthExpired.action',
    });
    expect(panelWordingOf('ORG_TEMPORARILY_UNREACHABLE')?.actionKey).toBe(
      'errors.orgTemporarilyUnreachable.action',
    );
    expect(panelWordingOf('NO_CLI_ORGS')?.explanationKey).toBe('errors.noCliOrgs.explanation');
    expect(panelWordingOf('DUPLICATE_VALUE')).toBeUndefined();
    expect(panelWordingOf(null)).toBeUndefined();
  });

  it('says no hint under a banner whose message the panel already worded by that code', () => {
    expect(bannerHintOf('The session with this org has expired.', 'ORG_AUTH_EXPIRED')).toBeNull();
    // Forge shows the host's message as it came: the hint says it there.
    expect(
      translateError('ORG_AUTH_EXPIRED: The session with "Dev" has expired', { module: 'forge' })
        ?.explanationKey,
    ).toBe('errors.orgAuthExpired.explanation');
  });

  it('says the hint of any other code under a banner', () => {
    expect(bannerHintOf('ENTITY_IS_LOCKED: entity is locked', 'UNKNOWN')?.code).toBe(
      'ENTITY_IS_LOCKED',
    );
  });
});

describe('the way from a Forge hint to the Forge guide', () => {
  it('links no guide row for a code the table has none for', () => {
    for (const raw of [
      'SOMETHING_NEW: details about the new error',
      'STRING_TOO_LONG: Name: data value too large',
      "INVALID_CROSS_REFERENCE_KEY: Record Type ID: this ID value isn't valid for the user",
      'Object is not createable on target org',
      "Cycle FK 'ParentId' could not be resolved",
    ]) {
      const result = forge(raw);
      expect(result).not.toBeNull();
      expect({ raw, kind: result?.docKind }).not.toEqual({ raw, kind: 'guide' });
    }
  });

  it('links the guide in no module but Forge, whose guide it is', () => {
    expect(translateError('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.')?.docKind).toBe(
      'search',
    );
  });

  it('names a row by the code, lower case and hyphenated, never by a heading', () => {
    expect(guideAnchorOf('INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY')).toBe(
      'error-insufficient-access-on-cross-reference-entity',
    );
  });
});

describe('cataloguedErrorCodes', () => {
  it('lists every code the catalogue answers, and only those', () => {
    const codes = cataloguedErrorCodes();
    expect(codes.length).toBeGreaterThanOrEqual(45);
    expect(codes.every(isCataloguedErrorCode)).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
