import { describe, it, expect, beforeEach } from 'vitest';
import { ConflictResolver } from './ConflictResolver';
import type { ConflictRecord, FieldResolution } from '@sandforge/shared';

function createConflict(overrides?: Partial<ConflictRecord>): ConflictRecord {
  return {
    objectApiName: 'Account',
    recordId: 'EXT-001',
    sourceValues: { Name: 'Acme Source' },
    targetValues: { Name: 'Acme Target' },
    conflictFields: ['Name'],
    ...overrides,
  };
}

describe('ConflictResolver', () => {
  let resolver: ConflictResolver;

  beforeEach(() => {
    resolver = new ConflictResolver();
  });

  describe('resolve', () => {
    it('should resolve with source values for source_wins strategy', () => {
      const conflicts = [createConflict()];
      const results = resolver.resolve(conflicts, 'source_wins');

      expect(results[0].resolvedValues.Name).toBe('Acme Source');
      expect(results[0].strategy).toBe('source_wins');
    });

    it('should resolve with target values for target_wins strategy', () => {
      const conflicts = [createConflict()];
      const results = resolver.resolve(conflicts, 'target_wins');

      expect(results[0].resolvedValues.Name).toBe('Acme Target');
      expect(results[0].strategy).toBe('target_wins');
    });

    it('should resolve with newest values for newest_wins when target is newer', () => {
      const conflict = createConflict({
        sourceValues: { Name: 'Old', LastModifiedDate: '2026-01-01T00:00:00Z' },
        targetValues: { Name: 'New', LastModifiedDate: '2026-02-01T00:00:00Z' },
      });

      const results = resolver.resolve([conflict], 'newest_wins');

      expect(results[0].resolvedValues.Name).toBe('New');
    });

    it('should resolve with source values for newest_wins when source is newer', () => {
      const conflict = createConflict({
        sourceValues: { Name: 'New', LastModifiedDate: '2026-02-01T00:00:00Z' },
        targetValues: { Name: 'Old', LastModifiedDate: '2026-01-01T00:00:00Z' },
      });

      const results = resolver.resolve([conflict], 'newest_wins');

      expect(results[0].resolvedValues.Name).toBe('New');
    });

    it('should fall back to source for newest_wins when dates are missing', () => {
      const conflict = createConflict();
      const results = resolver.resolve([conflict], 'newest_wins');

      expect(results[0].resolvedValues.Name).toBe('Acme Source');
    });

    it('should merge non-null source values over target for merge strategy', () => {
      const conflict = createConflict({
        sourceValues: { Name: 'Source Name', Industry: null },
        targetValues: { Name: 'Target Name', Industry: 'Tech' },
        conflictFields: ['Name', 'Industry'],
      });

      const results = resolver.resolve([conflict], 'merge');

      expect(results[0].resolvedValues.Name).toBe('Source Name');
      expect(results[0].resolvedValues.Industry).toBe('Tech');
    });

    it('should use source values for manual strategy as default', () => {
      const results = resolver.resolve([createConflict()], 'manual');

      expect(results[0].resolvedValues.Name).toBe('Acme Source');
      expect(results[0].strategy).toBe('manual');
    });

    it('should respect per-conflict resolution override', () => {
      const conflict = createConflict({ resolution: 'target_wins' });
      const results = resolver.resolve([conflict], 'source_wins');

      expect(results[0].resolvedValues.Name).toBe('Acme Target');
      expect(results[0].strategy).toBe('target_wins');
    });

    it('should resolve multiple conflicts', () => {
      const conflicts = [
        createConflict({ recordId: 'EXT-001' }),
        createConflict({ recordId: 'EXT-002' }),
      ];
      const results = resolver.resolve(conflicts, 'source_wins');

      expect(results).toHaveLength(2);
      expect(results[0].recordId).toBe('EXT-001');
      expect(results[1].recordId).toBe('EXT-002');
    });

    it('should set recordId on resolved records', () => {
      const results = resolver.resolve([createConflict()], 'source_wins');

      expect(results[0].recordId).toBe('EXT-001');
    });
  });

  describe('detectConflicts', () => {
    it('should detect conflicting fields between matching records', () => {
      const source = [{ Id: '001', Name: 'Source', Industry: 'Tech' }];
      const target = [{ Id: '001', Name: 'Target', Industry: 'Tech' }];

      const conflicts = resolver.detectConflicts(source, target, 'Id');

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].conflictFields).toContain('Name');
      expect(conflicts[0].conflictFields).not.toContain('Industry');
    });

    it('should return empty array when no conflicts exist', () => {
      const source = [{ Id: '001', Name: 'Same', Industry: 'Tech' }];
      const target = [{ Id: '001', Name: 'Same', Industry: 'Tech' }];

      const conflicts = resolver.detectConflicts(source, target, 'Id');

      expect(conflicts).toHaveLength(0);
    });

    it('should not report conflicts for records only in source', () => {
      const source = [{ Id: '001', Name: 'Source Only' }];
      const target: Record<string, unknown>[] = [];

      const conflicts = resolver.detectConflicts(source, target, 'Id');

      expect(conflicts).toHaveLength(0);
    });

    it('should handle records matched by external ID field', () => {
      const source = [{ ExtId: 'EXT-001', Name: 'Source' }];
      const target = [{ ExtId: 'EXT-001', Name: 'Target' }];

      const conflicts = resolver.detectConflicts(source, target, 'ExtId');

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].recordId).toBe('EXT-001');
    });

    it('should extract only conflicting field values', () => {
      const source = [{ Id: '001', Name: 'A', Phone: '111' }];
      const target = [{ Id: '001', Name: 'B', Phone: '111' }];

      const conflicts = resolver.detectConflicts(source, target, 'Id');

      expect(conflicts[0].sourceValues).toEqual({ Name: 'A' });
      expect(conflicts[0].targetValues).toEqual({ Name: 'B' });
    });

    it('should skip records with empty match field', () => {
      const source = [{ Id: '', Name: 'No ID' }];
      const target = [{ Id: '', Name: 'No ID Either' }];

      const conflicts = resolver.detectConflicts(source, target, 'Id');

      expect(conflicts).toHaveLength(0);
    });
  });

  describe('resolvePerField', () => {
    it('should resolve all fields from source', () => {
      const conflict = createConflict({
        sourceValues: { Name: 'Source', Industry: 'Tech' },
        targetValues: { Name: 'Target', Industry: 'Finance' },
        conflictFields: ['Name', 'Industry'],
      });

      const resolutions: Record<string, FieldResolution> = {
        Name: { value: 'Source', source: 'source' },
        Industry: { value: 'Tech', source: 'source' },
      };

      const result = ConflictResolver.resolvePerField(conflict, resolutions);

      expect(result.Name).toBe('Source');
      expect(result.Industry).toBe('Tech');
    });

    it('should resolve all fields from target', () => {
      const conflict = createConflict({
        sourceValues: { Name: 'Source', Industry: 'Tech' },
        targetValues: { Name: 'Target', Industry: 'Finance' },
        conflictFields: ['Name', 'Industry'],
      });

      const resolutions: Record<string, FieldResolution> = {
        Name: { value: 'Target', source: 'target' },
        Industry: { value: 'Finance', source: 'target' },
      };

      const result = ConflictResolver.resolvePerField(conflict, resolutions);

      expect(result.Name).toBe('Target');
      expect(result.Industry).toBe('Finance');
    });

    it('should resolve with mixed source/target/manual choices', () => {
      const conflict = createConflict({
        sourceValues: { Name: 'Source', Industry: 'Tech', Phone: '111' },
        targetValues: { Name: 'Target', Industry: 'Finance', Phone: '222' },
        conflictFields: ['Name', 'Industry', 'Phone'],
      });

      const resolutions: Record<string, FieldResolution> = {
        Name: { value: 'Source', source: 'source' },
        Industry: { value: 'Finance', source: 'target' },
        Phone: { value: '333', source: 'manual' },
      };

      const result = ConflictResolver.resolvePerField(conflict, resolutions);

      expect(result.Name).toBe('Source');
      expect(result.Industry).toBe('Finance');
      expect(result.Phone).toBe('333');
    });

    it('should use manual edit values for manual source', () => {
      const conflict = createConflict({
        sourceValues: { Name: 'Source' },
        targetValues: { Name: 'Target' },
        conflictFields: ['Name'],
      });

      const resolutions: Record<string, FieldResolution> = {
        Name: { value: 'Custom Value', source: 'manual' },
      };

      const result = ConflictResolver.resolvePerField(conflict, resolutions);

      expect(result.Name).toBe('Custom Value');
    });

    it('should preserve non-conflict target fields as baseline', () => {
      const conflict = createConflict({
        sourceValues: { Name: 'Source' },
        targetValues: { Name: 'Target', Phone: '555', Industry: 'Tech' },
        conflictFields: ['Name'],
      });

      const resolutions: Record<string, FieldResolution> = {
        Name: { value: 'Source', source: 'source' },
      };

      const result = ConflictResolver.resolvePerField(conflict, resolutions);

      expect(result.Name).toBe('Source');
      expect(result.Phone).toBe('555');
      expect(result.Industry).toBe('Tech');
    });
  });
});
