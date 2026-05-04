import { describe, it, expect, beforeEach } from 'vitest';
import { PipelineBuilder } from './PipelineBuilder';
import type { PipelineDefinition } from '@sandforge/shared';

describe('PipelineBuilder', () => {
  let builder: PipelineBuilder;

  beforeEach(() => {
    builder = new PipelineBuilder();
  });

  describe('create', () => {
    it('should create a pipeline with a generated ID', () => {
      const pipeline = builder.create('My Pipeline', 'A test pipeline');

      expect(pipeline.id).toBeDefined();
      expect(pipeline.id).toHaveLength(36);
      expect(pipeline.name).toBe('My Pipeline');
      expect(pipeline.description).toBe('A test pipeline');
    });

    it('should create a pipeline with empty steps, triggers, and variables', () => {
      const pipeline = builder.create('Test', 'Desc');

      expect(pipeline.steps).toEqual([]);
      expect(pipeline.triggers).toEqual([]);
      expect(pipeline.variables).toEqual([]);
      expect(pipeline.tags).toEqual([]);
      expect(pipeline.version).toBe(1);
    });
  });

  describe('addStep', () => {
    it('should append a step with a generated ID', () => {
      const pipeline = builder.create('Test', 'Desc');
      const updated = builder.addStep(pipeline, {
        name: 'Step 1',
        type: 'seed',
        config: {},
        continueOnError: false,
      });

      expect(updated.steps).toHaveLength(1);
      expect(updated.steps[0].id).toBeDefined();
      expect(updated.steps[0].name).toBe('Step 1');
      expect(updated.steps[0].type).toBe('seed');
    });

    it('should not mutate the original pipeline', () => {
      const pipeline = builder.create('Test', 'Desc');
      builder.addStep(pipeline, {
        name: 'Step 1',
        type: 'seed',
        config: {},
        continueOnError: false,
      });

      expect(pipeline.steps).toHaveLength(0);
    });
  });

  describe('removeStep', () => {
    it('should remove a step by its ID', () => {
      let pipeline = builder.create('Test', 'Desc');
      pipeline = builder.addStep(pipeline, {
        name: 'Step 1',
        type: 'seed',
        config: {},
        continueOnError: false,
      });
      const stepId = pipeline.steps[0].id;
      const updated = builder.removeStep(pipeline, stepId);

      expect(updated.steps).toHaveLength(0);
    });

    it('should return unchanged pipeline if step ID not found', () => {
      let pipeline = builder.create('Test', 'Desc');
      pipeline = builder.addStep(pipeline, {
        name: 'Step 1',
        type: 'seed',
        config: {},
        continueOnError: false,
      });
      const updated = builder.removeStep(pipeline, 'non-existent');

      expect(updated.steps).toHaveLength(1);
    });
  });

  describe('moveStep', () => {
    it('should move a step to the specified index', () => {
      let pipeline = builder.create('Test', 'Desc');
      pipeline = builder.addStep(pipeline, {
        name: 'A',
        type: 'seed',
        config: {},
        continueOnError: false,
      });
      pipeline = builder.addStep(pipeline, {
        name: 'B',
        type: 'sync',
        config: {},
        continueOnError: false,
      });
      pipeline = builder.addStep(pipeline, {
        name: 'C',
        type: 'backup',
        config: {},
        continueOnError: false,
      });

      const stepId = pipeline.steps[2].id;
      const updated = builder.moveStep(pipeline, stepId, 0);

      expect(updated.steps[0].name).toBe('C');
      expect(updated.steps[1].name).toBe('A');
      expect(updated.steps[2].name).toBe('B');
    });

    it('should return unchanged pipeline if step ID not found', () => {
      const pipeline = builder.create('Test', 'Desc');
      const updated = builder.moveStep(pipeline, 'non-existent', 0);

      expect(updated).toBe(pipeline);
    });
  });

  describe('addTrigger', () => {
    it('should append a trigger with a generated ID', () => {
      const pipeline = builder.create('Test', 'Desc');
      const updated = builder.addTrigger(pipeline, {
        type: 'schedule',
        enabled: true,
        config: { cron: '0 0 * * *' },
      });

      expect(updated.triggers).toHaveLength(1);
      expect(updated.triggers[0].id).toBeDefined();
      expect(updated.triggers[0].type).toBe('schedule');
    });
  });

  describe('removeTrigger', () => {
    it('should remove a trigger by its ID', () => {
      let pipeline = builder.create('Test', 'Desc');
      pipeline = builder.addTrigger(pipeline, {
        type: 'manual',
        enabled: true,
        config: {},
      });
      const triggerId = pipeline.triggers[0].id;
      const updated = builder.removeTrigger(pipeline, triggerId);

      expect(updated.triggers).toHaveLength(0);
    });
  });

  describe('addVariable', () => {
    it('should append a variable to the pipeline', () => {
      const pipeline = builder.create('Test', 'Desc');
      const updated = builder.addVariable(pipeline, {
        name: 'orgId',
        type: 'string',
        required: true,
        description: 'Target org ID',
        defaultValue: 'default-org',
      });

      expect(updated.variables).toHaveLength(1);
      expect(updated.variables[0].name).toBe('orgId');
    });
  });

  describe('validate', () => {
    it('should return error for empty name', () => {
      const pipeline = builder.create('', 'Desc');
      const errors = builder.validate(pipeline);

      expect(errors).toContain('Pipeline name is required');
    });

    it('should return error for no steps', () => {
      const pipeline = builder.create('Test', 'Desc');
      const errors = builder.validate(pipeline);

      expect(errors).toContain('Pipeline must have at least one step');
    });

    it('should return error for schedule trigger without cron', () => {
      let pipeline = builder.create('Test', 'Desc');
      pipeline = builder.addStep(pipeline, {
        name: 'S1',
        type: 'seed',
        config: {},
        continueOnError: false,
      });
      pipeline = builder.addTrigger(pipeline, { type: 'schedule', enabled: true, config: {} });
      const errors = builder.validate(pipeline);

      expect(errors.some((e) => e.includes('cron expression'))).toBe(true);
    });

    it('should return empty array for a valid pipeline', () => {
      let pipeline = builder.create('Valid', 'Valid pipeline');
      pipeline = builder.addStep(pipeline, {
        name: 'Step',
        type: 'seed',
        config: {},
        continueOnError: false,
      });
      const errors = builder.validate(pipeline);

      expect(errors).toHaveLength(0);
    });
  });

  describe('clone', () => {
    it('should produce a deep copy with new IDs', () => {
      let pipeline = builder.create('Original', 'Desc');
      pipeline = builder.addStep(pipeline, {
        name: 'S1',
        type: 'seed',
        config: { key: 'val' },
        continueOnError: false,
      });
      pipeline = builder.addTrigger(pipeline, { type: 'manual', enabled: true, config: {} });

      const cloned = builder.clone(pipeline);

      expect(cloned.id).not.toBe(pipeline.id);
      expect(cloned.steps[0].id).not.toBe(pipeline.steps[0].id);
      expect(cloned.triggers[0].id).not.toBe(pipeline.triggers[0].id);
      expect(cloned.name).toBe(pipeline.name);
      expect(cloned.steps[0].name).toBe(pipeline.steps[0].name);
    });

    it('should remap onSuccess/onFailure references in cloned steps', () => {
      let pipeline = builder.create('Test', 'Desc');
      pipeline = builder.addStep(pipeline, {
        name: 'S1',
        type: 'seed',
        config: {},
        continueOnError: false,
      });
      pipeline = builder.addStep(pipeline, {
        name: 'S2',
        type: 'sync',
        config: {},
        continueOnError: false,
      });

      const s1Id = pipeline.steps[0].id;
      const s2Id = pipeline.steps[1].id;

      const mutated: PipelineDefinition = {
        ...pipeline,
        steps: pipeline.steps.map((s) => {
          if (s.id === s1Id) {
            return { ...s, onSuccess: s2Id };
          }
          return s;
        }),
      };

      const cloned = builder.clone(mutated);

      expect(cloned.steps[0].onSuccess).toBeDefined();
      expect(cloned.steps[0].onSuccess).not.toBe(s2Id);
      expect(cloned.steps[0].onSuccess).toBe(cloned.steps[1].id);
    });
  });
});
