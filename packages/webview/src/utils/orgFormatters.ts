import type { SalesforceOrg } from '@sandforge/shared';
import { expiredScratchDate, guardTierOf, registeredOrgType } from '@sandforge/shared';
import type { TFunction } from 'i18next';

/**
 * The day a scratch org expired on, `YYYY-MM-DD`, when it is past it; undefined
 * for any other org. Salesforce deletes a scratch org when it expires: its card
 * read "Session Expired" and offered Try Reconnect, whose import leaves such an
 * org out, and nothing changed.
 */
export function scratchExpiredOn(
  org: Pick<SalesforceOrg, 'orgType' | 'metadata'>,
  today: string = new Date().toISOString().slice(0, 10),
): string | undefined {
  return expiredScratchDate(org, today);
}

/** Environment tags recognized for org type resolution. */
const ENV_TAGS = [
  'UAT',
  'PREPROD',
  'PRE-PROD',
  'DEV',
  'QA',
  'SIT',
  'STAGING',
  'HOTFIX',
  'INT',
] as const;

/** The catalogue key of each kind of sandbox. */
const SANDBOX_TYPE_KEYS: Readonly<Record<string, string>> = {
  Developer: 'common.orgType.dev',
  DeveloperPro: 'common.orgType.devPro',
  Partial: 'common.orgType.partial',
  Full: 'common.orgType.full',
};

/**
 * Derive a short display label for an org based on its type, tags, and sandbox info.
 *
 * Every label comes from the catalogue but an environment tag, which is the
 * user's own word. A Developer Edition org used to fall through to its raw
 * type upper-cased, and the org card called this without a translation
 * function, so it wrote the English labels in every language. One an earlier
 * build registered as a production org is read by its edition
 * (`registeredOrgType`): it wore a red PROD badge.
 *
 * @param org - The Salesforce org.
 * @param t - The i18n translation function.
 */
export function orgTypeLabel(org: SalesforceOrg, t: TFunction): string {
  const orgType = registeredOrgType(org.orgType, org.metadata?.edition);
  if (orgType === 'Production') return t('common.orgType.prod');
  if (orgType === 'Scratch') return t('common.orgType.scratch');
  // Marked Staging, as Production Guard takes it: said before the user's own
  // environment tags, which no guard reads.
  if (guardTierOf(org) === 'staging') return t('common.orgType.staging');
  const envTags = org.tags
    .map((tag) => tag.toUpperCase())
    .filter((tag): tag is string => (ENV_TAGS as readonly string[]).includes(tag));
  if (envTags.length > 0) return envTags[0];
  if (org.sandboxType) return t(SANDBOX_TYPE_KEYS[org.sandboxType] ?? 'common.orgType.sandbox');
  return t(orgType === 'Developer' ? 'common.orgType.developer' : 'common.orgType.sandbox');
}

/**
 * How an org is named in an org picker: its alias, or its username, and its
 * type as the org badges show it ({@link orgTypeLabel}).
 *
 * The pickers used to write `[PROD]` for a production org and `[SBX]` for
 * every other one, so a scratch org was offered as a sandbox, in English
 * whatever the language.
 *
 * @param org - The Salesforce org.
 * @param t - The i18n translation function.
 */
export function orgOptionLabel(org: SalesforceOrg, t: TFunction): string {
  return `${org.alias || org.username} [${orgTypeLabel(org, t)}]`;
}
