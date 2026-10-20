/**
 * The one catalogue of the errors SandForge explains: what a Salesforce status
 * code, or one of SandForge's own, means, and what to do next, as a pair of
 * i18n keys every module resolves in the interface language.
 *
 * There were three. The extension kept a table of 29 codes, in English,
 * behind a VS Code notification; Forge kept its own of other codes, in six
 * languages, under each error; the Seed results a third. They covered
 * different codes and gave conflicting advice for the same one —
 * DUPLICATE_VALUE was "use a unique value" in the notification and "delete
 * the records the earlier run created" under the error — and every module but
 * Forge showed the raw code and the org's English with no next step.
 *
 * A hint is worded for any module unless the module's own work changes what
 * to do: Forge clones source records, so its hints speak of the clone, of
 * Review's tabs and of retrying the failed objects; a seed generates every
 * value, so what it says to do is about the rules it generates them by. Those
 * two modules carry their own wording of the codes they differ on; every
 * other module reads the shared one.
 *
 * Every key is written out whole: the i18n sweep reports a key no source file
 * names, and a key assembled from a slug is one.
 */

/** How much an error costs the run, which tints its hint. */
export type ErrorHintSeverity = 'info' | 'warning' | 'error';

/** The modules whose work changes what a hint says to do. */
export type ErrorHintModule = 'forge' | 'seed';

