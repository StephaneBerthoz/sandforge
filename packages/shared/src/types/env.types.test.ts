import { describe, it, expect, expectTypeOf } from 'vitest';
import type * as z from 'zod';

import type {
  EnvAction,
  EnvActionKind,
  EnvFile,
  EnvPlan,
  EnvResource,
  EnvResourceKind,
  EnvResourceState,
  EnvResourceStatus,
  EnvRefusalAnswer,
  EnvRun,
  EnvRunResult,
  EnvScript,
  EnvSeedResource,
  EnvState,
  EnvStateList,
  EnvStateListEntry,
  EnvStepPhase,
  EnvStepResult,
  EnvTargetKind,
  EnvValidation,
} from './env.types.js';
import {
  envActionKindSchema,
  envActionSchema,
  envFileSchema,
  envPlanSchema,
  envRefusalAnswerSchema,
  envResourceKindSchema,
  envResourceSchema,
  envResourceStateSchema,
  envResourceStatusSchema,
  envRunResultSchema,
  envRunSchema,
  envScriptSchema,
  envSeedResourceSchema,
  envStateListEntrySchema,
  envStateListSchema,
  envStateSchema,
  envStepPhaseSchema,
  envStepResultSchema,
  envTargetKindSchema,
  envValidationSchema,
} from '../schemas/env.schema.js';

/*
 * These assertions are read by the type checker (`tsc -p tsconfig.test.json`),
 * which fails on the first one that no longer holds: a field the interface
 * declares and the schema does not read would be written to a state that its
 * own writer then refuses as damaged.
 */

describe('the file and its schema', () => {
  it('reads exactly the shape EnvFile declares, defaults in place', () => {
    expectTypeOf<z.infer<typeof envFileSchema>>().toEqualTypeOf<EnvFile>();
    expectTypeOf<z.infer<typeof envResourceSchema>>().toEqualTypeOf<EnvResource>();
    expectTypeOf<z.infer<typeof envSeedResourceSchema>>().toEqualTypeOf<EnvSeedResource>();
    expectTypeOf<EnvFile['version']>().toEqualTypeOf<1>();
    expectTypeOf<EnvFile['targets']['kinds']>().toEqualTypeOf<EnvTargetKind[]>();
  });

  it('reads the closed lists the types declare, value for value', () => {
    expectTypeOf<z.infer<typeof envTargetKindSchema>>().toEqualTypeOf<EnvTargetKind>();
    expect(envTargetKindSchema.options).toEqual(['scratch', 'developer', 'sandbox']);
  });
});

describe('the state and its schema', () => {
  it('reads exactly the shape EnvState declares', () => {
    expectTypeOf<z.infer<typeof envStateSchema>>().toEqualTypeOf<EnvState>();
    expectTypeOf<z.infer<typeof envResourceStateSchema>>().toEqualTypeOf<EnvResourceState>();
    expectTypeOf<z.infer<typeof envRunSchema>>().toEqualTypeOf<EnvRun>();
    expectTypeOf<EnvState['version']>().toEqualTypeOf<1>();
  });

  it('reads the closed lists the types declare, value for value', () => {
    expectTypeOf<z.infer<typeof envResourceKindSchema>>().toEqualTypeOf<EnvResourceKind>();
    expectTypeOf<z.infer<typeof envScriptSchema>>().toEqualTypeOf<EnvScript>();
    expectTypeOf<z.infer<typeof envResourceStatusSchema>>().toEqualTypeOf<EnvResourceStatus>();
    expect(envResourceStatusSchema.options).toEqual([
      'applying',
      'applied',
      'partial',
      'failed',
      'destroying',
      'destroyed',
    ]);
  });
});

describe('the plan and the steps, and their schemas', () => {
  it('reads exactly the shapes EnvPlan, EnvAction, EnvStepResult and EnvRunResult declare', () => {
    expectTypeOf<z.infer<typeof envPlanSchema>>().toEqualTypeOf<EnvPlan>();
    expectTypeOf<z.infer<typeof envActionSchema>>().toEqualTypeOf<EnvAction>();
    expectTypeOf<z.infer<typeof envStepResultSchema>>().toEqualTypeOf<EnvStepResult>();
    expectTypeOf<z.infer<typeof envRunResultSchema>>().toEqualTypeOf<EnvRunResult>();
  });

  it('reads the closed lists the types declare, value for value', () => {
    expectTypeOf<z.infer<typeof envActionKindSchema>>().toEqualTypeOf<EnvActionKind>();
    expectTypeOf<z.infer<typeof envStepPhaseSchema>>().toEqualTypeOf<EnvStepPhase>();
    expect(envActionKindSchema.options).toEqual([
      'create',
      'keep',
      'replace',
      'delete',
      'drifted',
      'blocked',
    ]);
  });
});

describe('what the other verbs answer, and their schemas', () => {
  it('reads exactly the shapes the refusal, validate and state answers declare', () => {
    expectTypeOf<z.infer<typeof envRefusalAnswerSchema>>().toEqualTypeOf<EnvRefusalAnswer>();
    expectTypeOf<z.infer<typeof envValidationSchema>>().toEqualTypeOf<EnvValidation>();
    expectTypeOf<z.infer<typeof envStateListEntrySchema>>().toEqualTypeOf<EnvStateListEntry>();
    expectTypeOf<z.infer<typeof envStateListSchema>>().toEqualTypeOf<EnvStateList>();
  });
});
