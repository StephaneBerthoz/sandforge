import { describe, it, expect, beforeEach } from 'vitest';
import { PipelineVersioning } from './PipelineVersioning';

describe('PipelineVersioning', () => {
  let versioning: PipelineVersioning;

  beforeEach(() => {
    versioning = new PipelineVersioning();
  });

  describe('saveVersion', () => {
    it('should save a version with auto-incremented version number', () => {
      const v1 = versioning.saveVersion('pipeline-1', { steps: ['A'] });
      const v2 = versioning.saveVersion('pipeline-1', { steps: ['A', 'B'] });

      expect(v1.version).toBe(1);
      expect(v2.version).toBe(2);
    });

    it('should assign a unique versionId', () => {
      const v1 = versioning.saveVersion('pipeline-1', { name: 'Test' });
      expect(v1.versionId).toBeDefined();
      expect(v1.versionId).toHaveLength(36);
    });

    it('should deep-clone the config to prevent external mutation', () => {
      const config = { steps: [{ name: 'A' }] };
      versioning.saveVersion('pipeline-1', config);

      (config.steps[0] as Record<string, unknown>).name = 'Modified';

      const retrieved = versioning.getVersion('pipeline-1', 1);
      expect((retrieved!.config['steps'] as Array<Record<string, unknown>>)[0].name).toBe('A');
    });

    it('should store metadata (tag, annotation, createdBy)', () => {
      const version = versioning.saveVersion('pipeline-1', { name: 'Test' }, {
        tag: 'v1.0',
        annotation: 'Initial release',
        createdBy: 'alice',
      });

      expect(version.tag).toBe('v1.0');
      expect(version.annotation).toBe('Initial release');
      expect(version.createdBy).toBe('alice');
    });

    it('should set createdAt to a valid ISO timestamp', () => {
      const version = versioning.saveVersion('pipeline-1', { name: 'Test' });
      expect(() => new Date(version.createdAt)).not.toThrow();
      expect(new Date(version.createdAt).toISOString()).toBe(version.createdAt);
    });
  });

  describe('listVersions', () => {
    it('should list all versions for a pipeline in order', () => {
      versioning.saveVersion('pipeline-1', { v: 1 });
      versioning.saveVersion('pipeline-1', { v: 2 });
      versioning.saveVersion('pipeline-1', { v: 3 });

      const versions = versioning.listVersions('pipeline-1');
      expect(versions).toHaveLength(3);
      expect(versions[0].version).toBe(1);
      expect(versions[1].version).toBe(2);
      expect(versions[2].version).toBe(3);
    });

    it('should return empty array for unknown pipeline', () => {
      expect(versioning.listVersions('unknown')).toEqual([]);
    });

    it('should not mix versions from different pipelines', () => {
      versioning.saveVersion('pipeline-1', { name: 'P1' });
      versioning.saveVersion('pipeline-2', { name: 'P2' });

      const p1Versions = versioning.listVersions('pipeline-1');
      const p2Versions = versioning.listVersions('pipeline-2');

      expect(p1Versions).toHaveLength(1);
      expect(p2Versions).toHaveLength(1);
      expect(p1Versions[0].pipelineId).toBe('pipeline-1');
      expect(p2Versions[0].pipelineId).toBe('pipeline-2');
    });
  });

  describe('getVersion', () => {
    it('should retrieve a specific version by number', () => {
      versioning.saveVersion('pipeline-1', { v: 1 });
      versioning.saveVersion('pipeline-1', { v: 2 });

      const version = versioning.getVersion('pipeline-1', 2);
      expect(version).toBeDefined();
      expect(version!.version).toBe(2);
      expect(version!.config).toEqual({ v: 2 });
    });

    it('should return undefined for non-existent version number', () => {
      versioning.saveVersion('pipeline-1', { v: 1 });
      expect(versioning.getVersion('pipeline-1', 99)).toBeUndefined();
    });

    it('should return undefined for unknown pipeline', () => {
      expect(versioning.getVersion('unknown', 1)).toBeUndefined();
    });
  });

  describe('getLatest', () => {
    it('should return the latest version', () => {
      versioning.saveVersion('pipeline-1', { name: 'First' });
      versioning.saveVersion('pipeline-1', { name: 'Second' });
      versioning.saveVersion('pipeline-1', { name: 'Third' });

      const latest = versioning.getLatest('pipeline-1');
      expect(latest).toBeDefined();
      expect(latest!.version).toBe(3);
      expect(latest!.config).toEqual({ name: 'Third' });
    });

    it('should return undefined for unknown pipeline', () => {
      expect(versioning.getLatest('unknown')).toBeUndefined();
    });
  });

  describe('diff', () => {
    it('should detect added keys', () => {
      versioning.saveVersion('pipeline-1', { name: 'Test' });
      versioning.saveVersion('pipeline-1', { name: 'Test', newField: 'value' });

      const result = versioning.diff('pipeline-1', 1, 2);
      expect(result).toBeDefined();
      expect(result!.added).toContain('newField');
      expect(result!.removed).toEqual([]);
    });

    it('should detect removed keys', () => {
      versioning.saveVersion('pipeline-1', { name: 'Test', oldField: 'value' });
      versioning.saveVersion('pipeline-1', { name: 'Test' });

      const result = versioning.diff('pipeline-1', 1, 2);
      expect(result).toBeDefined();
      expect(result!.removed).toContain('oldField');
      expect(result!.added).toEqual([]);
    });

    it('should detect modified values', () => {
      versioning.saveVersion('pipeline-1', { name: 'Old' });
      versioning.saveVersion('pipeline-1', { name: 'New' });

      const result = versioning.diff('pipeline-1', 1, 2);
      expect(result).toBeDefined();
      expect(result!.modified).toHaveLength(1);
      expect(result!.modified[0]).toEqual({ path: 'name', old: 'Old', new: 'New' });
    });

    it('should handle nested key changes', () => {
      versioning.saveVersion('pipeline-1', { settings: { timeout: 30 } });
      versioning.saveVersion('pipeline-1', { settings: { timeout: 60 } });

      const result = versioning.diff('pipeline-1', 1, 2);
      expect(result).toBeDefined();
      expect(result!.modified).toHaveLength(1);
      expect(result!.modified[0].path).toBe('settings.timeout');
    });

    it('should return empty diff for identical configs', () => {
      versioning.saveVersion('pipeline-1', { name: 'Same', count: 5 });
      versioning.saveVersion('pipeline-1', { name: 'Same', count: 5 });

      const result = versioning.diff('pipeline-1', 1, 2);
      expect(result).toBeDefined();
      expect(result!.added).toEqual([]);
      expect(result!.removed).toEqual([]);
      expect(result!.modified).toEqual([]);
    });

    it('should return undefined if either version is not found', () => {
      versioning.saveVersion('pipeline-1', { name: 'Test' });

      expect(versioning.diff('pipeline-1', 1, 99)).toBeUndefined();
      expect(versioning.diff('pipeline-1', 99, 1)).toBeUndefined();
      expect(versioning.diff('unknown', 1, 2)).toBeUndefined();
    });
  });

  describe('rollback', () => {
    it('should create a new version with the config of the target version', () => {
      versioning.saveVersion('pipeline-1', { name: 'V1 Config' });
      versioning.saveVersion('pipeline-1', { name: 'V2 Config' });

      const rolled = versioning.rollback('pipeline-1', 1);
      expect(rolled).toBeDefined();
      expect(rolled!.version).toBe(3);
      expect(rolled!.config).toEqual({ name: 'V1 Config' });
    });

    it('should set rollback annotation', () => {
      versioning.saveVersion('pipeline-1', { name: 'Original' });
      versioning.saveVersion('pipeline-1', { name: 'Changed' });

      const rolled = versioning.rollback('pipeline-1', 1);
      expect(rolled!.annotation).toBe('Rollback to version 1');
    });

    it('should return undefined if target version does not exist', () => {
      versioning.saveVersion('pipeline-1', { name: 'V1' });
      expect(versioning.rollback('pipeline-1', 99)).toBeUndefined();
    });

    it('should return undefined for unknown pipeline', () => {
      expect(versioning.rollback('unknown', 1)).toBeUndefined();
    });

    it('should allow further versioning after rollback', () => {
      versioning.saveVersion('pipeline-1', { v: 1 });
      versioning.saveVersion('pipeline-1', { v: 2 });
      versioning.rollback('pipeline-1', 1);
      const v4 = versioning.saveVersion('pipeline-1', { v: 4 });

      expect(v4.version).toBe(4);
      expect(versioning.listVersions('pipeline-1')).toHaveLength(4);
    });
  });

  describe('tagVersion', () => {
    it('should tag an existing version', () => {
      versioning.saveVersion('pipeline-1', { name: 'Test' });

      const result = versioning.tagVersion('pipeline-1', 1, 'stable');
      expect(result).toBe(true);

      const version = versioning.getVersion('pipeline-1', 1);
      expect(version!.tag).toBe('stable');
    });

    it('should overwrite an existing tag', () => {
      versioning.saveVersion('pipeline-1', { name: 'Test' }, { tag: 'draft' });

      versioning.tagVersion('pipeline-1', 1, 'release');

      const version = versioning.getVersion('pipeline-1', 1);
      expect(version!.tag).toBe('release');
    });

    it('should return false for non-existent version', () => {
      expect(versioning.tagVersion('pipeline-1', 99, 'tag')).toBe(false);
    });

    it('should return false for unknown pipeline', () => {
      expect(versioning.tagVersion('unknown', 1, 'tag')).toBe(false);
    });
  });
});