/** What the catalogue makes of an error, ready for i18next's `t()`. */
export interface ErrorHint {
  /** The status code read, or a SandForge-specific one. */
  code: string;
  /** What the error means; absent for a code the catalogue does not know. */
  explanationKey?: string;
  /** What to do next; absent for a code the catalogue does not know. */
  actionKey?: string;
  /** The interpolation variables of the keys. */
  vars?: Record<string, string | number>;
  severity: ErrorHintSeverity;
  /** A page that says more: the Forge guide's row, or a search of Salesforce Help. */
  docUrl?: string;
  /** Which of the two `docUrl` is, which names its link. */
  docKind?: 'guide' | 'search';
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
 * Salesforce Help's search, which reads its query from the part after `#`.
 * A code the catalogue has no entry for is linked here rather than explained
 * by repeating the org's own words, which the page already shows.
 */
export const SALESFORCE_HELP_SEARCH_URL =
  'https://help.salesforce.com/s/search-result?language=en_US';

/** The search of Salesforce Help for one status code. */
export function helpSearchUrlOf(code: string): string {
  return `${SALESFORCE_HELP_SEARCH_URL}#q=${encodeURIComponent(code)}`;
}

/**
 * The codes the guide's table of common errors has a row for, each row under
 * an anchor of its own (`guideAnchorOf`). A Forge hint links its row; a code
 * with no row gets no guide link, never one to a row about something else.
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
  'INVALID_SESSION_ID',
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

/** The explanation and action keys of one wording of a hint. */
type HintKeys = readonly [explanationKey: string, actionKey: string];

/** One error the catalogue explains. */
interface Entry {
  severity: ErrorHintSeverity;
  /** The wording any module reads. */
  keys: HintKeys;
  /** Forge's own wording, where cloning a source record changes what to do. */
  forge?: HintKeys;
  /** What a seed does about it, the explanation being the shared one. */
  seedAction?: string;
  /**
   * Which explanations interpolate the detail the message gave after the
   * code: every wording, or Forge's alone.
   */
  detail?: 'all' | 'forge';
  /**
   * Whether the code is SandForge's own rather than the platform's: no search
   * of Salesforce Help is linked for it.
   */
  own?: true;
  /**
   * Whether a panel words the error with these keys in place of the host's
   * message (`panelWordingOf`): the hint would then say it a second time.
   */
  wordsTheMessage?: true;
}

/**
 * The errors the catalogue explains, by code. Message-specific wordings of a
 * code — a record type refused under INVALID_CROSS_REFERENCE_KEY, an object
 * that takes no insert under CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY — are in
 * {@link VARIANTS}.
 */
const CATALOGUE: Readonly<Record<string, Entry>> = {
  // Salesforce refuses a price in a custom price book until the product has
  // one in the standard book. Met against a real org, and the code on its own
  // says nothing about what to do next.
  STANDARD_PRICE_NOT_DEFINED: {
    severity: 'warning',
    keys: ['errors.standardPriceMissing.explanation', 'errors.standardPriceMissing.action'],
    forge: [
      'errors.standardPriceMissing.forge.explanation',
      'errors.standardPriceMissing.forge.action',
    ],
    seedAction: 'errors.standardPriceMissing.seed.action',
  },
  DUPLICATE_VALUE: {
    severity: 'warning',
    keys: ['errors.duplicateValue.explanation', 'errors.duplicateValue.action'],
    forge: ['errors.duplicateValue.forge.explanation', 'errors.duplicateValue.forge.action'],
    seedAction: 'errors.duplicateValue.seed.action',
  },
  INVALID_CROSS_REFERENCE_KEY: {
    severity: 'info',
    keys: ['errors.invalidCrossReferenceKey.explanation', 'errors.invalidCrossReferenceKey.action'],
    forge: [
      'errors.invalidCrossReferenceKey.forge.explanation',
      'errors.invalidCrossReferenceKey.forge.action',
    ],
  },
  // Not a platform code: a run's own, for an object it held back before
  // writing because the running user cannot use a record type its records
  // carry. The message names the type and the count; the hint says what
  // holding back cost and what to change.
  RECORD_TYPE_UNAVAILABLE: {
    severity: 'error',
    own: true,
    keys: ['errors.recordTypeHeldBack.explanation', 'errors.recordTypeHeldBack.action'],
    forge: [
      'errors.recordTypeHeldBack.forge.explanation',
      'errors.recordTypeHeldBack.forge.action',
    ],
  },
  REQUIRED_FIELD_MISSING: {
    severity: 'error',
    detail: 'forge',
    keys: ['errors.requiredFieldMissing.explanation', 'errors.requiredFieldMissing.action'],
    forge: [
      'errors.requiredFieldMissing.forge.explanation',
      'errors.requiredFieldMissing.forge.action',
    ],
    seedAction: 'errors.requiredFieldMissing.seed.action',
  },
  // A Forge refusal that names a field the row gives a value to has the row
  // written again without it, as a validation rule's does: a record type never
  // given values of a field takes none, which the check before the write
  // cannot read. What is left could not be.
  INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: {
    severity: 'warning',
    keys: ['errors.invalidPicklist.explanation', 'errors.invalidPicklist.action'],
    forge: ['errors.invalidPicklist.forge.explanation', 'errors.invalidPicklist.forge.action'],
    seedAction: 'errors.invalidPicklist.seed.action',
  },
  FIELD_CUSTOM_VALIDATION_EXCEPTION: {
    severity: 'warning',
    keys: ['errors.fieldCustomValidation.explanation', 'errors.fieldCustomValidation.action'],
    forge: [
      'errors.fieldCustomValidation.forge.explanation',
      'errors.fieldCustomValidation.forge.action',
    ],
    seedAction: 'errors.fieldCustomValidation.seed.action',
  },
  INVALID_FIELD_FOR_INSERT_UPDATE: {
    severity: 'error',
    keys: ['errors.invalidFieldForInsert.explanation', 'errors.invalidFieldForInsert.action'],
  },
  FIELD_INTEGRITY_EXCEPTION: {
    severity: 'error',
    detail: 'all',
    keys: ['errors.fieldIntegrity.explanation', 'errors.fieldIntegrity.action'],
  },
  // Every refusal under this code but an object that takes no insert (a
  // variant) is the org's own automation — a trigger, a Flow, a process —
  // failing on the record: told to leave the object out, the reader was sent
  // away from the one thing to fix.
  CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: {
    severity: 'error',
    keys: ['errors.automationRefused.explanation', 'errors.automationRefused.action'],
    forge: ['errors.automationRefused.forge.explanation', 'errors.automationRefused.forge.action'],
  },
  INSUFFICIENT_ACCESS_OR_READONLY: {
    severity: 'error',
    keys: ['errors.insufficientAccess.explanation', 'errors.insufficientAccess.action'],
  },
  INSUFFICIENT_ACCESS: {
    severity: 'error',
    keys: ['errors.insufficientAccess.explanation', 'errors.insufficientAccess.action'],
  },
  STORAGE_LIMIT_EXCEEDED: {
    severity: 'error',
    keys: ['errors.storageLimit.explanation', 'errors.storageLimit.action'],
    seedAction: 'errors.storageLimit.seed.action',
  },
  INVALID_TYPE: {
    severity: 'error',
    keys: ['errors.invalidType.explanation', 'errors.invalidType.action'],
    forge: ['errors.invalidType.forge.explanation', 'errors.invalidType.forge.action'],
  },
  NOT_FOUND: {
    severity: 'warning',
    keys: ['errors.notFound.explanation', 'errors.notFound.action'],
    forge: ['errors.notFound.forge.explanation', 'errors.notFound.forge.action'],
  },
  STRING_TOO_LONG: {
    severity: 'warning',
    detail: 'forge',
    keys: ['errors.stringTooLong.explanation', 'errors.stringTooLong.action'],
    forge: ['errors.stringTooLong.forge.explanation', 'errors.stringTooLong.forge.action'],
  },
  // A lookup the target lets be empty is written again by Forge without it,
  // as a validation rule's field is: what fails with it is a lookup the
  // target requires, or a row refused for something else as well.
  FIELD_FILTER_VALIDATION_EXCEPTION: {
    severity: 'warning',
    keys: ['errors.lookupFilter.explanation', 'errors.lookupFilter.action'],
    forge: ['errors.lookupFilter.forge.explanation', 'errors.lookupFilter.forge.action'],
  },
  // Every write sends the header that saves past a rule set to Allow: what
  // still comes back is a rule set to Block.
  DUPLICATES_DETECTED: {
    severity: 'warning',
    keys: ['errors.duplicateRule.explanation', 'errors.duplicateRule.action'],
    forge: ['errors.duplicateRule.forge.explanation', 'errors.duplicateRule.forge.action'],
    seedAction: 'errors.duplicateRule.seed.action',
  },
  // A Forge clone leaves OwnerId out unless an owner mapping sets it: the
  // inactive user comes from that mapping, or from the target's own
  // assignment rules and Flows.
  INACTIVE_OWNER_OR_USER: {
    severity: 'error',
    keys: ['errors.inactiveUser.explanation', 'errors.inactiveUser.action'],
    forge: ['errors.inactiveUser.forge.explanation', 'errors.inactiveUser.forge.action'],
  },
  ENTITY_IS_DELETED: {
    severity: 'warning',
    keys: ['errors.entityDeleted.explanation', 'errors.entityDeleted.action'],
    forge: ['errors.entityDeleted.forge.explanation', 'errors.entityDeleted.forge.action'],
  },
  // Another transaction held the row or its parent: the same write goes
  // through once it lets go.
  UNABLE_TO_LOCK_ROW: {
    severity: 'warning',
    keys: ['errors.rowLocked.explanation', 'errors.rowLocked.action'],
    forge: ['errors.rowLocked.forge.explanation', 'errors.rowLocked.forge.action'],
  },
  // Refused for the whole call, not for a row: every request after it is
  // refused alike until the org's count frees some.
  REQUEST_LIMIT_EXCEEDED: {
    severity: 'error',
    keys: ['errors.requestLimit.explanation', 'errors.requestLimit.action'],
    forge: ['errors.requestLimit.forge.explanation', 'errors.requestLimit.forge.action'],
  },
  // The session the extension holds for the org was refused: nothing the run
  // changes gets past it, and the org has to be connected again — by the
  // Reconnect button its card on Organizations carries.
  INVALID_SESSION_ID: {
    severity: 'error',
    keys: ['errors.sessionExpired.explanation', 'errors.sessionExpired.action'],
  },
  INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: {
    severity: 'error',
    keys: ['errors.crossReferenceAccess.explanation', 'errors.crossReferenceAccess.action'],
    forge: [
      'errors.crossReferenceAccess.forge.explanation',
      'errors.crossReferenceAccess.forge.action',
    ],
  },
  NUMBER_OUTSIDE_VALID_RANGE: {
    severity: 'warning',
    keys: ['errors.numberOutOfRange.explanation', 'errors.numberOutOfRange.action'],
    forge: ['errors.numberOutOfRange.forge.explanation', 'errors.numberOutOfRange.forge.action'],
  },
  MALFORMED_ID: {
    severity: 'error',
    keys: ['errors.malformedId.explanation', 'errors.malformedId.action'],
    forge: ['errors.malformedId.forge.explanation', 'errors.malformedId.forge.action'],
  },
  // A Flow of the org failing on save. One a sandbox often meets is a Send
  // Email action: with the org's deliverability at No access, the action
  // fails once it uses an email template or logs the email, and the save
  // fails with it (Salesforce Help, Send Email action).
  CANNOT_EXECUTE_FLOW_TRIGGER: {
    severity: 'error',
    keys: ['errors.flowFailed.explanation', 'errors.flowFailed.action'],
    forge: ['errors.flowFailed.forge.explanation', 'errors.flowFailed.forge.action'],
    seedAction: 'errors.flowFailed.seed.action',
  },
  // Every removal meets it: a record other records still point at, or one a
  // before-delete trigger or Flow refuses to let go.
  DELETE_FAILED: {
    severity: 'error',
    keys: ['errors.deleteFailed.explanation', 'errors.deleteFailed.action'],
  },
  INVALID_EMAIL_ADDRESS: {
    severity: 'warning',
    keys: ['errors.invalidEmail.explanation', 'errors.invalidEmail.action'],
  },
  SERVER_UNAVAILABLE: {
    severity: 'warning',
    keys: ['errors.serverUnavailable.explanation', 'errors.serverUnavailable.action'],
  },
  REQUEST_RUNNING_TOO_LONG: {
    severity: 'warning',
    keys: ['errors.requestTooLong.explanation', 'errors.requestTooLong.action'],
  },
  ALL_OR_NONE_OPERATION_ROLLED_BACK: {
    severity: 'warning',
    keys: ['errors.allOrNoneRolledBack.explanation', 'errors.allOrNoneRolledBack.action'],
  },
  INVALID_FIELD: {
    severity: 'error',
    keys: ['errors.invalidField.explanation', 'errors.invalidField.action'],
  },
  LIMIT_EXCEEDED: {
    severity: 'error',
    keys: ['errors.limitExceeded.explanation', 'errors.limitExceeded.action'],
  },
  CIRCULAR_DEPENDENCY: {
    severity: 'error',
    keys: ['errors.circularDependency.explanation', 'errors.circularDependency.action'],
  },
  // A record an approval process locked: a Sync or DataOps update of one is
  // refused, whatever the user's permissions on the object.
  ENTITY_IS_LOCKED: {
    severity: 'warning',
    keys: ['errors.entityLocked.explanation', 'errors.entityLocked.action'],
  },
  // An edition without the API (Professional or Essentials without the
  // add-on), or a user without API Enabled: met as soon as an org is
  // connected, and nothing SandForge does gets past it.
  API_DISABLED_FOR_ORG: {
    severity: 'error',
    keys: ['errors.apiDisabledForOrg.explanation', 'errors.apiDisabledForOrg.action'],
  },
  API_CURRENTLY_DISABLED: {
    severity: 'error',
    keys: ['errors.apiDisabledForUser.explanation', 'errors.apiDisabledForUser.action'],
  },
  CANNOT_UPDATE_CONVERTED_LEAD: {
    severity: 'warning',
    keys: ['errors.convertedLead.explanation', 'errors.convertedLead.action'],
  },
  LICENSE_LIMIT_EXCEEDED: {
    severity: 'error',
    keys: ['errors.licenseLimit.explanation', 'errors.licenseLimit.action'],
  },
  DUPLICATE_USERNAME: {
    severity: 'error',
    keys: ['errors.duplicateUsername.explanation', 'errors.duplicateUsername.action'],
  },
  INVALID_OPERATION: {
    severity: 'error',
    keys: ['errors.invalidOperation.explanation', 'errors.invalidOperation.action'],
  },
  TRANSFER_REQUIRES_READ: {
    severity: 'error',
    keys: ['errors.transferRequiresRead.explanation', 'errors.transferRequiresRead.action'],
  },
  // SandForge's own refusal of a write the connected user has no permission
  // for, on the object or on fields it writes — checked before the write.
  CRUD_FLS_DENIED: {
    severity: 'error',
    own: true,
    keys: ['errors.permissionDenied.explanation', 'errors.permissionDenied.action'],
  },
  // A record Autopilot held back because a record it names was refused in
  // the same run: the parent's refusal is the one to fix.
  PARENT_REFUSED: {
    severity: 'warning',
    own: true,
    keys: ['errors.parentRefused.explanation', 'errors.parentRefused.action'],
  },
  PERSON_ACCOUNT_NOT_WRITTEN: {
    severity: 'warning',
    own: true,
    keys: ['errors.personAccountNotWritten.explanation', 'errors.personAccountNotWritten.action'],
  },
  PERSON_CONTACT_NOT_LOOKED_UP: {
    severity: 'warning',
    own: true,
    keys: ['errors.personContactNotLookedUp.explanation', 'errors.personContactNotLookedUp.action'],
  },
  // A connection the user can act on, worded by the host in English with a
  // CLI command once: an expired session the CLI could not renew, or an org
  // that failed several times in a row and is left alone for a moment. The
  // panel words them in place of the host's message, and offers Reconnect.
  ORG_AUTH_EXPIRED: {
    severity: 'error',
    own: true,
    wordsTheMessage: true,
    keys: ['errors.orgAuthExpired.explanation', 'errors.orgAuthExpired.action'],
  },
  ORG_TEMPORARILY_UNREACHABLE: {
    severity: 'warning',
    own: true,
    wordsTheMessage: true,
    keys: [
      'errors.orgTemporarilyUnreachable.explanation',
      'errors.orgTemporarilyUnreachable.action',
    ],
  },
  // An import from the Salesforce CLI that found no org: Organizations opens
  // the browser sign-in on it.
  NO_CLI_ORGS: {
    severity: 'info',
    own: true,
    wordsTheMessage: true,
    keys: ['errors.noCliOrgs.explanation', 'errors.noCliOrgs.action'],
  },
};

/**
 * Wordings of a code that hold for one kind of message only, tried before the
 * code's own entry.
 */
const VARIANTS: ReadonlyArray<{
  code: string;
  match: RegExp;
  /** The code the hint is said under. */
  says: string;
  entry: Entry;
}> = [
  // One code, two very different situations. On a record type the mapping
  // is right and the org simply does not let the running user use it —
  // nothing about the data can fix that, and the platform's wording sends
  // people looking in the wrong place.
  {
    code: 'INVALID_CROSS_REFERENCE_KEY',
    match: /ecord ?[Tt]ype/,
    says: 'RECORD_TYPE_UNAVAILABLE',
    entry: {
      severity: 'warning',
      keys: ['errors.recordTypeUnavailable.explanation', 'errors.recordTypeUnavailable.action'],
      forge: [
        'errors.recordTypeUnavailable.forge.explanation',
        'errors.recordTypeUnavailable.forge.action',
      ],
    },
  },
  // An object that takes no insert answers "entity type cannot be inserted":
  // a history, audit or system object.
  {
    code: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
    match: /entity type cannot be inserted/i,
    says: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
    entry: {
      severity: 'info',
      keys: ['errors.cannotInsertEntity.explanation', 'errors.cannotInsertEntity.action'],
      forge: [
        'errors.cannotInsertEntity.forge.explanation',
        'errors.cannotInsertEntity.forge.action',
      ],
    },
  },
];

/**
 * Forge's own notes and refusals of objects, worded by the run with no code
 * in front: only Forge writes these messages.
 */
const FORGE_MESSAGES: ReadonlyArray<{
  match: RegExp;
  build: (captures: RegExpMatchArray) => ErrorHint;
}> = [
  // A lookup the second pass reports points at a record the run did not
  // write — it failed, or its object failed, was skipped or cannot be written
  // to the target — which a retry writes and links. Raising the depth, as the
  // hint once said, reaches no record already in the clone.
  {
    match: /Cycle FK '([^']+)'.*?source ([0-9A-Za-z]+)/,
    build: (m) => ({
      code: 'CYCLE_FK_UNRESOLVED',
      explanationKey: 'errors.cycleFkUnresolved.explanation',
      actionKey: 'errors.cycleFkUnresolved.action',
      vars: { fieldName: m[1], sourceRefId: m[2] },
      severity: 'warning',
    }),
  },
  {
    match: /Cycle FK '([^']+)' could not be resolved/,
    build: (m) => ({
      code: 'CYCLE_FK_UNRESOLVED',
      explanationKey: 'errors.cycleFkUnresolved.explanation',
      actionKey: 'errors.cycleFkUnresolved.action',
      vars: { fieldName: m[1], sourceRefId: '' },
      severity: 'warning',
    }),
  },
  {
    match: /no parent in cache and not the root/,
    build: () => ({
      code: 'OUT_OF_SCOPE',
      explanationKey: 'errors.outOfScope.explanation',
      actionKey: 'errors.outOfScope.action',
      severity: 'info',
    }),
  },
  // A lookup a row may leave empty, at a record no read of the run took.
  // Owed to the second pass, such a lookup was reported as a cycle's that
  // could not be resolved, and counted as failed, in a run that lost no
  // record.
  {
    match: /^Written with the lookup empty: the (?:\w+ )?record it points at is not in the clone/,
    build: () => ({
      code: 'LOOKUP_OUTSIDE_THE_CLONE',
      explanationKey: 'errors.lookupOutsideClone.explanation',
      actionKey: 'errors.lookupOutsideClone.action',
      severity: 'info',
    }),
  },
  // An object whose describe of the target answered NOT_FOUND, as it does for
  // one the user the run writes as cannot see, skipped whole before anything
  // of it was read.
  {
    match: /^Object is not in the target org, or the user the run writes as cannot see it/,
    build: () => ({
      code: 'NOT_IN_TARGET_ORG',
      explanationKey: 'errors.notInTarget.explanation',
      actionKey: 'errors.notInTarget.action',
      severity: 'error',
    }),
  },
  // An object the target describes but takes no insert of, skipped whole by
  // the check before the node loop.
  {
    match: /^Object is not createable on target org/,
    build: () => ({
      code: 'NOT_CREATEABLE_ON_TARGET',
      explanationKey: 'errors.notCreateable.explanation',
      actionKey: 'errors.notCreateable.action',
      severity: 'warning',
    }),
  },
];

