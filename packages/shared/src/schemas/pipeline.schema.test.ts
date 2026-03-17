import { describe, it, expect } from 'vitest';

import { pipelineSchema, pipelineStepSchema, pipelineStepTypeEnum, pipelineTriggerSchema, pipelineTriggerTypeEnum, pipelineVariableSchema, pipelineVariableTypeEnum } from './pipeline.schema.js';

const VALID_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const VALID_UUID_2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

describe('pipelineSchema', () => {
  function createValidPipeline(): Record<string, unknown> {
    return {
      name: 'Account Seed Pipeline',
      steps: [
        {
          id: VALID_UUID,
          name: 'Seed Accounts',
          type: 'seed',
          config: { templateId: 'tpl-001' },
        },
      ],
      triggers: [
        {
          id: VALID_UUID_2,
          type: 'manual',
          enabled: true,
          config: {},
        },
      ],
      variables: [
        {
          name: 'recordCount',
          type: 'number',
          defaultValue: 100,
          required: false,
          description: 'Number of records to seed',
        },
      ],
    };
  }

  it('should parse a valid pipeline with defaults', () => {
    const result = pipelineSchema.parse(createValidPipeline());

    expect(result.name).toBe('Account Seed Pipeline');
    expect(result.description).toBe('');
    expect(result.version).toBe(1);
    expect(result.steps).toHaveLength(1);
    expect(result.triggers).toHaveLength(1);
    expect(result.variables).toHaveLength(1);
  });

  it('should preserve explicit values over defaults', () => {
    const result = pipelineSchema.parse({
      ...createValidPipeline(),
      description: 'Seeds accounts then syncs',
      version: 3,
    });

    expect(result.description).toBe('Seeds accounts then syncs');
    expect(result.version).toBe(3);
  });

  it('should reject empty name', () => {
    expect(() =>
      pipelineSchema.parse({ ...createValidPipeline(), name: '' }),
    ).toThrow();
  });

  it('should reject empty steps array', () => {
    expect(() =>
      pipelineSchema.parse({ ...createValidPipeline(), steps: [] }),
    ).toThrow();
  });

  it('should reject non-positive version', () => {
    expect(() =>
      pipelineSchema.parse({ ...createValidPipeline(), version: 0 }),
    ).toThrow();
  });

  it('should reject negative version', () => {
    expect(() =>
      pipelineSchema.parse({ ...createValidPipeline(), version: -1 }),
    ).toThrow();
  });

  it('should accept empty triggers and variables arrays', () => {
    const result = pipelineSchema.parse({
      ...createValidPipeline(),
      triggers: [],
      variables: [],
    });

    expect(result.triggers).toEqual([]);
    expect(result.variables).toEqual([]);
  });

  it('should reject missing required fields', () => {
    expect(() => pipelineSchema.parse({})).toThrow();
  });
});

describe('pipelineStepSchema', () => {
  it('should parse a valid step with defaults', () => {
    const result = pipelineStepSchema.parse({
      id: VALID_UUID,
      name: 'Seed Step',
      type: 'seed',
      config: { templateId: 'tpl-001' },
    });

    expect(result.id).toBe(VALID_UUID);
    expect(result.name).toBe('Seed Step');
    expect(result.type).toBe('seed');
    expect(result.continueOnError).toBe(false);
    expect(result.timeout).toBeUndefined();
    expect(result.retries).toBeUndefined();
  });

  it('should accept all valid step types', () => {
    const types = [
      'seed', 'sync', 'backup', 'restore', 'anonymize', 'delete', 'compare',
      'precheck', 'script', 'notification', 'approval', 'delay', 'condition',
      'loop', 'parallel',
    ] as const;

    for (const type of types) {
      const result = pipelineStepSchema.parse({
        id: VALID_UUID,
        name: 'Test Step',
        type,
        config: {},
      });

      expect(result.type).toBe(type);
    }
  });

  it('should accept timeout and retries', () => {
    const result = pipelineStepSchema.parse({
      id: VALID_UUID,
      name: 'Long Step',
      type: 'sync',
      config: {},
      continueOnError: true,
      timeout: 300000,
      retries: 3,
    });

    expect(result.continueOnError).toBe(true);
    expect(result.timeout).toBe(300000);
    expect(result.retries).toBe(3);
  });

  it('should reject non-UUID id', () => {
    expect(() =>
      pipelineStepSchema.parse({
        id: 'not-a-uuid',
        name: 'Step',
        type: 'seed',
        config: {},
      }),
    ).toThrow();
  });

  it('should reject negative timeout', () => {
    expect(() =>
      pipelineStepSchema.parse({
        id: VALID_UUID,
        name: 'Step',
        type: 'seed',
        config: {},
        timeout: -1,
      }),
    ).toThrow();
  });

  it('should reject negative retries', () => {
    expect(() =>
      pipelineStepSchema.parse({
        id: VALID_UUID,
        name: 'Step',
        type: 'seed',
        config: {},
        retries: -1,
      }),
    ).toThrow();
  });

  it('should reject invalid step type', () => {
    expect(() =>
      pipelineStepSchema.parse({
        id: VALID_UUID,
        name: 'Step',
        type: 'unknown_type',
        config: {},
      }),
    ).toThrow();
  });
});

