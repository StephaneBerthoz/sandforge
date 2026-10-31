import { describe, it, expect } from 'vitest';
import { BUILTIN_FORGE_TEMPLATES } from '@sandforge/shared';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ptBR from '../../i18n/locales/pt-BR.json';
import ja from '../../i18n/locales/ja.json';
import {
  SMART_SOQL_CAP,
  SOQL_UNSCOPED_RECORD_CAP,
  extractSalesforceDomain,
  isPiiField,
  starterTemplateKeys,
} from './forgeUtils';

const LOCALES: Record<string, unknown> = { en, fr, de, es, 'pt-BR': ptBR, ja };

/** The string a dotted key names in a catalogue, or undefined. */
function lookUp(catalogue: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      catalogue,
    );
}

describe('starterTemplateKeys', () => {
  it('gives every starter template a name and a description in all six languages', () => {
    const missing: string[] = [];
    for (const template of BUILTIN_FORGE_TEMPLATES) {
      const keys = starterTemplateKeys(template.id);
      if (keys === null) {
        missing.push(`${template.id}: no keys`);
        continue;
      }
      for (const [lng, catalogue] of Object.entries(LOCALES)) {
        for (const key of [keys.name, keys.description]) {
          if (typeof lookUp(catalogue, key) !== 'string')
            missing.push(`${template.id}: ${lng} ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('says the English the shared templates hold, so the fallback and the catalogue agree', () => {
    for (const template of BUILTIN_FORGE_TEMPLATES) {
      const keys = starterTemplateKeys(template.id);
      expect(lookUp(en, keys?.name ?? '')).toBe(template.name);
      expect(lookUp(en, keys?.description ?? '')).toBe(template.description);
    }
  });

  it('knows no saved template', () => {
    expect(starterTemplateKeys('a1b2c3d4-user-template')).toBeNull();
  });
});

describe('SMART_SOQL_CAP', () => {
  it('stays under the cap a SOQL run is held to whatever is chosen', () => {
    expect(SMART_SOQL_CAP).toBeGreaterThan(0);
    expect(SMART_SOQL_CAP).toBeLessThanOrEqual(SOQL_UNSCOPED_RECORD_CAP);
  });
});

describe('extractSalesforceDomain', () => {
  it('should extract the pod/host prefix from a Salesforce URL', () => {
    expect(extractSalesforceDomain('https://myorg.salesforce.com/')).toBe('myorg');
    expect(extractSalesforceDomain('https://myorg.lightning.force.com/lightning/r/x')).toBe(
      'myorg',
    );
  });

  it('should lowercase the host', () => {
    expect(extractSalesforceDomain('https://MyOrg.Salesforce.com')).toBe('myorg');
  });

  it('should return null for invalid URLs', () => {
    expect(extractSalesforceDomain('not a url')).toBeNull();
    expect(extractSalesforceDomain('')).toBeNull();
  });
});

describe('isPiiField', () => {
  it('should detect common PII field names', () => {
    expect(isPiiField('Email')).toBe(true);
    expect(isPiiField('Phone')).toBe(true);
    expect(isPiiField('MobilePhone__c')).toBe(true);
    expect(isPiiField('BillingStreet')).toBe(true);
    expect(isPiiField('SSN__c')).toBe(true);
    expect(isPiiField('Birthdate')).toBe(true);
  });

  it('should not flag non-PII field names', () => {
    expect(isPiiField('Name')).toBe(false);
    expect(isPiiField('Industry')).toBe(false);
    expect(isPiiField('AnnualRevenue')).toBe(false);
  });
});
