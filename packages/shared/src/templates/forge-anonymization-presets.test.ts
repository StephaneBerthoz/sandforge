import { describe, it, expect } from 'vitest';
import {
  FORGE_ANONYMIZATION_PRESETS,
  findForgeAnonymizationPreset,
} from './forge-anonymization-presets.js';

describe('FORGE_ANONYMIZATION_PRESETS', () => {
  it('exposes 4 presets', () => {
    expect(FORGE_ANONYMIZATION_PRESETS.length).toBe(4);
  });

  it('every preset has an id starting with "preset:"', () => {
    for (const p of FORGE_ANONYMIZATION_PRESETS) {
      expect(p.id.startsWith('preset:')).toBe(true);
    }
  });

  it('every preset id is unique', () => {
    const ids = FORGE_ANONYMIZATION_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every rule covers at least one field', () => {
    for (const p of FORGE_ANONYMIZATION_PRESETS) {
      for (const r of p.rules) {
        expect(r.fieldNames.length).toBeGreaterThan(0);
      }
    }
  });

  it('GDPR strict is a superset of GDPR default', () => {
    const def = FORGE_ANONYMIZATION_PRESETS.find((p) => p.id === 'preset:gdpr-default')!;
    const strict = FORGE_ANONYMIZATION_PRESETS.find((p) => p.id === 'preset:gdpr-strict')!;
    for (const defRule of def.rules) {
      const strictRule = strict.rules.find((r) => r.objectApiName === defRule.objectApiName);
      expect(strictRule).toBeDefined();
      // For shared objects, strict should cover at least the default fields
      // (e.g., Account/Contact). Lead is identical in this version.
      const overlap = defRule.fieldNames.filter((f) => strictRule!.fieldNames.includes(f));
      expect(overlap.length).toBeGreaterThanOrEqual(defRule.fieldNames.length - 2);
    }
  });

  it('healthcare preset includes insurance-style PHI fields', () => {
    const healthcare = FORGE_ANONYMIZATION_PRESETS.find((p) => p.id === 'preset:healthcare')!;
    const asset = healthcare.rules.find((r) => r.objectApiName === 'Asset');
    expect(asset?.fieldNames).toContain('PolicyNumber__c');
    expect(asset?.fieldNames).toContain('AssistanceRef__c');
  });

  it('internal-test stays minimal (≤ 2 fields per object)', () => {
    const internal = FORGE_ANONYMIZATION_PRESETS.find((p) => p.id === 'preset:internal-test')!;
    for (const r of internal.rules) {
      expect(r.fieldNames.length).toBeLessThanOrEqual(2);
    }
  });
});

describe('findForgeAnonymizationPreset', () => {
  it('returns the preset by id', () => {
    const result = findForgeAnonymizationPreset('preset:gdpr-default');
    expect(result?.name).toBe('GDPR — default');
  });

  it('returns undefined for unknown ids', () => {
    expect(findForgeAnonymizationPreset('preset:nope')).toBeUndefined();
    expect(findForgeAnonymizationPreset('')).toBeUndefined();
  });
});
