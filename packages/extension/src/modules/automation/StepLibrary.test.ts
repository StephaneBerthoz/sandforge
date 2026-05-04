import { describe, it, expect, beforeEach } from 'vitest';
import { StepLibrary } from './StepLibrary';
import type { PipelineStepType } from '@sandforge/shared';

describe('StepLibrary', () => {
  let library: StepLibrary;

  beforeEach(() => {
    library = new StepLibrary();
  });

  describe('getStepTypes', () => {
    it('should return all 15 step types', () => {
      const types = library.getStepTypes();
      expect(types).toHaveLength(15);
    });

    it('should include all expected step type values', () => {
      const types = library.getStepTypes();
      const typeValues = types.map((t) => t.type);

      const expected: PipelineStepType[] = [
        'seed',
        'sync',
        'backup',
        'restore',
        'anonymize',
        'delete',
        'compare',
        'precheck',
        'condition',
        'loop',
        'parallel',
        'delay',
        'approval',
        'script',
        'notification',
      ];

      for (const e of expected) {
        expect(typeValues).toContain(e);
      }
    });
  });

  describe('getStepType', () => {
    it('should return info for a known step type', () => {
      const info = library.getStepType('seed');

      expect(info).toBeDefined();
      expect(info!.type).toBe('seed');
      expect(info!.label).toBe('Seed Data');
      expect(info!.category).toBe('data');
    });

    it('should return undefined for an unknown step type', () => {
      const info = library.getStepType('unknown' as PipelineStepType);
      expect(info).toBeUndefined();
    });
  });

  describe('getDefaultConfig', () => {
    it('should return default values matching the schema types', () => {
      const config = library.getDefaultConfig('seed');

      expect(config).toHaveProperty('objectName', '');
      expect(config).toHaveProperty('count', 0);
    });

    it('should return an empty array for array schema fields', () => {
      const config = library.getDefaultConfig('sync');
      expect(config['objects']).toEqual([]);
    });

    it('should return empty object for unknown step type', () => {
      const config = library.getDefaultConfig('unknown' as PipelineStepType);
      expect(config).toEqual({});
    });
  });

  describe('validateStepConfig', () => {
    it('should return empty array for a valid config', () => {
      const errors = library.validateStepConfig('seed', {
        objectName: 'Account',
        count: 100,
      });
      expect(errors).toHaveLength(0);
    });

    it('should return error for wrong type on a field', () => {
      const errors = library.validateStepConfig('seed', {
        objectName: 123,
        count: 100,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('objectName');
      expect(errors[0]).toContain('string');
    });

    it('should return error for unknown step type', () => {
      const errors = library.validateStepConfig('unknown' as PipelineStepType, {});
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Unknown step type');
    });

    it('should skip validation for undefined/null fields', () => {
      const errors = library.validateStepConfig('seed', {});
      expect(errors).toHaveLength(0);
    });
  });

  describe('getStepCategories', () => {
    it('should return all four categories', () => {
      const categories = library.getStepCategories();

      expect(categories).toContain('data');
      expect(categories).toContain('control');
      expect(categories).toContain('notification');
      expect(categories).toContain('quality');
      expect(categories).toHaveLength(4);
    });
  });

  describe('category assignments', () => {
    it('should assign data category to data-related steps', () => {
      const dataSteps: PipelineStepType[] = [
        'seed',
        'sync',
        'backup',
        'restore',
        'anonymize',
        'delete',
      ];
      for (const type of dataSteps) {
        const info = library.getStepType(type);
        expect(info?.category).toBe('data');
      }
    });

    it('should assign quality category to quality-related steps', () => {
      const qualitySteps: PipelineStepType[] = ['compare', 'precheck'];
      for (const type of qualitySteps) {
        const info = library.getStepType(type);
        expect(info?.category).toBe('quality');
      }
    });

    it('should assign control category to control-related steps', () => {
      const controlSteps: PipelineStepType[] = [
        'condition',
        'loop',
        'parallel',
        'delay',
        'approval',
        'script',
      ];
      for (const type of controlSteps) {
        const info = library.getStepType(type);
        expect(info?.category).toBe('control');
      }
    });
  });
});
