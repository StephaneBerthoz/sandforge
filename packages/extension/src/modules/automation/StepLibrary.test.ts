import { describe, it, expect, beforeEach } from 'vitest';
import { StepLibrary } from './StepLibrary';
import {
  PIPELINE_STEP_TYPES,
  pipelineCheckpointStepConfigSchema,
  pipelineRewindStepConfigSchema,
} from '@sandforge/shared';
import type { PipelineStepType } from '@sandforge/shared';

describe('StepLibrary', () => {
  let library: StepLibrary;

  beforeEach(() => {
    library = new StepLibrary();
  });

  describe('getStepTypes', () => {
    it('should return all 14 step types', () => {
      const types = library.getStepTypes();
      expect(types).toHaveLength(14);
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
        'checkpoint',
        'rewind',
        'compare',
        'precheck',
        'condition',
        'delay',
        'approval',
        'notification',
      ];

      for (const e of expected) {
        expect(typeValues).toContain(e);
      }
    });

    it('lists none of the step types SandForge no longer has', () => {
      const typeValues: string[] = library.getStepTypes().map((t) => t.type);
      for (const retired of ['script', 'loop', 'parallel']) {
        expect(typeValues).not.toContain(retired);
      }
    });

    it('lists every step type there is, each once', () => {
      const typeValues = library.getStepTypes().map((t) => t.type);
      expect([...typeValues].sort()).toEqual([...PIPELINE_STEP_TYPES].sort());
    });

    it('gives a Rewind step the defaults its schema reads, and no bound on records', () => {
      // Every acceptance off and the refusal while people are active on, as
      // `pipelineRewindStepConfigSchema` reads a configuration that says
      // nothing of them; `maxRecords` is the step's to be given.
      const config = library.getDefaultConfig('rewind');
      expect(config).toEqual({
        orgId: '',
        checkpointId: '',
        acceptAutomation: false,
        acceptNoUndo: false,
        acceptRecreate: false,
        acceptOutside: false,
        acceptUnseen: false,
        refuseWhenActive: true,
      });
      expect(pipelineRewindStepConfigSchema.safeParse({ ...config, maxRecords: 1 }).success).toBe(
        false,
      );
      const read = pipelineRewindStepConfigSchema.parse({
        orgId: 'org-1',
        checkpointId: 'ck-20261030-020000-abcd',
        maxRecords: 1,
      });
      for (const key of Object.keys(config).filter((key) => key.startsWith('accept'))) {
        expect(read[key as keyof typeof read]).toBe(config[key]);
      }
      expect(read.refuseWhenActive).toBe(config['refuseWhenActive']);
    });

    it('gives a Checkpoint step the defaults a take on the page has, and none of the keys that come with picked', () => {
      const config = library.getDefaultConfig('checkpoint');
      expect(config).toEqual({ orgId: '', mode: 'everything', keepDays: 30 });
      expect(
        pipelineCheckpointStepConfigSchema.safeParse({ ...config, orgId: 'org-1' }).success,
      ).toBe(true);
    });

    it('says none of the steps that run in a pipeline is not runnable there', () => {
      for (const type of ['seed', 'anonymize', 'checkpoint', 'rewind'] as const) {
        expect(library.getStepType(type)?.description).not.toMatch(/yet|not runnable/i);
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

      expect(config).toEqual({ orgId: '', templateId: '' });
    });

    it('should return an empty array for array schema fields', () => {
      const config = library.getDefaultConfig('backup');
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
        orgId: 'org-1',
        templateId: 'prebuilt-sales',
      });
      expect(errors).toHaveLength(0);
    });

    it('should return error for wrong type on a field', () => {
      const errors = library.validateStepConfig('seed', {
        orgId: 'org-1',
        templateId: 123,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('templateId');
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
      const controlSteps: PipelineStepType[] = ['condition', 'delay', 'approval'];
      for (const type of controlSteps) {
        const info = library.getStepType(type);
        expect(info?.category).toBe('control');
      }
    });
  });
});