/**
 * Forge's refusals of a run before it wrote anything, by the code the
 * extension sends beside the message. Their messages are English sentences
 * with no code in front — "Operation blocked by Production Guard: …",
 * "Another Forge run is still under way…" — and their next step is on
 * Forge's Review. The other modules' panels word the guard's refusals in
 * place of the message (`useMessageResponse`).
 *
 * The run gate's own codes are not here: an error that carries one takes
 * Forge back to Review, whose notice says each by its code.
 */
const FORGE_REFUSALS: Readonly<Record<string, { keys: HintKeys; severity: ErrorHintSeverity }>> = {
  GUARD_BLOCKED: {
    keys: ['errors.guardBlocked.explanation', 'errors.guardBlocked.action'],
    severity: 'error',
  },
  GUARD_DECLINED: {
    keys: ['errors.guardDeclined.explanation', 'errors.guardDeclined.action'],
    severity: 'info',
  },
  NOT_INITIALIZED: {
    keys: ['errors.notInitialized.explanation', 'errors.notInitialized.action'],
    severity: 'error',
  },
  FORGE_RUNNING: {
    keys: ['errors.forgeRunning.explanation', 'errors.forgeRunning.action'],
    severity: 'warning',
  },
  DUPLICATE: {
    keys: ['errors.duplicateRun.explanation', 'errors.duplicateRun.action'],
    severity: 'warning',
  },
  RETRY_UNAVAILABLE: {
    keys: ['errors.retryUnavailable.explanation', 'errors.retryUnavailable.action'],
    severity: 'warning',
  },
  // A run that could not be taken up where it stopped: nothing was written.
  RESUME_UNAVAILABLE: {
    keys: ['errors.resumeUnavailable.explanation', 'errors.resumeUnavailable.action'],
    severity: 'warning',
  },
  RESUME_TARGET_CHANGED: {
    keys: ['errors.resumeTargetChanged.explanation', 'errors.resumeTargetChanged.action'],
    severity: 'warning',
  },
  RESUME_CHANGED: {
    keys: ['errors.resumeChanged.explanation', 'errors.resumeChanged.action'],
    severity: 'warning',
  },
  FILES_NOT_ACCEPTED: {
    keys: ['errors.filesNotAccepted.explanation', 'errors.filesNotAccepted.action'],
    severity: 'warning',
  },
  // Not a failure: the user's own Abort, which came before the run started.
  ABORTED_BEFORE_START: {
    keys: ['errors.abortedBeforeStart.explanation', 'errors.abortedBeforeStart.action'],
    severity: 'info',
  },
};

