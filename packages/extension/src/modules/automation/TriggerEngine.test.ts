import { describe, it, expect, beforeEach } from 'vitest';
import { TriggerEngine } from './TriggerEngine';
import { PipelineMarketplace } from './PipelineMarketplace';
import { StepExecutor } from './StepExecutor';
import type { PipelineStep, PipelineTrigger } from '@sandforge/shared';

function createTrigger(overrides?: Partial<PipelineTrigger>): PipelineTrigger {
  return {
    id: 'trigger-1',
    type: 'manual',
    enabled: true,
    config: {},
    ...overrides,
  };
}

describe('TriggerEngine', () => {
  let engine: TriggerEngine;

  beforeEach(() => {
    engine = new TriggerEngine();
  });

  describe('evaluateTrigger', () => {
    it('should return true for an enabled manual trigger', () => {
      const trigger = createTrigger({ type: 'manual', enabled: true });
      expect(engine.evaluateTrigger(trigger)).toBe(true);
    });

    it('should return false for a disabled trigger', () => {
      const trigger = createTrigger({ type: 'manual', enabled: false });
      expect(engine.evaluateTrigger(trigger)).toBe(false);
    });

    it('should return false for a schedule trigger without cron', () => {
      const trigger = createTrigger({ type: 'schedule', enabled: true, config: {} });
      expect(engine.evaluateTrigger(trigger)).toBe(false);
    });

    it('should return false for event triggers (require external event)', () => {
      const trigger = createTrigger({
        type: 'event',
        enabled: true,
        config: { eventType: 'deploy' },
      });
      expect(engine.evaluateTrigger(trigger)).toBe(false);
    });

    it('never fires on a sandbox refresh, since no step a refresh calls for can run in a pipeline', () => {
      expect(engine.evaluateTrigger(createTrigger({ type: 'sandbox_refresh' }))).toBe(false);

      // The reason the refusal gives, checked against the executor: every step
      // of the built-in refresh template is refused before it runs. Give those
      // steps a handler and this fails — the refusal is then worth revisiting.
      const template = new PipelineMarketplace()
        .getTemplates()
        .find((candidate) => candidate.id === 'tpl-sandbox-refresh');
      const executor = new StepExecutor();
      expect(template?.steps.length).toBeGreaterThan(0);
      for (const [index, step] of (template?.steps ?? []).entries()) {
        const refusal = executor.check({
          id: `step-${index}`,
          name: step.name,
          type: step.type as PipelineStep['type'],
          config: step.config,
          continueOnError: false,
        });
        expect(refusal).toContain('cannot run in a pipeline');
      }
    });
  });

  describe('matchesCron', () => {
    it('should match a wildcard cron expression', () => {
      expect(engine.matchesCron('* * * * *', new Date())).toBe(true);
    });

    it('should match a specific minute and hour', () => {
      const date = new Date(2026, 0, 15, 10, 30, 0);
      expect(engine.matchesCron('30 10 * * *', date)).toBe(true);
    });

    it('should not match when minute differs', () => {
      const date = new Date(2026, 0, 15, 10, 30, 0);
      expect(engine.matchesCron('45 10 * * *', date)).toBe(false);
    });

    it('should match day of week (0=Sunday)', () => {
      const sunday = new Date(2026, 0, 4, 0, 0, 0);
      expect(engine.matchesCron('0 0 * * 0', sunday)).toBe(true);
    });

    it('should return false for an invalid cron (wrong number of fields)', () => {
      expect(engine.matchesCron('* *', new Date())).toBe(false);
    });
  });

  describe('matchesEvent', () => {
    it('should return true when event type matches', () => {
      const trigger = createTrigger({
        type: 'event',
        enabled: true,
        config: { eventType: 'deployment_complete' },
      });
      expect(engine.matchesEvent(trigger, 'deployment_complete')).toBe(true);
    });

    it('should return false when event type does not match', () => {
      const trigger = createTrigger({
        type: 'event',
        enabled: true,
        config: { eventType: 'deployment_complete' },
      });
      expect(engine.matchesEvent(trigger, 'sandbox_refresh')).toBe(false);
    });

    it('should return false for non-event trigger types', () => {
      const trigger = createTrigger({ type: 'manual', enabled: true });
      expect(engine.matchesEvent(trigger, 'deployment_complete')).toBe(false);
    });

    it('should return false for disabled event trigger', () => {
      const trigger = createTrigger({
        type: 'event',
        enabled: false,
        config: { eventType: 'deployment_complete' },
      });
      expect(engine.matchesEvent(trigger, 'deployment_complete')).toBe(false);
    });
  });

  describe('getNextFireTime', () => {
    it('should return undefined for non-schedule triggers', () => {
      const trigger = createTrigger({ type: 'manual' });
      expect(engine.getNextFireTime(trigger)).toBeUndefined();
    });

    it('should return undefined for disabled schedule triggers', () => {
      const trigger = createTrigger({
        type: 'schedule',
        enabled: false,
        config: { cron: '* * * * *' },
      });
      expect(engine.getNextFireTime(trigger)).toBeUndefined();
    });

    it('should return a future date for a wildcard cron', () => {
      const trigger = createTrigger({
        type: 'schedule',
        enabled: true,
        config: { cron: '* * * * *' },
      });
      const nextFire = engine.getNextFireTime(trigger);

      expect(nextFire).toBeDefined();
      expect(nextFire!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('getActiveTriggers', () => {
    it('should filter out disabled triggers', () => {
      const triggers: PipelineTrigger[] = [
        createTrigger({ id: 't1', enabled: true }),
        createTrigger({ id: 't2', enabled: false }),
        createTrigger({ id: 't3', enabled: true }),
      ];

      const active = engine.getActiveTriggers(triggers);
      expect(active).toHaveLength(2);
      expect(active.map((t) => t.id)).toEqual(['t1', 't3']);
    });

    it('should return empty array when no triggers are enabled', () => {
      const triggers: PipelineTrigger[] = [createTrigger({ id: 't1', enabled: false })];
      expect(engine.getActiveTriggers(triggers)).toHaveLength(0);
    });
  });
});