describe('pipelineTriggerSchema', () => {
  it('should parse a valid trigger', () => {
    const result = pipelineTriggerSchema.parse({
      id: VALID_UUID,
      type: 'manual',
      enabled: true,
      config: {},
    });

    expect(result.type).toBe('manual');
    expect(result.enabled).toBe(true);
  });

  it('should accept all valid trigger types', () => {
    const types = [
      'manual', 'schedule', 'event', 'webhook',
      'sandbox_refresh', 'deployment_complete',
    ] as const;

    for (const type of types) {
      const result = pipelineTriggerSchema.parse({
        id: VALID_UUID,
        type,
        enabled: true,
        config: {},
      });

      expect(result.type).toBe(type);
    }
  });

  it('should accept trigger config with schedule cron', () => {
    const result = pipelineTriggerSchema.parse({
      id: VALID_UUID,
      type: 'schedule',
      enabled: true,
      config: { cron: '0 */6 * * *', timezone: 'UTC' },
    });

    expect(result.config).toEqual({ cron: '0 */6 * * *', timezone: 'UTC' });
  });

  it('should reject non-UUID id', () => {
    expect(() =>
      pipelineTriggerSchema.parse({
        id: 'invalid',
        type: 'manual',
        enabled: true,
        config: {},
      }),
    ).toThrow();
  });
});

describe('pipelineVariableSchema', () => {
  it('should parse a string variable', () => {
    const result = pipelineVariableSchema.parse({
      name: 'orgAlias',
      type: 'string',
      defaultValue: 'dev',
      required: true,
      description: 'Alias of the target org',
    });

    expect(result.name).toBe('orgAlias');
    expect(result.type).toBe('string');
    expect(result.defaultValue).toBe('dev');
    expect(result.required).toBe(true);
  });

  it('should parse a number variable', () => {
    const result = pipelineVariableSchema.parse({
      name: 'batchSize',
      type: 'number',
      defaultValue: 200,
      required: false,
      description: 'Records per batch',
    });

    expect(result.defaultValue).toBe(200);
  });

  it('should parse a boolean variable', () => {
    const result = pipelineVariableSchema.parse({
      name: 'dryRun',
      type: 'boolean',
      defaultValue: false,
      required: false,
      description: 'Simulate without writing',
    });

    expect(result.defaultValue).toBe(false);
  });

  it('should accept all variable types', () => {
    const types = ['string', 'number', 'boolean', 'secret'] as const;

    for (const type of types) {
      const result = pipelineVariableSchema.parse({
        name: 'testVar',
        type,
        required: false,
        description: 'Test',
      });

      expect(result.type).toBe(type);
    }
  });

  it('should accept variable without defaultValue', () => {
    const result = pipelineVariableSchema.parse({
      name: 'requiredVar',
      type: 'string',
      required: true,
      description: 'Must be provided at runtime',
    });

    expect(result.defaultValue).toBeUndefined();
  });

  it('should reject empty name', () => {
    expect(() =>
      pipelineVariableSchema.parse({
        name: '',
        type: 'string',
        required: false,
        description: 'Desc',
      }),
    ).toThrow();
  });
});

describe('pipelineStepTypeEnum alignment with PipelineStepType', () => {
  it('should accept all PipelineStepType values', () => {
    const types = ['seed','sync','backup','restore','anonymize','delete','compare','precheck','script','notification','approval','delay','condition','loop','parallel'];
    for (const t of types) {
      expect(pipelineStepTypeEnum.safeParse(t).success).toBe(true);
    }
  });
  it('should reject removed values', () => {
    expect(pipelineStepTypeEnum.safeParse('query').success).toBe(false);
    expect(pipelineStepTypeEnum.safeParse('transform').success).toBe(false);
    expect(pipelineStepTypeEnum.safeParse('validate').success).toBe(false);
    expect(pipelineStepTypeEnum.safeParse('wait').success).toBe(false);
  });
});

describe('pipelineTriggerTypeEnum alignment with TriggerType', () => {
  it('should accept all TriggerType values', () => {
    const types = ['manual','schedule','event','webhook','sandbox_refresh','deployment_complete'];
    for (const t of types) {
      expect(pipelineTriggerTypeEnum.safeParse(t).success).toBe(true);
    }
  });
  it('should reject removed values', () => {
    expect(pipelineTriggerTypeEnum.safeParse('on_connect').success).toBe(false);
    expect(pipelineTriggerTypeEnum.safeParse('on_seed_complete').success).toBe(false);
  });
});

describe('pipelineVariableTypeEnum alignment with PipelineVariable.type', () => {
  it('should accept secret', () => {
    expect(pipelineVariableTypeEnum.safeParse('secret').success).toBe(true);
  });
  it('should reject removed values', () => {
    expect(pipelineVariableTypeEnum.safeParse('date').success).toBe(false);
    expect(pipelineVariableTypeEnum.safeParse('json').success).toBe(false);
  });
});
