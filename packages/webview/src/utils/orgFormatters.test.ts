import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n, type TFunction } from 'i18next';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';

import en from '../i18n/locales/en.json';
import fr from '../i18n/locales/fr.json';
import de from '../i18n/locales/de.json';
import es from '../i18n/locales/es.json';
import ja from '../i18n/locales/ja.json';
import ptBR from '../i18n/locales/pt-BR.json';
import { orgOptionLabel, orgTypeLabel } from './orgFormatters';

let instance: I18n;

beforeAll(async () => {
  instance = createInstance();
  await instance.init({
    resources: {
      en: { translation: en },
      fr: { translation: fr },
      de: { translation: de },
      es: { translation: es },
      ja: { translation: ja },
      'pt-BR': { translation: ptBR },
    },
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
    expect(orgTypeLabel(org({ orgType: 'Production' }), keyOf)).toBe('«common.orgType.prod»');
    expect(orgTypeLabel(org({ orgType: 'Scratch' }), keyOf)).toBe('«common.orgType.scratch»');
    expect(orgTypeLabel(org({ orgType: 'Developer' }), keyOf)).toBe('«common.orgType.developer»');
    expect(orgTypeLabel(org({ orgType: 'Sandbox' }), keyOf)).toBe('«common.orgType.sandbox»');
    expect(orgTypeLabel(org({ sandboxType: 'Partial' }), keyOf)).toBe('«common.orgType.partial»');
  });

  it('names a Developer Edition org an earlier build registered as production by its edition, never PROD', () => {
    const playground = org({
      orgType: 'Production',
      metadata: { apiVersion: '62.0', edition: 'Developer Edition', features: [] },
    });
    expect(orgTypeLabel(playground, keyOf)).toBe('«common.orgType.developer»');
    // A production org of another edition keeps its PROD badge.
    expect(orgTypeLabel(org({ orgType: 'Production' }), keyOf)).toBe('«common.orgType.prod»');
  });

  it('shows an environment tag as the user wrote it', () => {
    expect(orgTypeLabel(org({ tags: ['uat'] }), keyOf)).toBe('UAT');
  });

  it('says Staging of a sandbox marked so, as Production Guard takes it, before any environment tag, and of no other org', () => {
    expect(orgTypeLabel(org({ staging: true, tags: ['uat'] }), keyOf)).toBe(
      '«common.orgType.staging»',
    );
    expect(orgTypeLabel(org({ staging: true, sandboxType: 'Full' }), instance.t)).toBe('STAGING');
    expect(orgTypeLabel(org({ staging: true, orgType: 'Scratch' }), keyOf)).toBe(
      '«common.orgType.scratch»',
    );
    expect(orgTypeLabel(org({ staging: false, sandboxType: 'Full' }), keyOf)).toBe(
      '«common.orgType.full»',
    );
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

  it('says a partial copy and a full sandbox in German, Spanish, Portuguese and Japanese, as in French', () => {
    // Only French was translated: the four others wore PARTIAL and FULL, and
    // Japanese PROD and STAGING, where the Edit dialog's checkbox says
    // ステージング.
    const label = (lng: string, overrides: Partial<SalesforceOrg>): string =>
      orgOptionLabel(org({ alias: 'a', ...overrides }), instance.getFixedT(lng));
    expect(
      ['de', 'es', 'pt-BR', 'ja'].map((lng) => [
        lng,
        label(lng, { sandboxType: 'Partial' }),
        label(lng, { sandboxType: 'Full' }),
      ]),
    ).toEqual([
      ['de', 'a [TEILKOPIE]', 'a [VOLLKOPIE]'],
      ['es', 'a [PARCIAL]', 'a [COMPLETO]'],
      ['pt-BR', 'a [PARCIAL]', 'a [COMPLETO]'],
      ['ja', 'a [部分コピー]', 'a [フル]'],
    ]);
    expect(label('ja', { orgType: 'Production' })).toBe('a [本番]');
    expect(label('ja', { staging: true })).toBe(`a [${ja.org.staging}]`);
    // The badge of a staging sandbox says the word of the checkbox that marks it.
    for (const [lng, bundle] of [
      ['de', de],
      ['es', es],
      ['pt-BR', ptBR],
    ] as const) {
      expect(label(lng, { staging: true }), lng).toBe(`a [${bundle.org.staging.toUpperCase()}]`);
    }
  });

  it('names an org with no alias by its own name, else its Organization Id, never by the username', () => {
    expect(
      orgOptionLabel(
        org({ alias: '', orgType: 'Production', organizationName: 'Example Workspace' }),
        instance.t,
      ),
    ).toBe('Example Workspace [PROD]');
    expect(
      orgOptionLabel(
        org({ alias: 'admin@example.test', orgType: 'Production', orgId: '00D000000000001AAA' }),
        instance.t,
      ),
    ).toBe('00D000000000001AAA [PROD]');
  });
});
