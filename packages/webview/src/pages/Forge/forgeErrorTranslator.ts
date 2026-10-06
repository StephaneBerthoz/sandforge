/**
 * Translates raw Salesforce API error messages from ForgeExecutionError
 * samples into a structured pair of i18n keys plus optional interpolation
 * variables. The wizard component is responsible for resolving the keys
 * via `t()` so locale changes don't require touching the translator.
 *
 * Returns `null` when no rule matches — the caller falls back to the raw
 * message in that case.
 */

/** Structured translation result, ready to feed into i18next `t()`. */
export interface TranslatedError {
  /** STATUS_CODE detected (or a SandForge-specific synthetic code). */
  code: string;
  /** i18n key for the human-readable explanation. */
  explanationKey: string;
  /** i18n key for the suggested next step. */
  actionKey: string;
  /** Optional interpolation variables for the explanation key. */
  vars?: Record<string, string | number>;
  /** Severity hint for the UI badge. */
  severity: 'info' | 'warning' | 'error';
  /**
   * The row of the Forge guide's table of common errors that explains the
   * code, when the table has one.
   */
  docUrl?: string;
}

/**
 * The Forge guide, at the address the Marketplace README links it by: the
 * public-links check fetches that address anonymously before every release,
 * as a reader would. The anchor after it is read by the browser alone, and
 * never reaches the server.
 */
export const FORGE_GUIDE_URL =
  'https://github.com/StephaneBerthoz/sandforge/blob/master/docs/forge-quickstart.md';

/**
 * The codes the guide's table of common errors has a row for, each row under
 * an anchor of its own (`guideAnchorOf`). The Errors panel and the execution
 * screen link a hint to its row; a code with no row gets no link, never one
 * to a row about something else.
 */
const CODES_IN_THE_GUIDE: ReadonlySet<string> = new Set([
  'DUPLICATE_VALUE',
  'INVALID_CROSS_REFERENCE_KEY',
  'REQUIRED_FIELD_MISSING',
  'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
  'FIELD_CUSTOM_VALIDATION_EXCEPTION',
  'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
  'FIELD_INTEGRITY_EXCEPTION',
  'FIELD_FILTER_VALIDATION_EXCEPTION',
  'DUPLICATES_DETECTED',
  'INACTIVE_OWNER_OR_USER',
  'ENTITY_IS_DELETED',
  'UNABLE_TO_LOCK_ROW',
  'REQUEST_LIMIT_EXCEEDED',
  'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
  'NUMBER_OUTSIDE_VALID_RANGE',
  'MALFORMED_ID',
  'CANNOT_EXECUTE_FLOW_TRIGGER',
]);

/**
 * The anchor of a code's row in the guide's table: the code in lower case,
 * hyphenated, after `error-` — never a heading's slug, which a renamed
 * heading would change.
 */
export function guideAnchorOf(code: string): string {
  return `error-${code.toLowerCase().replace(/_/g, '-')}`;
}

interface Rule {
  /** Pattern matched against the raw message. */
  match: RegExp;
  build: (raw: string, captures: RegExpMatchArray) => TranslatedError;
}

/**
 * The explanation and action keys of one hint. Both are written out whole:
 * ForgeResults resolves them through a variable, so a key assembled from a
 * slug is one no source file names, and the i18n sweep reports it unused.
 */
type HintKeys = readonly [explanationKey: string, actionKey: string];