/**
 * Codes that name no reason at all — a record the platform gave no result
 * for, a handler's fallback — which a search of Salesforce Help cannot answer.
 */
const NO_REASON_CODES: ReadonlySet<string> = new Set(['UNKNOWN', 'UNKNOWN_ERROR']);

/** A status code: SCREAMING_SNAKE with at least one underscore. */
const STATUS_CODE = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+';

/** `CODE: detail` at the start of a message, the detail up to its first full stop. */
const LEADING_CODE = new RegExp(`^(${STATUS_CODE}):\\s*(.*?)(?:\\.|$)`);

/**
 * A code after a sentence of SandForge's own: `Connection failed for "Dev":
 * API_DISABLED_FOR_ORG: API is not enabled…`. Read for a code the catalogue
 * knows only, so a word in capitals inside a message is not taken for one.
 */
const INNER_CODE = new RegExp(`: (${STATUS_CODE}):\\s*(.*?)(?:\\.|$)`);

/** The entry of a code, read as an own property: `constructor` is not a code. */
function entryOf(code: string): Entry | undefined {
  return Object.prototype.hasOwnProperty.call(CATALOGUE, code) ? CATALOGUE[code] : undefined;
}

/** Whether the catalogue explains `code`. */
export function isCataloguedErrorCode(code: string): boolean {
  return entryOf(code) !== undefined;
}

