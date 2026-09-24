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
    expect(config.excludedObjects).toEqual(new Set());
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
      excludedObjects: ['PricebookEntry', 'OrderItem'],
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
    expect(config.excludedObjects).toEqual(new Set(['PricebookEntry', 'OrderItem']));
    expect(config.ownerMappings).toEqual({ '005OLD': '005NEW' });
    expect(config.objectSoqlFilters).toEqual({ Case: "Status = 'Open'" });
    expect(config.fieldMappings).toEqual({ Account: { Region__c: 'Region__pc' } });
  });

  it('knows what the run it retries wrote, and nothing for a run that retries none', () => {
    expect(resolveStageConfig(undefined).writtenBefore.size).toBe(0);
    const config = resolveStageConfig({
      writtenBefore: { '001000000000001SRC': '001000000000001TGT' },
    });
    expect([...config.writtenBefore]).toEqual([['001000000000001SRC', '001000000000001TGT']]);
  });

  it('copies no file unless asked', () => {
    expect(resolveStageConfig(undefined).files).toBeUndefined();
    expect(resolveStageConfig({ dryRun: true }).files).toBeUndefined();
  });

  it('holds the size of a file copied to what one call carries', () => {
    const MB = 1_048_576;

    expect(
      resolveStageConfig({ files: { maxFileBytes: 500 * MB, acceptedAsIs: true } }).files,
    ).toEqual({ maxFileBytes: 35 * MB, acceptedAsIs: true });
    expect(resolveStageConfig({ files: { maxFileBytes: 0 } }).files).toEqual({
      maxFileBytes: 10 * MB,
      acceptedAsIs: false,
    });
    expect(resolveStageConfig({ files: { maxFileBytes: 2 * MB } }).files?.maxFileBytes).toBe(
      2 * MB,
    );
  });
});
