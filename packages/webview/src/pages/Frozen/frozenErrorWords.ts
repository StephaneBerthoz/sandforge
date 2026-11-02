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
        : undefined;
    case 'TIMEOUT':
      return `${t('frozen.refusal.timeout.explanation')} ${t('frozen.refusal.timeout.action')}`;
    default:
      return undefined;
  }
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
