/** A `frozen:*:error` payload: the host's English, its code, and what it names beside them. */
export interface FrozenErrorPayload {
  message?: string;
  code?: string;
  /** The rules file the extraction looked for, with `RULES_MISSING`. */
  rulesPath?: unknown;
  /** The entry guard that refused a load, with `GUARD_REFUSED`. */
  guard?: unknown;
  /** The org that guard refused. */
  orgId?: unknown;
  /** The records a selection measured, with `BUDGET_EXCEEDED`. */
  total?: unknown;
  /** The budget they went past. */
  budgetMax?: unknown;
  /** The heaviest objects, each with its count, named as the host names them. */
  heaviest?: unknown;
  /** What the configuration has to declare for a load, as the host says each, with `LOAD_CONFIG`. */
  gaps?: unknown;
  /** The records a removal left of the last load, with `LOAD_REMOVED`. */
  left?: unknown;
  /** The records a load stopped had written, with `LOAD_CANCELLED`. */
  written?: unknown;
  /** The sas a verification read, with `SAS_CHANGED`. */
  sasDir?: unknown;
  /** The sas the last load wrote to. */
  loadSas?: unknown;
  /** Whether `sasDir` names another sas than the load's. */
  sasMoved?: unknown;
  /** Whether the load's sas still holds its counting contract. */
  contractThere?: unknown;
  /** Production Guard's decision, with `GUARD_REFUSED` and the guard `guard-refused`. */
  decision?: unknown;
  /** Why it refused, in the user's words. */
  reason?: unknown;
  /** The record types a load could not tell apart, with `LOAD_CONFIG`. */
  recordTypesUntold?: unknown;
  /** What a load's gate found of the emails, with `EMAILS_NOT_ACCEPTED` and `FROZEN_EMAILS_EXCEEDED`. */
  emails?: unknown;
  /** What a load's question found the target runs as it writes, with `AUTOMATION_NOT_ACCEPTED`. */
  automation?: unknown;
}

/** Whether a value is a list of words the host sent. */
function isWords(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((word) => typeof word === 'string');
}

/**
 * A Frozen error the page words itself, in the interface language, or
 * `undefined` to show the host's message: what stops a first run — no
 * configuration saved (`CONFIG_MISSING`), no rules file where the extraction
 * reads it (`RULES_MISSING`), a load refused because its target is the org the
 * dataset was extracted from (`GUARD_REFUSED`, guard `source-is-target`) — one
 * refused for the checkpoint it was to take first (`CHECKPOINT_REFUSED`), and
 * every other refusal SandForge itself makes, each named by its code.
 *
 * The host words them in English for its log and the command line. Shown as
 * they were, a first-time user read "frozen:config:save: coverage axes, …"
 * before saving, "it is the source of truth (object.field → generator)" with
 * no rules file, and "manifest source.orgId" on the first load the Load tab
 * offered, in every locale. Each now says what to click.
 *
 * So are a load the user stopped (`LOAD_CANCELLED`), a verification of a sas
 * moved or emptied since the load (`SAS_CHANGED`), Production Guard's answer
 * to a load, and a removal a card read before another one met
 * (`ALREADY_REMOVED`, `NOTHING_TO_REMOVE`): each showed the host's English in
 * every locale.
 *
 * What stays in the host's words is what is not SandForge's to say: a step
 * that failed (`LOAD_ERROR`, `EXTRACT_ERROR`, …) carries what the org or the
 * disk answered. A refusal that names too little to be said is left there too.
 *
 * @param t - Translates a key in the interface language.
 * @param aliasOf - The name the panel gives an org, by its registered id.
 */