const RULES: Rule[] = [
  {
    match: /^([A-Z_]+):\s*(.*?)(?:\.|$)/,
    build: (raw, m) => {
      const code = m[1];
      const detail = m[2];
      switch (code) {
        // Salesforce refuses a price in a custom price book until the product
        // has one in the standard book. Met against a real org, and the code
        // on its own says nothing about what to do next.
        case 'STANDARD_PRICE_NOT_DEFINED':
          return mapping(
            [
              'forge.error.standardPriceMissing.explanation',
              'forge.error.standardPriceMissing.action',
            ],
            code,
            'warning',
          );
        case 'DUPLICATE_VALUE':
          return mapping(
            ['forge.error.duplicateValue.explanation', 'forge.error.duplicateValue.action'],
            code,
            'warning',
          );
        case 'INVALID_CROSS_REFERENCE_KEY':
          // One code, two very different situations. On a record type the
          // mapping is right and the target org simply does not let the
          // running user use it — nothing about the clone can fix that, and
          // the platform's wording sends people looking in the wrong place.
          return /ecord ?[Tt]ype/.test(raw)
            ? mapping(
                [
                  'forge.error.recordTypeUnavailable.explanation',
                  'forge.error.recordTypeUnavailable.action',
                ],
                'RECORD_TYPE_UNAVAILABLE',
                'warning',
              )
            : mapping(
                [
                  'forge.error.invalidCrossReferenceKey.explanation',
                  'forge.error.invalidCrossReferenceKey.action',
                ],
                code,
                'info',
              );
        // Not a platform code: the run's own, for an object it held back
        // before writing because the running user cannot use a record type
        // its records carry. The message names the type and the count; the
        // hint says what holding back cost and what to change.
        case 'RECORD_TYPE_UNAVAILABLE':
          return mapping(
            ['forge.error.recordTypeHeldBack.explanation', 'forge.error.recordTypeHeldBack.action'],
            code,
            'error',
          );
        case 'REQUIRED_FIELD_MISSING':
          return mapping(
            [
              'forge.error.requiredFieldMissing.explanation',
              'forge.error.requiredFieldMissing.action',
            ],
            code,
            'error',
            { detail },
          );
        // A refusal that names a field the row gives a value to has the row
        // written again without it, as a validation rule's does: a record
        // type never given values of a field takes none, which the check
        // before the write cannot read. What is left here could not be.
        case 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST':
          return mapping(
            ['forge.error.invalidPicklist.explanation', 'forge.error.invalidPicklist.action'],
            code,
            'warning',
          );
        // A rule that names a field the row gives a value to has the row
        // written again without it; what is left here could not be.
        case 'FIELD_CUSTOM_VALIDATION_EXCEPTION':
          return mapping(
            [
              'forge.error.fieldCustomValidation.explanation',
              'forge.error.fieldCustomValidation.action',
            ],
            code,
            'warning',
          );
        case 'INVALID_FIELD_FOR_INSERT_UPDATE':
          return mapping(
            [
              'forge.error.invalidFieldForInsert.explanation',
              'forge.error.invalidFieldForInsert.action',
            ],
            code,
            'error',
          );
        case 'FIELD_INTEGRITY_EXCEPTION':
          return mapping(
            ['forge.error.fieldIntegrity.explanation', 'forge.error.fieldIntegrity.action'],
            code,
            'error',
            { detail },
          );
        // One code, two causes. An object that takes no insert answers it
        // with "entity type cannot be inserted", which a run meets only when
        // the target's describe failed: one the describe says takes no new
        // record is skipped before its write. Every other refusal under this
        // code is the target's own automation — a trigger, a flow, a process
        // — failing on the record, and told to leave the object out, the
        // reader was sent away from the one thing to fix.
        case 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY':
          return /entity type cannot be inserted/i.test(raw)
            ? mapping(
                [
                  'forge.error.cannotInsertEntity.explanation',
                  'forge.error.cannotInsertEntity.action',
                ],
                code,
                'info',
              )
            : mapping(
                [
                  'forge.error.automationRefused.explanation',
                  'forge.error.automationRefused.action',
                ],
                code,
                'error',
              );
        case 'INSUFFICIENT_ACCESS_OR_READONLY':
        case 'INSUFFICIENT_ACCESS':
          return mapping(
            ['forge.error.insufficientAccess.explanation', 'forge.error.insufficientAccess.action'],
            code,
            'error',
          );
        case 'STORAGE_LIMIT_EXCEEDED':
          return mapping(
            ['forge.error.storageLimit.explanation', 'forge.error.storageLimit.action'],
            code,
            'error',
          );
        case 'INVALID_TYPE':
          return mapping(
            ['forge.error.invalidType.explanation', 'forge.error.invalidType.action'],
            code,
            'error',
          );
        case 'NOT_FOUND':
          return mapping(
            ['forge.error.notFound.explanation', 'forge.error.notFound.action'],
            code,
            'warning',
          );
        case 'STRING_TOO_LONG':
          return mapping(
            ['forge.error.stringTooLong.explanation', 'forge.error.stringTooLong.action'],
            code,
            'warning',
            { detail },
          );
        // A lookup the target lets be empty is written again without it, as a
        // validation rule's field is: what fails with it is a lookup the
        // target requires — left out, the row would be refused for want of
        // it — or a row refused for something else as well.
        case 'FIELD_FILTER_VALIDATION_EXCEPTION':
          return mapping(
            ['forge.error.lookupFilter.explanation', 'forge.error.lookupFilter.action'],
            code,
            'warning',
          );
        // Every write sends the header that saves past a rule set to Allow,
        // and a row refused by one that names a single record of its object
        // is linked to that record. What still comes back is a rule set to
        // Block that named none, or several.
        case 'DUPLICATES_DETECTED':
          return mapping(
            ['forge.error.duplicateRule.explanation', 'forge.error.duplicateRule.action'],
            code,
            'warning',
          );
        // The clone leaves OwnerId out unless an owner mapping sets it
        // (`--owner-map`): the inactive user comes from that mapping, or from
        // the target's own assignment rules and Flows.
        case 'INACTIVE_OWNER_OR_USER':
          return mapping(
            ['forge.error.inactiveUser.explanation', 'forge.error.inactiveUser.action'],
            code,
            'error',
          );
        case 'ENTITY_IS_DELETED':
          return mapping(
            ['forge.error.entityDeleted.explanation', 'forge.error.entityDeleted.action'],
            code,
            'warning',
          );
        // Another transaction held the row or its parent: the same write goes
        // through once it lets go.
        case 'UNABLE_TO_LOCK_ROW':
          return mapping(
            ['forge.error.rowLocked.explanation', 'forge.error.rowLocked.action'],
            code,
            'warning',
          );
        // Refused for the whole call, not for a row: every row of the call
        // fails with it, and every request after it is refused alike until
        // the org's count frees some.
        case 'REQUEST_LIMIT_EXCEEDED':
          return mapping(
            ['forge.error.requestLimit.explanation', 'forge.error.requestLimit.action'],
            code,
            'error',
          );
        case 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY':
          return mapping(
            [
              'forge.error.crossReferenceAccess.explanation',
              'forge.error.crossReferenceAccess.action',
            ],
            code,
            'error',
          );
        case 'NUMBER_OUTSIDE_VALID_RANGE':
          return mapping(
            ['forge.error.numberOutOfRange.explanation', 'forge.error.numberOutOfRange.action'],
            code,
            'warning',
          );
        case 'MALFORMED_ID':
          return mapping(
            ['forge.error.malformedId.explanation', 'forge.error.malformedId.action'],
            code,
            'error',
          );
        // A Flow of the target failing on save. One a sandbox often meets is
        // a Send Email action: with the org's deliverability at No access, the
        // action fails once it uses an email template or logs the email, and
        // the save fails with it (Salesforce Help, Send Email action).
        case 'CANNOT_EXECUTE_FLOW_TRIGGER':
          return mapping(
            ['forge.error.flowFailed.explanation', 'forge.error.flowFailed.action'],
            code,
            'error',
          );
        default:
          return {
            code,
            explanationKey: 'forge.error.unknown.explanation',
            actionKey: 'forge.error.unknown.action',
            vars: { detail: detail || code },
            severity: 'error',
          };
      }
    },
  },
  // A lookup at a record outside the clone is a note of its own (below): one
  // the second pass reports points at a record the run did not write — it
  // failed, or its object failed, was skipped or cannot be written to the
  // target — which a retry writes and links. Raising the depth, as the hint
  // said, reaches no record already in the clone.
  {
    match: /Cycle FK '([^']+)'.*?source ([0-9A-Za-z]+)/,
    build: (_raw, m) => ({
      code: 'CYCLE_FK_UNRESOLVED',
      explanationKey: 'forge.error.cycleFkUnresolved.explanation',
      actionKey: 'forge.error.cycleFkUnresolved.action',
      vars: { fieldName: m[1], sourceRefId: m[2] },
      severity: 'warning',
    }),
  },
  {
    match: /Cycle FK '([^']+)' could not be resolved/,
    build: (_raw, m) => ({
      code: 'CYCLE_FK_UNRESOLVED',
      explanationKey: 'forge.error.cycleFkUnresolved.explanation',
      actionKey: 'forge.error.cycleFkUnresolved.action',
      vars: { fieldName: m[1], sourceRefId: '' },
      severity: 'warning',
    }),
  },
  {
    match: /no parent in cache and not the root/,
    build: () => ({
      code: 'OUT_OF_SCOPE',
      explanationKey: 'forge.error.outOfScope.explanation',
      actionKey: 'forge.error.outOfScope.action',
      severity: 'info',
    }),
  },
  // The run's own note, not the platform's: a lookup a row may leave empty, at
  // a record no read of the run took, the object pointed at named when the
  // run can tell it. Owed to the second pass, such a lookup was reported as a
  // cycle's that could not be resolved, and counted as failed, in a run that
  // lost no record.
  {
    match: /^Written with the lookup empty: the (?:\w+ )?record it points at is not in the clone/,
    build: () =>
      mapping(
        ['forge.error.lookupOutsideClone.explanation', 'forge.error.lookupOutsideClone.action'],
        'LOOKUP_OUTSIDE_THE_CLONE',
        'info',
      ),
  },
  // The run's own as well: an object whose describe of the target answered
  // NOT_FOUND, as it does for one the user the run writes as cannot see,
  // skipped whole before anything of it was read.
  {
    match: /^Object is not in the target org, or the user the run writes as cannot see it/,
    build: () =>
      mapping(
        ['forge.error.notInTarget.explanation', 'forge.error.notInTarget.action'],
        'NOT_IN_TARGET_ORG',
        'error',
      ),
  },
  // And an object the target describes but takes no insert of — a history or
  // system object, or one the user the run writes as may not create — skipped
  // whole by the check before the node loop: it had no explanation, where the
  // objects the target lacks have one.
  {
    match: /^Object is not createable on target org/,
    build: () =>
      mapping(
        ['forge.error.notCreateable.explanation', 'forge.error.notCreateable.action'],
        'NOT_CREATEABLE_ON_TARGET',
        'warning',
      ),
  },
];

function mapping(
  [explanationKey, actionKey]: HintKeys,
  code: string,
  severity: 'info' | 'warning' | 'error',
  vars?: Record<string, string | number>,
): TranslatedError {
  return {
    code,
    explanationKey,
    actionKey,
    vars,
    severity,
    ...(CODES_IN_THE_GUIDE.has(code)
      ? { docUrl: `${FORGE_GUIDE_URL}#${guideAnchorOf(code)}` }
      : {}),
  };
}

/**
 * Translate a raw error message into structured i18n keys. Returns `null`
 * when no rule matches.
 */
export function translateForgeError(raw: string): TranslatedError | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  for (const rule of RULES) {
    const m = trimmed.match(rule.match);
    if (m) {
      return rule.build(trimmed, m);
    }
  }
  return null;
}
