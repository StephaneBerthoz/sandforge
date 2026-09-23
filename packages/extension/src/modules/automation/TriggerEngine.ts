import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import type { PipelineTrigger, PipelineTriggerIdleReason } from '@sandforge/shared';

/**
 * A trigger as a saved pipeline holds it.
 *
 * `pipeline:save` stores the definition the page sent as it came, and a
 * profile import or an older release can have written anything there, so a
 * trigger is read before it is acted on: one that does not parse starts
 * nothing.
 */
export const savedTriggerSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum([
    'manual',
    'schedule',
    'event',
    'webhook',
    'sandbox_refresh',
    'deployment_complete',
  ]),
  enabled: z.boolean(),
  config: z
    .object({
      cron: z.string().max(200).optional(),
      timezone: z.string().max(100).optional(),
      orgId: z.string().max(200).optional(),
    })
    .passthrough()
    .default({}),
});

/** Why a trigger starts nothing, and what lies behind it in the host's words. */
export interface TriggerIdle {
  idle: PipelineTriggerIdleReason;
  detail?: string;
}

/** What a sandbox refresh trigger needs to know of the org it names. */
export interface TriggerOrg {
  /** Whether the org is registered as a sandbox: only a sandbox is refreshed. */
  sandbox: boolean;
}

/**
 * The fields of a schedule: minute, hour, day of the month, month, day of the
 * week. The parser also reads a sixth, leading field of seconds, and would run
 * a pipeline every second on `* * * * * *`; a schedule is checked to the minute.
 */
const CRON_FIELDS = 5;

/** The time zone the extension host runs in: a schedule saved with none is read there. */
function hostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Whether `timezone` is an IANA time zone this runtime knows. */
function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** A parser error as a sentence. */
function parserMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Decides what a pipeline's triggers do: when a schedule falls due, and
 * whether a trigger can fire at all.
 *
 * Two types start a run without a click. A **schedule** reads a five-field
 * cron expression in its time zone; the extension checks it while VS Code
 * runs (see `PipelineTriggerScheduler`). A **sandbox refresh** trigger names
 * a registered sandbox and starts the pipeline when SandForge notices that the
 * sandbox was refreshed (`SandboxRefreshDetector`).
 *
 * The other three start nothing, and nothing here pretends otherwise: nothing
 * outside VS Code can reach a webhook (SandForge opens no port), no event
 * source feeds an event trigger, and an org's deployments are read only when
 * the Monitor asks for them, so nothing sees one end.
 */
export class TriggerEngine {
  /** The time zone a schedule is read in: its own, or the host's when it names none. */
  timezoneOf(trigger: PipelineTrigger): string {
    const timezone = trigger.config.timezone?.trim();
    return timezone ? timezone : hostTimezone();
  }

  /**
   * Why `trigger` cannot fire, or undefined when it can.
   *
   * @param trigger - A schedule or sandbox refresh trigger.
   * @param org - The org a sandbox refresh trigger names, when one is registered under its id.
   */
  idleReason(trigger: PipelineTrigger, org?: TriggerOrg): TriggerIdle | undefined {
    if (!trigger.enabled) return { idle: 'disabled' };
    if (trigger.type === 'schedule') return this.scheduleProblem(trigger);
    if (trigger.type === 'sandbox_refresh') return this.refreshProblem(trigger, org);
    return undefined;
  }

  /**
   * The first time after `after` the schedule falls due, in epoch
   * milliseconds, or why it gives none.
   */
  nextRun(trigger: PipelineTrigger, after: number): number | TriggerIdle {
    const problem = this.scheduleProblem(trigger);
    if (problem) return problem;
    try {
      const expression = CronExpressionParser.parse(this.cronOf(trigger), {
        tz: this.timezoneOf(trigger),
        currentDate: new Date(after),
      });
      return expression.next().getTime();
    } catch (err: unknown) {
      return { idle: 'noNextRun', detail: parserMessage(err) };
    }
  }

  /**
   * The times the schedule fell due after `from` and up to `to` included,
   * oldest first, at most `limit` of them; `more` says whether it fell due
   * again after the last one listed.
   */
  dueBetween(
    trigger: PipelineTrigger,
    from: number,
    to: number,
    limit: number,
  ): { times: number[]; more: boolean } {
    if (to <= from || this.scheduleProblem(trigger)) return { times: [], more: false };
    const times: number[] = [];
    try {
      const expression = CronExpressionParser.parse(this.cronOf(trigger), {
        tz: this.timezoneOf(trigger),
        currentDate: new Date(from),
        endDate: new Date(to),
      });
      while (expression.hasNext()) {
        if (times.length === limit) return { times, more: true };
        times.push(expression.next().getTime());
      }
    } catch {
      // Past the end of the span, or an expression no date matches: what was
      // read so far is every time it fell due.
    }
    return { times, more: false };
  }

  /** Whether `trigger` starts its pipeline when the registered org `orgId` is refreshed. */
  firesOnRefreshOf(trigger: PipelineTrigger, orgId: string): boolean {
    return trigger.type === 'sandbox_refresh' && trigger.enabled && trigger.config.orgId === orgId;
  }

  /** The expression of a schedule, with its fields separated by single spaces. */
  private cronOf(trigger: PipelineTrigger): string {
    return (trigger.config.cron ?? '').trim().split(/\s+/).join(' ');
  }

  /** Why a schedule gives no time, or undefined when it gives one. */
  private scheduleProblem(trigger: PipelineTrigger): TriggerIdle | undefined {
    const cron = this.cronOf(trigger);
    if (cron === '') return { idle: 'noCron' };
    const fields = cron.split(' ').length;
    if (fields !== CRON_FIELDS) {
      return {
        idle: 'badCron',
        detail: `A schedule takes five fields (minute, hour, day of the month, month, day of the week); this one has ${fields}.`,
      };
    }
    const timezone = this.timezoneOf(trigger);
    if (!isKnownTimezone(timezone)) return { idle: 'badTimezone', detail: timezone };
    try {
      CronExpressionParser.parse(cron, { tz: timezone, currentDate: new Date(0) });
    } catch (err: unknown) {
      return { idle: 'badCron', detail: parserMessage(err) };
    }
    return undefined;
  }

  /** Why a sandbox refresh trigger cannot fire on the org it names, or undefined. */
  private refreshProblem(
    trigger: PipelineTrigger,
    org: TriggerOrg | undefined,
  ): TriggerIdle | undefined {
    const orgId = trigger.config.orgId?.trim();
    if (!orgId) return { idle: 'noSandbox' };
    if (!org) return { idle: 'unknownSandbox' };
    if (!org.sandbox) return { idle: 'notSandbox' };
    return undefined;
  }
}
