import { describe, it, expect } from 'vitest';
import type { PipelineStep, PipelineStepType } from '@sandforge/shared';
import { blockedSteps, stepBlocker, typeBlocker } from './stepRunnability';

function step(type: PipelineStepType, config: Record<string, unknown> = {}): PipelineStep {
  return { id: `id-${type}`, name: `name-${type}`, type, config, continueOnError: false };
}

/** The thirteen step types the extension has no handler for. */
const REFUSED_BY_THE_EXTENSION: PipelineStepType[] = [
  'seed',
  'sync',
  'backup',
  'restore',
  'anonymize',
  'delete',
  'compare',
  'precheck',
  'script',
  'notification',
  'approval',
  'loop',
  'parallel',
];

describe('typeBlocker', () => {
  it('lets Delay run and nothing else', () => {
    expect(typeBlocker('delay')).toBeUndefined();
    for (const type of REFUSED_BY_THE_EXTENSION) {
      expect(typeBlocker(type)).toBe('typeCannotRun');
    }
  });

  it('gives Condition its own reason: nothing here sets its condition or its variables', () => {
    expect(typeBlocker('condition')).toBe('conditionCannotRun');
  });

  it('blocks a type the page has never heard of, as the Marketplace may name one', () => {
    expect(typeBlocker('dataops:backup')).toBe('typeCannotRun');
  });
});

describe('stepBlocker', () => {
  it('lets a Delay step run once it has its seconds', () => {
    expect(stepBlocker(step('delay', { seconds: 30 }))).toBeUndefined();
    expect(stepBlocker(step('delay', { seconds: 0 }))).toBeUndefined();
  });

  it('reads durationMs when seconds is absent, as the extension does', () => {
    expect(stepBlocker(step('delay', { durationMs: 1500 }))).toBeUndefined();
  });

  it.each([
    ['no duration at all', {}],
    ['negative seconds', { seconds: -1 }],
    ['seconds as text', { seconds: '30' }],
    ['seconds that are not finite', { seconds: Number.NaN }],
    ['a wait past 24 days', { seconds: 24 * 24 * 60 * 60 + 1 }],
    ['a negative durationMs', { durationMs: -1 }],
  ])('asks a Delay step for its seconds when it has %s', (_label, config) => {
    expect(stepBlocker(step('delay', config))).toBe('delayNeedsSeconds');
  });

  it('keeps the type reason ahead of any configuration', () => {
    expect(stepBlocker(step('seed', { seconds: 30 }))).toBe('typeCannotRun');
  });
});

describe('blockedSteps', () => {
  it('names each step that keeps the pipeline from running, in order, and no other', () => {
    const steps = [step('delay', { seconds: 5 }), step('seed'), step('delay'), step('condition')];

    expect(blockedSteps(steps)).toEqual([
      { stepId: 'id-seed', stepName: 'name-seed', stepType: 'seed', blocker: 'typeCannotRun' },
      {
        stepId: 'id-delay',
        stepName: 'name-delay',
        stepType: 'delay',
        blocker: 'delayNeedsSeconds',
      },
      {
        stepId: 'id-condition',
        stepName: 'name-condition',
        stepType: 'condition',
        blocker: 'conditionCannotRun',
      },
    ]);
  });

  it('finds nothing to block in a pipeline of configured Delay steps', () => {
    expect(blockedSteps([step('delay', { seconds: 1 }), step('delay', { seconds: 2 })])).toEqual(
      [],
    );
  });
});
