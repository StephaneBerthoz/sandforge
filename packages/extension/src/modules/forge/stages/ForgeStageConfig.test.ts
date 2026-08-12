import { describe, it, expect } from 'vitest';
import { resolveStageConfig } from './ForgeStageConfig.js';

describe('resolveStageConfig', () => {
  it('applies legacy defaults when no options are given', () => {
    const config = resolveStageConfig(undefined);

    expect(config.isScoped).toBe(false);
    expect(config.dryRun).toBe(false);
    // Legacy (full-table) mode defaults to 'keep' — back-compat.
    expect(config.referenceFallback).toBe('keep');
    expect(config.referenceDataObjects).toEqual(new Set(['BusinessHours', 'OperatingHours']));
    expect(config.expandOrphanParents).toBe(false);
    expect(config.maxOrphanParentExpansions).toBe(20);
    expect(config.upsertMode).toBe('off');
    expect(config.fieldExclusions).toEqual({});
    expect(config.ownerMappings).toEqual({});
    expect(config.fieldMappings).toEqual({});
    expect(config.recordTypeMappings).toBeUndefined();
    expect(config.maxRecordsPerObject).toBeUndefined();
    expect(config.objectSoqlFilters).toBeUndefined();
  });

  it('enters scoped mode and defaults fallback to nullify when root is provided', () => {
    const config = resolveStageConfig({
      rootRecordId: '500XX00000000001AAA',
      rootObjectApiName: 'Case',
    });

    expect(config.isScoped).toBe(true);
    expect(config.referenceFallback).toBe('nullify');
    expect(config.rootRecordId).toBe('500XX00000000001AAA');
    expect(config.rootObjectApiName).toBe('Case');
  });

  it('stays non-scoped when only one of rootRecordId / rootObjectApiName is set', () => {
    expect(resolveStageConfig({ rootRecordId: '500XX00000000001AAA' }).isScoped).toBe(false);
    expect(resolveStageConfig({ rootObjectApiName: 'Case' }).isScoped).toBe(false);
  });

  it('respects an explicit referenceFallback override', () => {
    const config = resolveStageConfig({
      rootRecordId: '500XX00000000001AAA',
      rootObjectApiName: 'Case',
      referenceFallback: 'keep',
    });
    expect(config.referenceFallback).toBe('keep');
  });

  it('passes through opt-in knobs', () => {
    const config = resolveStageConfig({
      dryRun: true,
      maxRecordsPerObject: 50,
      upsertMode: 'auto',
      expandOrphanParents: true,
      maxOrphanParentExpansions: 5,
      referenceDataObjects: ['BusinessHours'],
      fieldExclusions: { Account: ['Description'] },
      ownerMappings: { '005OLD': '005NEW' },
      objectSoqlFilters: { Case: "Status = 'Open'" },
      fieldMappings: { Account: { Region__c: 'Region__pc' } },
    });

    expect(config.dryRun).toBe(true);
    expect(config.maxRecordsPerObject).toBe(50);
    expect(config.upsertMode).toBe('auto');
    expect(config.expandOrphanParents).toBe(true);
    expect(config.maxOrphanParentExpansions).toBe(5);
    expect(config.referenceDataObjects).toEqual(new Set(['BusinessHours']));
    expect(config.fieldExclusions).toEqual({ Account: ['Description'] });
    expect(config.ownerMappings).toEqual({ '005OLD': '005NEW' });
    expect(config.objectSoqlFilters).toEqual({ Case: "Status = 'Open'" });
    expect(config.fieldMappings).toEqual({ Account: { Region__c: 'Region__pc' } });
  });
});