/** Every code the catalogue explains, message variants aside. */
export function cataloguedErrorCodes(): string[] {
  return Object.keys(CATALOGUE);
}

/**
 * The hint of one entry, in the module's wording.
 *
 * @param code - The code the hint is said under.
 * @param detail - What the message said after the code, for the entries that interpolate it.
 */
function hintOf(
  code: string,
  entry: Entry,
  module: ErrorHintModule | undefined,
  detail: string,
): ErrorHint {
  const forgeWording = module === 'forge' && entry.forge !== undefined;
  const [explanationKey, actionKey] =
    forgeWording && entry.forge
      ? entry.forge
      : module === 'seed' && entry.seedAction
        ? [entry.keys[0], entry.seedAction]
        : entry.keys;
  const saysDetail = entry.detail === 'all' || (entry.detail === 'forge' && forgeWording);
  return {
    code,
    explanationKey,
    actionKey,
    vars: saysDetail ? { detail: detail || code } : undefined,
    severity: entry.severity,
    ...docOf(code, entry, module),
  };
}

/** Where a hint links: Forge's guide row, a search of Salesforce Help, or nowhere. */
function docOf(
  code: string,
  entry: Entry | undefined,
  module: ErrorHintModule | undefined,
): Pick<ErrorHint, 'docUrl' | 'docKind'> {
  if (module === 'forge' && CODES_IN_THE_GUIDE.has(code)) {
    return { docUrl: `${FORGE_GUIDE_URL}#${guideAnchorOf(code)}`, docKind: 'guide' };
  }
  if (entry?.own || NO_REASON_CODES.has(code)) return {};
  return { docUrl: helpSearchUrlOf(code), docKind: 'search' };
}