export function frozenErrorWords(
  payload: FrozenErrorPayload | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
  aliasOf: (orgId: string) => string,
): string | undefined {
  switch (payload?.code) {
    case 'CONFIG_MISSING':
      return `${t('frozen.refusal.configMissing.explanation')} ${t('frozen.refusal.configMissing.action')}`;
    case 'RULES_MISSING':
      return typeof payload.rulesPath === 'string'
        ? `${t('frozen.refusal.rulesMissing.explanation', { path: payload.rulesPath })} ${t(
            'frozen.refusal.rulesMissing.action',
          )}`
        : undefined;
    case 'CHECKPOINT_REFUSED':
      // The load's error names no reason of the take: its log does.
      return `${t('frozen.refusal.checkpointRefused.explanation')} ${t(
        'frozen.refusal.checkpointRefused.action',
      )}`;
    case 'GUARD_REFUSED':
      return guardWords(payload, t, aliasOf);
    case 'SELECTION_MISSING':
      return `${t('frozen.refusal.selectionMissing.explanation')} ${t('frozen.refusal.selectionMissing.action')}`;
    case 'SELECTION_EMPTY':
      return `${t('frozen.refusal.selectionEmpty.explanation')} ${t('frozen.refusal.selectionEmpty.action')}`;
    case 'CONTROL_FAILED':
      return `${t('frozen.refusal.controlFailed.explanation')} ${t('frozen.refusal.controlFailed.action')}`;
    case 'SALT_MISSING':
      return `${t('frozen.refusal.saltMissing.explanation')} ${t('frozen.refusal.saltMissing.action')}`;
    case 'SAS_PATH_REFUSED':
      return `${t('frozen.refusal.sasPathRefused.explanation')} ${t('frozen.refusal.sasPathRefused.action')}`;
    case 'BUDGET_EXCEEDED':
      return budgetWords(payload, t);
    case 'NO_LOAD':
      return `${t('frozen.refusal.noLoad.explanation')} ${t('frozen.refusal.noLoad.action')}`;
    case 'NOT_RECORDED':
      return `${t('frozen.refusal.notRecorded.explanation')} ${t('frozen.refusal.notRecorded.action')}`;
    case 'LOAD_CHANGED':
      return `${t('frozen.refusal.loadChanged.explanation')} ${t('frozen.refusal.loadChanged.action')}`;
    case 'TARGET_REFRESHED':
      return `${t('frozen.refusal.targetRefreshed.explanation')} ${t('frozen.refusal.targetRefreshed.action')}`;
    case 'LOAD_STOPPED':
      return `${t('frozen.refusal.loadStopped.explanation')} ${t('frozen.refusal.loadStopped.action')}`;
    case 'LOAD_REMOVED':
      return typeof payload.left === 'number' && payload.left > 0
        ? `${t('frozen.refusal.loadRemoved.partExplanation', { left: payload.left })} ${t(
            'frozen.refusal.loadRemoved.partAction',
          )}`
        : `${t('frozen.refusal.loadRemoved.explanation')} ${t('frozen.refusal.loadRemoved.action')}`;
    case 'LOAD_CONFIG':
      return isWords(payload.gaps)
        ? `${t('frozen.refusal.loadConfig.explanation')} ${t('frozen.refusal.loadConfig.action', {
            gaps: payload.gaps.join('; '),
          })}`
        : recordTypesWords(payload.recordTypesUntold, t);
    case 'TIMEOUT':
      return `${t('frozen.refusal.timeout.explanation')} ${t('frozen.refusal.timeout.action')}`;
    case 'LOAD_CANCELLED':
      return loadCancelledWords(payload, t);
    case 'SAS_CHANGED':
      return sasChangedWords(payload, t);
    // Met by a card read before another panel or the command line removed
    // the load, or found nothing left to take: the card is read again.
    case 'ALREADY_REMOVED':
      return `${t('frozen.refusal.alreadyRemoved.explanation')} ${t('frozen.refusal.alreadyRemoved.action')}`;
    case 'NOTHING_TO_REMOVE':
      return `${t('frozen.refusal.nothingToRemove.explanation')} ${t('frozen.refusal.nothingToRemove.action')}`;
    case 'EMAILS_NOT_ACCEPTED':
    case 'FROZEN_EMAILS_EXCEEDED':
      return emailsWords(payload, t, aliasOf);
    case 'AUTOMATION_NOT_ACCEPTED':
      return automationWords(payload, t, aliasOf);
    default:
      return undefined;
  }
}

/** How each kind of automation is named, with its name. */
const AUTOMATION_KIND_KEYS: Readonly<Record<string, string>> = {
  flow: 'orgAutomation.flow',
  trigger: 'orgAutomation.trigger',
  process: 'orgAutomation.process',
  workflowRule: 'orgAutomation.workflowRule',
};

