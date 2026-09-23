import { describe, it, expect } from 'vitest';
import { TriggerEngine, savedTriggerSchema } from './TriggerEngine';
import type { PipelineTrigger } from '@sandforge/shared';

function schedule(cron: string | undefined, timezone?: string, enabled = true): PipelineTrigger {
  return {
    id: 'trigger-1',
    type: 'schedule',
    enabled,
    config: { ...(cron !== undefined ? { cron } : {}), ...(timezone ? { timezone } : {}) },
  };
}

function refresh(orgId?: string, enabled = true): PipelineTrigger {
  return {
    id: 'trigger-2',
    type: 'sandbox_refresh',
    enabled,
    config: orgId ? { orgId } : {},
  };
}

const at = (iso: string): number => Date.parse(iso);

describe('TriggerEngine', () => {
  const engine = new TriggerEngine();

  describe('a schedule', () => {
    it('starts nothing while it is switched off', () => {
      expect(engine.idleReason(schedule('0 2 * * *', 'UTC', false))).toEqual({ idle: 'disabled' });
    });

    it('starts nothing without an expression', () => {
      expect(engine.idleReason(schedule(undefined, 'UTC'))).toEqual({ idle: 'noCron' });
      expect(engine.idleReason(schedule('   ', 'UTC'))).toEqual({ idle: 'noCron' });
    });

    it('takes five fields, and refuses the seconds field the parser would read as a start a second', () => {
      const idle = engine.idleReason(schedule('* * * * * *', 'UTC'));
      expect(idle?.idle).toBe('badCron');
      expect(idle?.detail).toMatch(/five fields.*this one has 6/);
      expect(engine.idleReason(schedule('0 2 * *', 'UTC'))?.idle).toBe('badCron');
    });

    it('says what the parser found wrong with a field', () => {
      const idle = engine.idleReason(schedule('61 * * * *', 'UTC'));
      expect(idle?.idle).toBe('badCron');
      expect(idle?.detail).toMatch(/61/);
    });

    it('refuses a date no month has, rather than planning one', () => {
      expect(engine.idleReason(schedule('0 0 31 2 *', 'UTC'))?.idle).toBe('badCron');
    });

    it('refuses a time zone that does not exist, and names it', () => {
      expect(engine.idleReason(schedule('0 2 * * *', 'Mars/Olympus_Mons'))).toEqual({
        idle: 'badTimezone',
        detail: 'Mars/Olympus_Mons',
      });
    });

    it('can fire once it has a valid expression and time zone', () => {
      expect(engine.idleReason(schedule('0 2 * * *', 'Europe/Paris'))).toBeUndefined();
      // Extra spaces between fields are not extra fields.
      expect(engine.idleReason(schedule(' 0  2 * * * ', 'UTC'))).toBeUndefined();
    });

    it('falls due next at the time its expression names, in its own time zone', () => {
      const after = at('2026-09-23T10:00:00.000Z');
      // 02:00 in Paris is midnight UTC in September (summer time).
      expect(engine.nextRun(schedule('0 2 * * *', 'Europe/Paris'), after)).toBe(
        at('2026-09-24T00:00:00.000Z'),
      );
      expect(engine.nextRun(schedule('0 2 * * *', 'UTC'), after)).toBe(
        at('2026-09-24T02:00:00.000Z'),
      );
    });

    it('never falls due again at the instant it is asked from', () => {
      const due = at('2026-09-23T10:00:00.000Z');
      expect(engine.nextRun(schedule('0 10 * * *', 'UTC'), due)).toBe(
        at('2026-09-24T10:00:00.000Z'),
      );
    });

    it('is read in the time zone of the extension host when it names none', () => {
      expect(engine.timezoneOf(schedule('0 2 * * *'))).toBe(
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
      expect(engine.timezoneOf(schedule('0 2 * * *', 'Asia/Tokyo'))).toBe('Asia/Tokyo');
    });

    it('says why it has no next start instead of planning one', () => {
      expect(engine.nextRun(schedule('', 'UTC'), Date.now())).toEqual({ idle: 'noCron' });
    });

    it('lists the times it fell due in a span, oldest first, the end of the span included', () => {
      const trigger = schedule('*/15 * * * *', 'UTC');
      const { times, more } = engine.dueBetween(
        trigger,
        at('2026-09-23T10:00:00.000Z'),
        at('2026-09-23T11:00:00.000Z'),
        10,
      );
      expect(times.map((time) => new Date(time).toISOString())).toEqual([
        '2026-09-23T10:15:00.000Z',
        '2026-09-23T10:30:00.000Z',
        '2026-09-23T10:45:00.000Z',
        '2026-09-23T11:00:00.000Z',
      ]);
      expect(more).toBe(false);
    });

    it('stops listing at its bound and says there were more', () => {
      const { times, more } = engine.dueBetween(
        schedule('* * * * *', 'UTC'),
        at('2026-09-23T00:00:00.000Z'),
        at('2026-09-23T08:00:00.000Z'),
        50,
      );
      expect(times).toHaveLength(50);
      expect(more).toBe(true);
    });

    it('lists nothing for an empty span or a schedule that gives no time', () => {
      const from = at('2026-09-23T10:00:00.000Z');
      expect(engine.dueBetween(schedule('* * * * *', 'UTC'), from, from, 10).times).toEqual([]);
      expect(engine.dueBetween(schedule('nope', 'UTC'), from, from + 3_600_000, 10).times).toEqual(
        [],
      );
    });
  });

  describe('a sandbox refresh trigger', () => {
    it('starts nothing until it names a sandbox', () => {
      expect(engine.idleReason(refresh())).toEqual({ idle: 'noSandbox' });
    });

    it('starts nothing on an org SandForge does not know', () => {
      expect(engine.idleReason(refresh('org-gone'), undefined)).toEqual({ idle: 'unknownSandbox' });
    });

    it('starts nothing on an org that is not a sandbox: only a sandbox is refreshed', () => {
      expect(engine.idleReason(refresh('org-prod'), { sandbox: false })).toEqual({
        idle: 'notSandbox',
      });
    });

    it('can fire on a registered sandbox', () => {
      expect(engine.idleReason(refresh('org-uat'), { sandbox: true })).toBeUndefined();
    });

    it('fires on a refresh of the sandbox it names, and of no other', () => {
      expect(engine.firesOnRefreshOf(refresh('org-uat'), 'org-uat')).toBe(true);
      expect(engine.firesOnRefreshOf(refresh('org-uat'), 'org-dev')).toBe(false);
      expect(engine.firesOnRefreshOf(refresh('org-uat', false), 'org-uat')).toBe(false);
      expect(engine.firesOnRefreshOf(schedule('0 2 * * *', 'UTC'), 'org-uat')).toBe(false);
    });
  });

  describe('a saved trigger', () => {
    it('is read, and one that is not a trigger is refused', () => {
      expect(
        savedTriggerSchema.safeParse({
          id: 't1',
          type: 'schedule',
          enabled: true,
          config: { cron: '0 2 * * *' },
        }).success,
      ).toBe(true);
      expect(savedTriggerSchema.safeParse({ id: 't1', type: 'cron', enabled: true }).success).toBe(
        false,
      );
      expect(savedTriggerSchema.safeParse({ id: 't1', type: 'schedule' }).success).toBe(false);
    });

    it('is read with no config as one with an empty config', () => {
      const parsed = savedTriggerSchema.parse({ id: 't1', type: 'manual', enabled: true });
      expect(parsed.config).toEqual({});
    });
  });
});