/** The hint of a code read in a message, its message variants tried first. */
function hintOfCodeIn(
  code: string,
  detail: string,
  raw: string,
  module: ErrorHintModule | undefined,
): ErrorHint | null {
  const variant = VARIANTS.find((v) => v.code === code && v.match.test(raw));
  if (variant) return hintOf(variant.says, variant.entry, module, detail);
  const entry = entryOf(code);
  return entry ? hintOf(code, entry, module, detail) : null;
}

/** What {@link translateError} is told beside the message. */
export interface TranslateErrorOptions {
  /**
   * The code the host sent beside the message, when it sent one: a code the
   * catalogue knows is explained whatever the message says. A code of
   * SandForge's own it does not know falls back to the message.
   */
  code?: string | null;
  /** The module the error is shown in, whose wording a hint takes. */
  module?: ErrorHintModule;
}

/**
 * What an error means and what to do next, or `null` when nothing in it is
 * known. Read in order: the code the host sent beside it; Forge's own
 * refusals and notes; a status code in front of the message; a code the
 * catalogue knows after a sentence of SandForge's own. A status code in front
 * that the catalogue does not know is linked to a search of Salesforce Help,
 * with nothing said that the message does not already say.
 *
 * @param raw - The message as the page shows it.
 */
export function translateError(raw: string, options: TranslateErrorOptions = {}): ErrorHint | null {
  const { code, module } = options;
  const trimmed = raw.trim();
  if (code) {
    if (module === 'forge' && Object.prototype.hasOwnProperty.call(FORGE_REFUSALS, code)) {
      const refusal = FORGE_REFUSALS[code];
      const [explanationKey, actionKey] = refusal.keys;
      return { code, explanationKey, actionKey, severity: refusal.severity };
    }
    const sent = hintOfCodeIn(code, LEADING_CODE.exec(trimmed)?.[2] ?? '', trimmed, module);
    if (sent) return sent;
  }
  if (!trimmed) return null;
  for (const rule of FORGE_MESSAGES) {
    const m = trimmed.match(rule.match);
    if (m) return rule.build(m);
  }
  const leading = LEADING_CODE.exec(trimmed);
  if (leading) {
    const [, found, detail] = leading;
    const known = hintOfCodeIn(found, detail, trimmed, module);
    if (known) return known;
    if (NO_REASON_CODES.has(found)) return null;
    return { code: found, severity: 'error', ...docOf(found, undefined, module) };
  }
  const inner = INNER_CODE.exec(trimmed);
  if (inner) return hintOfCodeIn(inner[1], inner[2], trimmed, module);
  return null;
}

/**
 * The keys a panel words an error with in place of the host's message, for
 * the codes whose host message is English with a command line in it, or
 * `undefined`. The panel shows the explanation and the action as one text,
 * and a banner then says no hint under it.
 */
export function panelWordingOf(
  code: string | null | undefined,
): { explanationKey: string; actionKey: string } | undefined {
  const entry = code ? entryOf(code) : undefined;
  if (!entry?.wordsTheMessage) return undefined;
  const [explanationKey, actionKey] = entry.keys;
  return { explanationKey, actionKey };
}

/**
 * The hint a banner shows under a message, or `null`: none for an error the
 * panel already words by its code (`panelWordingOf`), which would say it twice.
 */
export function bannerHintOf(
  message: string,
  code: string | null | undefined,
  module?: ErrorHintModule,
): ErrorHint | null {
  if (panelWordingOf(code)) return null;
  return translateError(message, { code, module });
}