/**
 * A load refused for what the target runs as it writes, nothing written:
 * the box not ticked. The host's sentence names `--accept-automation`, which
 * no page has. A refusal of a load whose question names nothing — a removal's
 * of the same code — keeps the host's words.
 */
function automationWords(
  payload: FrozenErrorPayload,
  t: (key: string, options?: Record<string, unknown>) => string,
  aliasOf: (orgId: string) => string,
): string | undefined {
  if (typeof payload.orgId !== 'string') return undefined;
  const automation = payload.automation as { firing?: unknown; unread?: unknown } | undefined;
  if (typeof automation !== 'object' || automation === null) return undefined;
  const org = aliasOf(payload.orgId);
  const firing = Array.isArray(automation.firing)
    ? (automation.firing as Array<Record<string, unknown>>).filter(
        (entry) =>
          typeof entry.objectApiName === 'string' &&
          typeof entry.name === 'string' &&
          typeof entry.kind === 'string' &&
          AUTOMATION_KIND_KEYS[entry.kind] !== undefined,
      )
    : [];
  const named = firing
    .map(
      (entry) =>
        `${String(entry.objectApiName)} — ${t(AUTOMATION_KIND_KEYS[String(entry.kind)], {
          name: entry.name,
        })}`,
    )
    .join('; ');
  const explanation =
    named !== ''
      ? t('frozen.refusal.automationNotAccepted.explanation', { org, named })
      : t('frozen.refusal.automationNotAccepted.explanationUnread', { org });
  return `${explanation} ${t('frozen.refusal.automationNotAccepted.action', { org })}`;
}

/**
 * A load its gate on the emails refused, nothing written: the org delivers
 * them without the box ticked, or they go past what it has left today. The
 * host's sentence names `--accept-emails`, which no page has.
 */
function emailsWords(
  payload: FrozenErrorPayload,
  t: (key: string, options?: Record<string, unknown>) => string,
  aliasOf: (orgId: string) => string,
): string | undefined {
  if (typeof payload.orgId !== 'string') return undefined;
  const org = aliasOf(payload.orgId);
  if (payload.code === 'EMAILS_NOT_ACCEPTED') {
    return `${t('frozen.refusal.emailsNotAccepted.explanation', { org })} ${t(
      'frozen.refusal.emailsNotAccepted.action',
      { org },
    )}`;
  }
  const counted = (payload.emails as { counted?: unknown } | undefined)?.counted;
  const over = Array.isArray(counted)
    ? (counted as Array<Record<string, unknown>>).find((count) => count.verdict === 'exceeds')
    : undefined;
  if (!over || typeof over.emails !== 'number') return undefined;
  return `${t('frozen.refusal.emailsExceeded.explanation', {
    org,
    limit: t(
      over.limit === 'SingleEmail' ? 'common.emailLimit.single' : 'common.emailLimit.workflow',
    ),
    emails: over.emails,
    remaining: typeof over.remaining === 'number' ? over.remaining : 0,
    max: typeof over.max === 'number' ? over.max : 0,
  })} ${t('frozen.refusal.emailsExceeded.action')}`;
}

