import type { SalesforceOrg } from '@sandforge/shared';
import type { TFunction } from 'i18next';

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
  Developer: 'sidePanel.orgType.dev',
  DeveloperPro: 'sidePanel.orgType.devPro',
  Partial: 'sidePanel.orgType.partial',
  Full: 'sidePanel.orgType.full',
};

/**
 * Derive a short display label for an org based on its type, tags, and sandbox info.
 *
 * Every label comes from the catalogue but an environment tag, which is the
 * user's own word. A Developer Edition org used to fall through to its raw
 * type upper-cased, and the org card called this without a translation
 * function, so it wrote the English labels in every language.
 *
 * @param org - The Salesforce org.
 * @param t - The i18n translation function.
 */
export function orgTypeLabel(org: SalesforceOrg, t: TFunction): string {
  if (org.orgType === 'Production') return t('sidePanel.orgType.prod');
  if (org.orgType === 'Scratch') return t('sidePanel.orgType.scratch');
  const envTags = org.tags
    .map((tag) => tag.toUpperCase())
    .filter((tag): tag is string => (ENV_TAGS as readonly string[]).includes(tag));
  if (envTags.length > 0) return envTags[0];
  if (org.sandboxType) return t(SANDBOX_TYPE_KEYS[org.sandboxType] ?? 'sidePanel.orgType.sandbox');
  return t(
    org.orgType === 'Developer' ? 'sidePanel.orgType.developer' : 'sidePanel.orgType.sandbox',
  );
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
