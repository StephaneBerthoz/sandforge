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

/**
 * Derive a short display label for an org based on its type, tags, and sandbox info.
 * Uses i18n when a translation function is provided, otherwise returns uppercase labels.
 * @param org - The Salesforce org.
 * @param t - Optional i18n translation function.
 */
export function orgTypeLabel(org: SalesforceOrg, t?: TFunction): string {
  if (org.orgType === 'Production') return t ? t('sidePanel.orgType.prod') : 'PROD';
  if (org.orgType === 'Scratch') return t ? t('sidePanel.orgType.scratch') : 'SCRATCH';
  const envTags = org.tags
    .map((tag) => tag.toUpperCase())
    .filter((tag): tag is string => (ENV_TAGS as readonly string[]).includes(tag));
  if (envTags.length > 0) return envTags[0];
  if (org.sandboxType) {
    if (t) {
      const sandboxLabels: Record<string, string> = {
        Developer: t('sidePanel.orgType.dev'),
        DeveloperPro: t('sidePanel.orgType.devPro'),
        Partial: t('sidePanel.orgType.partial'),
        Full: t('sidePanel.orgType.full'),
      };
      return sandboxLabels[org.sandboxType] ?? t('sidePanel.orgType.sandbox');
    }
    const labels: Record<string, string> = {
      Developer: 'DEV',
      DeveloperPro: 'DEV PRO',
      Partial: 'PARTIAL',
      Full: 'FULL',
    };
    return labels[org.sandboxType] ?? 'SANDBOX';
  }
  if (t) {
    return org.orgType === 'Sandbox' ? t('sidePanel.orgType.sandbox') : org.orgType.toUpperCase();
  }
  return org.orgType === 'Sandbox' ? 'SANDBOX' : org.orgType.toUpperCase();
}