/** A load the user stopped, with what it had written by then; undefined when the host did not say. */
function loadCancelledWords(
  payload: FrozenErrorPayload,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | undefined {
  if (typeof payload.written !== 'number') return undefined;
  return payload.written > 0
    ? `${t('frozen.refusal.loadCancelled.wroteExplanation', { records: payload.written })} ${t(
        'frozen.refusal.loadCancelled.wroteAction',
      )}`
    : `${t('frozen.refusal.loadCancelled.explanation')} ${t('frozen.refusal.loadCancelled.action')}`;
}

/** A verification refused for a sas other than the last load's, by the folders the host names. */
function sasChangedWords(
  payload: FrozenErrorPayload,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | undefined {
  const { sasDir, loadSas } = payload;
  if (typeof sasDir !== 'string' || typeof loadSas !== 'string') return undefined;
  if (payload.sasMoved !== true) {
    return `${t('frozen.refusal.sasChanged.emptiedExplanation', { sas: sasDir })} ${t(
      'frozen.refusal.sasChanged.emptiedAction',
    )}`;
  }
  return payload.contractThere === true
    ? `${t('frozen.refusal.sasChanged.otherExplanation', { sas: sasDir, loadSas })} ${t(
        'frozen.refusal.sasChanged.otherAction',
      )}`
    : `${t('frozen.refusal.sasChanged.movedExplanation', { sas: sasDir, loadSas })} ${t(
        'frozen.refusal.sasChanged.movedAction',
        { loadSas },
      )}`;
}

/** Two record types a load could not tell apart, named as the host names them; undefined without them. */
function recordTypesWords(
  untold: unknown,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | undefined {
  if (typeof untold !== 'object' || untold === null) return undefined;
  const { reason, objectApiName, name, recordTypes } = untold as Record<string, unknown>;
  if (typeof objectApiName !== 'string' || typeof name !== 'string' || !isWords(recordTypes)) {
    return undefined;
  }
  const named = { object: objectApiName, name, recordTypes: recordTypes.join(', ') };
  if (reason === 'label') {
    return `${t('frozen.refusal.recordTypeLabel.explanation', named)} ${t(
      'frozen.refusal.recordTypeLabel.action',
    )}`;
  }
  if (reason === 'namespace') {
    return `${t('frozen.refusal.recordTypeNamespace.explanation', named)} ${t(
      'frozen.refusal.recordTypeNamespace.action',
    )}`;
  }
  return undefined;
}

/** What refused a load at its entry, by the guard the host names; undefined when it names too little. */
function guardWords(
  payload: FrozenErrorPayload,
  t: (key: string, options?: Record<string, unknown>) => string,
  aliasOf: (orgId: string) => string,
): string | undefined {
  if (payload.guard === 'empty-dataset') {
    return `${t('frozen.refusal.emptyDataset.explanation')} ${t('frozen.refusal.emptyDataset.action')}`;
  }
  // Production Guard's, said as every module's page says it: declined at its
  // question, or refused for a reason the guard gives in the user's words.
  // Given no decision — refused once batches went through — the host's words
  // stay, which name what the load wrote.
  if (payload.guard === 'guard-refused') {
    if (payload.decision === 'declined') return t('common.refusal.guardDeclined');
    return payload.decision === 'refused' && typeof payload.reason === 'string'
      ? t('common.refusal.guardBlocked', { reason: payload.reason })
      : undefined;
  }
  if (typeof payload.orgId !== 'string') return undefined;
  const org = aliasOf(payload.orgId);
  switch (payload.guard) {
    case 'source-is-target':
      return `${t('frozen.refusal.sourceIsTarget.explanation', { org })} ${t(
        'frozen.refusal.sourceIsTarget.action',
      )}`;
    case 'non-sandbox':
      return `${t('frozen.refusal.nonSandbox.explanation', { org })} ${t(
        'frozen.refusal.nonSandbox.action',
      )}`;
    case 'protected-environment':
      return `${t('frozen.refusal.protectedEnvironment.explanation', { org })} ${t(
        'frozen.refusal.protectedEnvironment.action',
      )}`;
    case 'unmocked-callouts':
      return `${t('frozen.refusal.unmockedCallouts.explanation', { org })} ${t(
        'frozen.refusal.unmockedCallouts.action',
      )}`;
    default:
      return undefined;
  }
}

/** A selection past its budget, with the figures the host measured; undefined without them. */
function budgetWords(
  payload: FrozenErrorPayload,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | undefined {
  if (typeof payload.total !== 'number' || typeof payload.budgetMax !== 'number') return undefined;
  const heaviest =
    isWords(payload.heaviest) && payload.heaviest.length > 0
      ? `${t('frozen.refusal.budgetExceeded.heaviest', { objects: payload.heaviest.join(', ') })} `
      : '';
  return (
    `${t('frozen.refusal.budgetExceeded.explanation', {
      total: payload.total,
      budget: payload.budgetMax,
    })} ${heaviest}` + t('frozen.refusal.budgetExceeded.action')
  );
}
