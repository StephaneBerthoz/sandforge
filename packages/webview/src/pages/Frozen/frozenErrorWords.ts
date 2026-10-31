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
}

/**
 * A Frozen error the page words itself, in the interface language, or
 * `undefined` to show the host's message: no configuration saved
 * (`CONFIG_MISSING`), no rules file where the extraction reads it
 * (`RULES_MISSING`), and a load refused because its target is the org the
 * dataset was extracted from (`GUARD_REFUSED`, guard `source-is-target`).
 *
 * The host words them in English for its log and the command line. Shown as
 * they were, a first-time user read "frozen:config:save: coverage axes, …"
 * before saving, "it is the source of truth (object.field → generator)" with
 * no rules file, and "manifest source.orgId" on the first load the Load tab
 * offered, in every locale. Each now says what to click.
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
    case 'GUARD_REFUSED':
      return payload.guard === 'source-is-target' && typeof payload.orgId === 'string'
        ? `${t('frozen.refusal.sourceIsTarget.explanation', { org: aliasOf(payload.orgId) })} ${t(
            'frozen.refusal.sourceIsTarget.action',
          )}`
        : undefined;
    default:
      return undefined;
  }
}
