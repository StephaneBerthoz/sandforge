import { describe, it, expect, vi } from 'vitest';
import { SyncAnalyzer } from './SyncAnalyzer';
import type { SyncAnalyzerConnection } from './SyncAnalyzer';
import type { SyncConfig, SyncObjectConfig } from '@sandforge/shared';

function makeObjConfig(overrides: Partial<SyncObjectConfig> = {}): SyncObjectConfig {
  return {
    objectApiName: 'Account',
    operation: 'upsert',
    batchSize: 200,
    fieldMappings: [{ sourceField: 'Name', targetField: 'Name', type: 'direct' }],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    insertOrder: 1,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    conflictStrategy: 'source_wins',
    objects: [makeObjConfig()],
    dryRun: false,
    ...overrides,
  };
}

function makeConn(sourceCount = 100, conflicts: unknown[] = []): SyncAnalyzerConnection {
  return {
    queryCount: vi.fn().mockResolvedValue(sourceCount),
    queryModifiedSince: vi.fn().mockResolvedValue(0),
    detectConflicts: vi.fn().mockResolvedValue(conflicts),
  };
}

describe('SyncAnalyzer', () => {
  const analyzer = new SyncAnalyzer();

  it('should return analysis for all objects', async () => {
    const config = makeConfig({
      objects: [makeObjConfig(), makeObjConfig({ objectApiName: 'Contact' })],
    });
    const result = await analyzer.analyze(makeConn(), config);
    expect(result.objects).toHaveLength(2);
  });

  it('should count modified records for upsert operation', async () => {
    const result = await analyzer.analyze(makeConn(500), makeConfig());
    expect(result.totalModifiedRecords).toBe(500);
    expect(result.totalNewRecords).toBe(0);
    expect(result.totalDeletedRecords).toBe(0);
  });

  it('should count new records for insert operation', async () => {
    const config = makeConfig({
      objects: [makeObjConfig({ operation: 'insert' })],
    });
    const result = await analyzer.analyze(makeConn(300), config);
    expect(result.totalNewRecords).toBe(300);
  });

  it('should count deleted records for delete operation', async () => {
    const config = makeConfig({
      objects: [makeObjConfig({ operation: 'delete' })],
    });
    const result = await analyzer.analyze(makeConn(50), config);
    expect(result.totalDeletedRecords).toBe(50);
  });

  it('should warn about deletions', async () => {
    const config = makeConfig({
      objects: [makeObjConfig({ operation: 'delete' })],
    });
    const result = await analyzer.analyze(makeConn(10), config);
    expect(result.warnings.some((w) => w.includes('deleted'))).toBe(true);
    expect(result.overallRisk).toBe('high');
  });

  it('should detect conflicts in bidirectional mode', async () => {
    const conflict = {
      objectApiName: 'Account',
      recordId: '001xx',
      sourceValues: { Name: 'Source' },
      targetValues: { Name: 'Target' },
      conflictFields: ['Name'],
    };
    const config = makeConfig({
      direction: 'bidirectional',
      objects: [makeObjConfig({ externalIdField: 'Id' })],
    });
    const conn = makeConn(100, [conflict]);
    const result = await analyzer.analyze(conn, config);
    expect(result.totalConflicts).toBe(1);
    expect(result.warnings.some((w) => w.includes('conflict'))).toBe(true);
  });

  it('should not detect conflicts in unidirectional mode', async () => {
    const config = makeConfig({ direction: 'source_to_target' });
    const conn = makeConn();
    const result = await analyzer.analyze(conn, config);
    expect(result.totalConflicts).toBe(0);
    expect(conn.detectConflicts).not.toHaveBeenCalled();
  });

  it('should estimate API calls based on batch size', async () => {
    const config = makeConfig({
      objects: [makeObjConfig({ batchSize: 100 })],
    });
    const result = await analyzer.analyze(makeConn(500), config);
    expect(result.estimatedApiCalls).toBe(5);
  });

  it('should estimate duration', async () => {
    const result = await analyzer.analyze(makeConn(1000), makeConfig());
    expect(result.estimatedDuration).toBeGreaterThan(0);
  });

  it('should handle query errors gracefully', async () => {
    const conn: SyncAnalyzerConnection = {
      queryCount: vi.fn().mockRejectedValue(new Error('Network')),
      queryModifiedSince: vi.fn().mockResolvedValue(0),
      detectConflicts: vi.fn().mockResolvedValue([]),
    };
    const result = await analyzer.analyze(conn, makeConfig());
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].delta.modifiedRecords).toBe(0);
  });

  it('should assign high risk for high volume + delete', async () => {
    const config = makeConfig({
      objects: [makeObjConfig({ operation: 'delete' })],
    });
    const result = await analyzer.analyze(makeConn(50000), config);
    expect(result.objects[0].riskLevel).toBe('high');
  });

  it('should assign medium risk for high volume', async () => {
    const result = await analyzer.analyze(makeConn(15000), makeConfig());
    expect(result.objects[0].riskLevel).toBe('medium');
  });

  it('should assign low risk for small operations', async () => {
    const result = await analyzer.analyze(makeConn(50), makeConfig());
    expect(result.objects[0].riskLevel).toBe('low');
  });

  it('should warn about full sync with many modifications', async () => {
    const result = await analyzer.analyze(makeConn(5000), makeConfig({ mode: 'full' }));
    expect(result.warnings.some((w) => w.includes('incremental'))).toBe(true);
  });

  it('should track mapping and transform counts', async () => {
    const config = makeConfig({
      objects: [makeObjConfig({
        fieldMappings: [
          { sourceField: 'A', targetField: 'A', type: 'direct' },
          { sourceField: 'B', targetField: 'B', type: 'direct' },
        ],
        transformRules: [{ type: 'uppercase', config: {} }],
      })],
    });
    const result = await analyzer.analyze(makeConn(), config);
    expect(result.objects[0].mappingCount).toBe(2);
    expect(result.objects[0].transformCount).toBe(1);
  });

  it('should include risk reasons', async () => {
    const config = makeConfig({
      objects: [makeObjConfig({ operation: 'delete', batchSize: 500 })],
    });
    const result = await analyzer.analyze(makeConn(20000), config);
    const reasons = result.objects[0].riskReasons;
    expect(reasons.some((r) => r.includes('Delete'))).toBe(true);
    expect(reasons.some((r) => r.includes('volume'))).toBe(true);
    expect(reasons.some((r) => r.includes('Batch size'))).toBe(true);
  });
});
