import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n, type TFunction } from 'i18next';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';

import en from '../i18n/locales/en.json';
import fr from '../i18n/locales/fr.json';
import { orgOptionLabel, orgTypeLabel } from './orgFormatters';

let instance: I18n;

beforeAll(async () => {
  instance = createInstance();
  await instance.init({
    resources: { en: { translation: en }, fr: { translation: fr } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
});

function org(overrides: Partial<SalesforceOrg>): SalesforceOrg {
  return {
    id: '00D000000000001AAA',
    alias: 'dev',
    username: 'admin@example.test',
    instanceUrl: 'https://example.my.salesforce.com',
    orgId: '00D000000000001AAA',
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
    safetyTier: OrgSafetyTier.MEDIUM,
    appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-09-01T08:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

describe('orgTypeLabel', () => {
  /** A translation function that shows which key it was handed. */
  const keyOf = ((key: string) => `«${key}»`) as unknown as TFunction;

  it('takes the label of every org type from the catalogue', () => {
    // A Developer Edition org fell through to its raw type, upper-cased:
    // "DEVELOPER" in every language.
    expect(orgTypeLabel(org({ orgType: 'Production' }), keyOf)).toBe('«sidePanel.orgType.prod»');
    expect(orgTypeLabel(org({ orgType: 'Scratch' }), keyOf)).toBe('«sidePanel.orgType.scratch»');
    expect(orgTypeLabel(org({ orgType: 'Developer' }), keyOf)).toBe(
      '«sidePanel.orgType.developer»',
    );
    expect(orgTypeLabel(org({ orgType: 'Sandbox' }), keyOf)).toBe('«sidePanel.orgType.sandbox»');
    expect(orgTypeLabel(org({ sandboxType: 'Partial' }), keyOf)).toBe(
      '«sidePanel.orgType.partial»',
    );
  });

  it('shows an environment tag as the user wrote it', () => {
    expect(orgTypeLabel(org({ tags: ['uat'] }), keyOf)).toBe('UAT');
  });

  it('names a Developer Edition org in English as it did', () => {
    expect(orgTypeLabel(org({ orgType: 'Developer' }), instance.t)).toBe('DEVELOPER');
  });
});

describe('orgOptionLabel', () => {
  it('names a scratch org as one, not as a sandbox', () => {
    expect(orgOptionLabel(org({ alias: 'feature', orgType: 'Scratch' }), instance.t)).toBe(
      'feature [SCRATCH]',
    );
  });

  it('names a production org and a sandbox by their type', () => {
    expect(orgOptionLabel(org({ alias: 'prod', orgType: 'Production' }), instance.t)).toBe(
      'prod [PROD]',
    );
    expect(orgOptionLabel(org({ alias: 'uat' }), instance.t)).toBe('uat [SANDBOX]');
  });

  it('gives the kind of sandbox the badges give, in the language of the page', () => {
    const fixed = instance.getFixedT('fr');

    expect(orgOptionLabel(org({ alias: 'full', sandboxType: 'Full' }), fixed)).toBe(
      'full [COMPLET]',
    );
  });

  it('falls back to the username when the org has no alias', () => {
    expect(orgOptionLabel(org({ alias: '', orgType: 'Production' }), instance.t)).toBe(
      'admin@example.test [PROD]',
    );
  });
});
