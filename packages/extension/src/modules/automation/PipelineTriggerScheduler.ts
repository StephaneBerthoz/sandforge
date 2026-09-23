import { z } from 'zod';
import type {
  PipelineDefinition,
  PipelineHistoryEntry,
  PipelineMissedStart,
  PipelineRun,
  PipelineTrigger,
  PipelineTriggerStatus,
} from '@sandforge/shared';
import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { TriggerEngine, savedTriggerSchema } from './TriggerEngine.js';
import type { TriggerIdle } from './TriggerEngine.js';
import type { RunHolder, TriggerClaims } from './TriggerClaims.js';

/**
 * The longest the scheduler goes without looking at its schedules. It looks
 * when the soonest one falls due, and at least this often: a clock moved by
 * hand, or a computer woken up, is noticed within it.
 */
export const CHECK_INTERVAL_MS = 60_000;

/**
 * How late a start may still be made. A look that comes later than this after
 * a schedule fell due — the computer was asleep, the extension host was held
 * up — reports the start missed rather than making it late. A start that fell
 * due before the extension started is reported, however little before.
 */
export const LATE_AFTER_MS = 2 * 60_000;

/** How many missed starts one report counts; past it, the report says "at least". */
const MISSED_COUNT_LIMIT = 50;

/** How long a claim is kept: far longer than two windows could both see one start. */
const CLAIM_LIFETIME_MS = 2 * 24 * 60 * 60_000;

/** How often old claims are pruned. */
const PRUNE_INTERVAL_MS = 60 * 60_000;

/** The shortest wait between two looks, so a clock read a hair early does not spin. */
const MIN_WAIT_MS = 250;

/** ConfigStore category of what is remembered of each trigger. */
const STATE_CATEGORY = 'pipeline-triggers';

/** The trigger types that start a run without a click. */
export type AutomaticTrigger = 'schedule' | 'sandbox_refresh';

/** A run a trigger asked for: started, or not, because a run of the pipeline is going. */
export type TriggeredStart =
  | { started: true; run: Promise<PipelineRun | undefined> }
  | { started: false; busy: RunHolder };

/**
 * What the user is told: a start a trigger owed and did not make, or a run a
 * trigger started that failed. A run that completes is written to the history
 * and says nothing more: a schedule that runs every hour would otherwise speak
 * every hour.
 */
export type TriggerReport =
  | {
      kind: 'missed';
      pipelineName: string;
      triggeredBy: AutomaticTrigger;
      /** When the first missed start fell due, as an ISO date. */
      dueAt: string;
      missed: PipelineMissedStart;
      /** When the schedule starts the pipeline next. */
      nextRunAt?: string;
      /** The sandbox whose refresh fired the trigger. */
      sandboxName?: string;
    }
  | {
      kind: 'failed';
      pipelineName: string;
      triggeredBy: AutomaticTrigger;
      error: string;
      sandboxName?: string;
    };

/** A refresh SandForge noticed, as a trigger needs it. */
export interface NoticedRefresh {
  /** The registered sandbox (its SandForge id). */
  orgId: string;
  /**
   * The same for every window that notices this refresh, and different for
   * the next one: the org the sandbox was before it.
   */
  key: string;
}

/** What {@link PipelineTriggerScheduler} works with. */
export interface PipelineTriggerSchedulerDeps {
  /** The saved pipelines, read afresh at each look: a save or an import changes them. */
  pipelines(): PipelineDefinition[];
  /** Why a pipeline would not start, one sentence per problem; empty when it can. */
  problems(pipeline: PipelineDefinition): Promise<string[]>;
  /** The registered org behind an id: its name, and whether it is a sandbox. */
  org(orgId: string): { name: string; sandbox: boolean } | undefined;
  /** Start a run now, unless a run of the same pipeline is going. */
  start(pipeline: PipelineDefinition, triggeredBy: AutomaticTrigger): TriggeredStart;
  /** Write an entry to the run history (or overwrite the one of the same run id). */
  record(entry: PipelineHistoryEntry): void;
  /** Where each trigger's plan and last firing are kept across restarts. */
  store: Pick<ConfigStore, 'get' | 'set' | 'delete' | 'getByCategory'>;
  /** What the open windows share: which of them takes a start, and which pipelines are running. */
  claims: TriggerClaims;
  /** Tell the user. */
  report(report: TriggerReport): void;
  log(message: string): void;
  /** Clock, injected by tests. */
  now?: () => number;
  /** A new id for a missed-start entry. */
  newId?: () => string;
}

/** What is remembered of one trigger across restarts. */
const triggerStateSchema = z.object({
  /** The schedule the plan was worked out from: another one is planned afresh. */
  cron: z.string().optional(),
  timezone: z.string().optional(),
  /** The next time the schedule starts the pipeline, in epoch milliseconds. */
  nextRunAt: z.number().optional(),
  /** When the trigger last fired, and whether a run started then. */
  lastFiredAt: z.number().optional(),
  lastOutcome: z.enum(['started', 'missed']).optional(),
});

type TriggerState = z.infer<typeof triggerStateSchema>;

/** A trigger's ConfigStore key. */
function stateKey(pipelineId: string, triggerId: string): string {
  return `pipeline-trigger:${pipelineId}:${triggerId}`;
}

/** The busy starts of one trigger while one run was going, gathered into one entry. */
interface BusyMisses {
  runId: string;
  busySince: string;
  firstDueAt: number;
  count: number;
  lastDueAt: number;
}

/**
 * Starts saved pipelines from their schedule and sandbox refresh triggers, for
 * as long as the extension runs.
 *
 * **A schedule** is looked at when it falls due, and at least once a minute.
 * A start is made on time or not at all: one that falls due while VS Code is
 * closed, or while the computer sleeps, is written to the history as missed
 * and said in a notification, and the schedule goes on from the next time.
 * Nothing is replayed. The next start is kept in the ConfigStore, so a start
 * missed while VS Code was closed is known at the next launch.
 *
 * **A sandbox refresh** trigger starts its pipeline when SandForge notices a
 * refresh of the sandbox it names — only a pipeline whose steps can all run:
 * one that holds a step that cannot run is written to the history as missed,
 * with the step and the reason, and started not at all.
 *
 * **One run of a pipeline at a time**: a trigger that fires while a run of the
 * pipeline is going — started by hand, or by a trigger, in this window or
 * another — starts nothing, and the history says so; the starts missed during
 * one run are gathered into one entry.
 *
 * Every VS Code window runs one of these. The windows claim each start (see
 * {@link TriggerClaims}), so exactly one of them makes it or reports it.
 */
export class PipelineTriggerScheduler {
  private readonly engine = new TriggerEngine();
  private readonly now: () => number;
  private readonly newId: () => string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  /**
   * Whether the next look is the first since the start: a start owed then fell
   * due while VS Code was closed.
   */
  private firstLook = true;
  private looking: Promise<void> | undefined;
  private lookAgain = false;
  private lastPrune = 0;
  /** The soonest planned start, found by the last look. */
  private soonest: number | undefined;
  private readonly busyMisses = new Map<string, BusyMisses>();

  constructor(private readonly deps: PipelineTriggerSchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  }

  /**
   * Start firing triggers. The first look reports the starts that fell due
   * while VS Code was closed and plans the next ones. Idempotent.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.firstLook = true;
    this.deps.log('[pipeline-triggers] started');
    void this.look();
  }

  /** Stop firing triggers. Runs already going are left to end. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.deps.log('[pipeline-triggers] stopped');
  }

  /**
   * Look at the triggers now: a pipeline was saved, and its schedule has to
   * be planned before its first start is due.
   */
  reload(): Promise<void> {
    return this.started ? this.look() : Promise.resolve();
  }

  /**
   * Start every pipeline whose sandbox refresh trigger names the sandbox that
   * was refreshed — once across the open windows, and only a pipeline whose
   * steps can all run.
   */
  async onSandboxRefresh(refresh: NoticedRefresh): Promise<void> {
    if (!this.started) return;
    const org = this.deps.org(refresh.orgId);
    for (const pipeline of this.deps.pipelines()) {
      for (const trigger of this.triggersOf(pipeline)) {
        if (!this.engine.firesOnRefreshOf(trigger, refresh.orgId)) continue;
        if (this.engine.idleReason(trigger, org)) continue;
        if (!this.deps.claims.claim(`refresh:${pipeline.id}:${trigger.id}:${refresh.key}`)) {
          continue;
        }
        const now = this.now();
        const problems = await this.problemsOf(pipeline);
        if (problems.length > 0) {
          const missed: PipelineMissedStart = {
            reason: 'cannotRun',
            count: 1,
            detail: problems.join(' '),
          };
          this.recordMissed(pipeline, 'sandbox_refresh', now, missed);
          this.remember(pipeline, trigger, { lastFiredAt: now, lastOutcome: 'missed' });
          this.deps.report({
            kind: 'missed',
            pipelineName: pipeline.name,
            triggeredBy: 'sandbox_refresh',
            dueAt: new Date(now).toISOString(),
            missed,
            sandboxName: org?.name,
          });
          continue;
        }
        this.fire(pipeline, trigger, 'sandbox_refresh', now, org?.name);
      }
    }
  }

  /**
   * What each schedule and sandbox refresh trigger of the saved pipelines
   * will do: its next start, or why it starts nothing.
   */
  async statuses(): Promise<PipelineTriggerStatus[]> {
    const statuses: PipelineTriggerStatus[] = [];
    const now = this.now();
    for (const pipeline of this.deps.pipelines()) {
      const automatic = this.triggersOf(pipeline);
      let problems: string[] | undefined;
      for (const trigger of automatic) {
        const state = this.read(pipeline.id, trigger.id);
        const type = trigger.type as AutomaticTrigger;
        const base: PipelineTriggerStatus = {
          pipelineId: pipeline.id,
          triggerId: trigger.id,
          type,
          armed: false,
          ...(state.lastFiredAt !== undefined
            ? {
                lastFiredAt: new Date(state.lastFiredAt).toISOString(),
                ...(state.lastOutcome ? { lastOutcome: state.lastOutcome } : {}),
              }
            : {}),
          ...(type === 'schedule' ? { timezone: this.engine.timezoneOf(trigger) } : {}),
        };
        let idle = this.engine.idleReason(trigger, this.orgOf(trigger));
        if (!idle) {
          problems ??= await this.problemsOf(pipeline);
          if (problems.length > 0) idle = { idle: 'cannotRun', detail: problems.join(' ') };
        }
        if (!idle && !this.started) idle = { idle: 'stopped' };
        let nextRunAt: number | undefined;
        if (!idle && type === 'schedule') {
          const planned = this.planOf(trigger, state) ?? this.engine.nextRun(trigger, now);
          if (typeof planned === 'number') nextRunAt = planned;
          else idle = planned;
        }
        statuses.push(
          idle
            ? { ...base, idle: idle.idle, ...(idle.detail ? { detail: idle.detail } : {}) }
            : {
                ...base,
                armed: true,
                ...(nextRunAt !== undefined
                  ? { nextRunAt: new Date(nextRunAt).toISOString() }
                  : {}),
              },
        );
      }
    }
    return statuses;
  }

  /** Look at every schedule, then wait for the next one. One look at a time. */
  private look(): Promise<void> {
    if (this.looking) {
      // A save during a look: its schedule is planned by one more look.
      this.lookAgain = true;
      return this.looking;
    }
    this.looking = this.lookNow()
      .catch((err: unknown) => {
        this.deps.log(`[pipeline-triggers] a look failed: ${extractErrorMessage(err)}`);
      })
      .finally(() => {
        this.looking = undefined;
        if (this.lookAgain) {
          this.lookAgain = false;
          void this.look();
        } else {
          this.arm();
        }
      });
    return this.looking;
  }

  private async lookNow(): Promise<void> {
    if (!this.started) return;
    const now = this.now();
    const closed = this.firstLook;
    this.firstLook = false;
    if (now - this.lastPrune >= PRUNE_INTERVAL_MS) {
      this.lastPrune = now;
      this.deps.claims.prune(CLAIM_LIFETIME_MS);
    }

    const kept = new Set<string>();
    let soonest: number | undefined;
    for (const pipeline of this.deps.pipelines()) {
      let problems: string[] | undefined;
      for (const trigger of this.triggersOf(pipeline)) {
        kept.add(stateKey(pipeline.id, trigger.id));
        if (trigger.type !== 'schedule') continue;
        let idle: TriggerIdle | undefined = this.engine.idleReason(trigger);
        if (!idle) {
          problems ??= await this.problemsOf(pipeline);
          if (problems.length > 0) idle = { idle: 'cannotRun' };
        }
        const next = idle
          ? this.unplan(pipeline, trigger)
          : this.lookAt(pipeline, trigger, now, closed);
        if (next !== undefined && (soonest === undefined || next < soonest)) soonest = next;
      }
    }
    this.soonest = soonest;
    this.forgetAllBut(kept);
  }

  /**
   * Look at one armed schedule: plan it when it has no plan for its current
   * expression, and when its planned start is due, make it or report it.
   * @returns When it starts the pipeline next.
   */
  private lookAt(
    pipeline: PipelineDefinition,
    trigger: PipelineTrigger,
    now: number,
    closed: boolean,
  ): number | undefined {
    const state = this.read(pipeline.id, trigger.id);
    const planned = this.planOf(trigger, state);
    if (planned === undefined) {
      return this.plan(pipeline, trigger, state, now);
    }
    if (planned > now) return planned;

    // Every time it fell due since the planned start, and the one it starts on
    // time, if the look is not too late for it. The first look after the start
    // makes none: whatever it finds due fell due while nothing ran SandForge,
    // however shortly before, and a start owed then is reported, not made.
    const later = this.engine.dueBetween(trigger, planned, now, MISSED_COUNT_LIMIT);
    const dues = [planned, ...later.times];
    const last = dues[dues.length - 1];
    const onTime = !closed && now - last <= LATE_AFTER_MS ? last : undefined;
    const late = onTime === undefined ? dues : dues.slice(0, -1);
    // The next start is planned before anything is made, so a look during the
    // run never takes this one again.
    const next = this.plan(pipeline, trigger, state, now);

    // A start another window made, or reported, is not missed here.
    const missed = late.filter((due) =>
      this.deps.claims.claim(this.dueKey(pipeline, trigger, due)),
    );
    if (missed.length > 0) {
      const report: PipelineMissedStart = {
        reason: closed ? 'closed' : 'asleep',
        count: missed.length,
        ...(missed.length > 1
          ? { lastDueAt: new Date(missed[missed.length - 1]).toISOString() }
          : {}),
        ...(later.more ? { atLeast: true } : {}),
      };
      this.recordMissed(pipeline, 'schedule', missed[0], report);
      this.remember(pipeline, trigger, {
        lastFiredAt: missed[missed.length - 1],
        lastOutcome: 'missed',
      });
      this.deps.report({
        kind: 'missed',
        pipelineName: pipeline.name,
        triggeredBy: 'schedule',
        dueAt: new Date(missed[0]).toISOString(),
        missed: report,
        ...(next !== undefined ? { nextRunAt: new Date(next).toISOString() } : {}),
      });
    }
    if (onTime !== undefined && this.deps.claims.claim(this.dueKey(pipeline, trigger, onTime))) {
      this.fire(pipeline, trigger, 'schedule', onTime);
    }
    return next;
  }

  /** The claim of one start of a schedule: the same key in every window. */
  private dueKey(pipeline: PipelineDefinition, trigger: PipelineTrigger, due: number): string {
    return `due:${pipeline.id}:${trigger.id}:${due}`;
  }

  /**
   * Start the pipeline, or say why not: a run of it is going. The starts a
   * trigger misses during one run are gathered into one history entry.
   */
  private fire(
    pipeline: PipelineDefinition,
    trigger: PipelineTrigger,
    triggeredBy: AutomaticTrigger,
    at: number,
    sandboxName?: string,
  ): void {
    const key = stateKey(pipeline.id, trigger.id);
    const start = this.deps.start(pipeline, triggeredBy);
    if (start.started) {
      this.busyMisses.delete(key);
      this.remember(pipeline, trigger, { lastFiredAt: at, lastOutcome: 'started' });
      this.deps.log(`[pipeline-triggers] started "${pipeline.name}" (${triggeredBy})`);
      void start.run.then(
        (run) => {
          if (run?.status === 'failed') {
            this.deps.report({
              kind: 'failed',
              pipelineName: pipeline.name,
              triggeredBy,
              error: run.error ?? 'the run failed',
              ...(sandboxName ? { sandboxName } : {}),
            });
          }
        },
        (err: unknown) => {
          this.deps.report({
            kind: 'failed',
            pipelineName: pipeline.name,
            triggeredBy,
            error: extractErrorMessage(err),
            ...(sandboxName ? { sandboxName } : {}),
          });
        },
      );
      return;
    }

    const open = this.busyMisses.get(key);
    const gathered: BusyMisses =
      open && open.busySince === start.busy.startedAt
        ? { ...open, count: open.count + 1, lastDueAt: at }
        : {
            runId: `missed-${this.newId()}`,
            busySince: start.busy.startedAt,
            firstDueAt: at,
            count: 1,
            lastDueAt: at,
          };
    this.busyMisses.set(key, gathered);
    const missed: PipelineMissedStart = {
      reason: 'busy',
      count: gathered.count,
      busySince: gathered.busySince,
      ...(gathered.count > 1 ? { lastDueAt: new Date(gathered.lastDueAt).toISOString() } : {}),
    };
    this.recordMissed(pipeline, triggeredBy, gathered.firstDueAt, missed, gathered.runId);
    this.remember(pipeline, trigger, { lastFiredAt: at, lastOutcome: 'missed' });
    this.deps.log(
      `[pipeline-triggers] "${pipeline.name}" not started (${triggeredBy}): a run started at ${start.busy.startedAt} is going`,
    );
    // Said once per run in the way, not at every start it holds up.
    if (gathered.count === 1) {
      this.deps.report({
        kind: 'missed',
        pipelineName: pipeline.name,
        triggeredBy,
        dueAt: new Date(at).toISOString(),
        missed,
        ...(sandboxName ? { sandboxName } : {}),
      });
    }
  }

  /** Write a missed start to the history. */
  private recordMissed(
    pipeline: PipelineDefinition,
    triggeredBy: AutomaticTrigger,
    dueAt: number,
    missed: PipelineMissedStart,
    runId = `missed-${this.newId()}`,
  ): void {
    this.deps.record({
      runId,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      status: 'missed',
      triggeredBy,
      startTime: new Date(dueAt).toISOString(),
      duration: 0,
      stepCount: 0,
      errorCount: 0,
      missed,
    });
  }

  /** The planned start of a schedule, when its plan was made for the expression it holds now. */
  private planOf(trigger: PipelineTrigger, state: TriggerState): number | undefined {
    const current =
      state.cron === (trigger.config.cron ?? '').trim() &&
      state.timezone === this.engine.timezoneOf(trigger);
    return current ? state.nextRunAt : undefined;
  }

  /** Plan the next start after `now`, and keep it. */
  private plan(
    pipeline: PipelineDefinition,
    trigger: PipelineTrigger,
    state: TriggerState,
    now: number,
  ): number | undefined {
    const next = this.engine.nextRun(trigger, now);
    const nextRunAt = typeof next === 'number' ? next : undefined;
    this.write(pipeline.id, trigger.id, {
      ...state,
      cron: (trigger.config.cron ?? '').trim(),
      timezone: this.engine.timezoneOf(trigger),
      nextRunAt,
    });
    return nextRunAt;
  }

  /**
   * Drop the plan of a schedule that starts nothing now. When it can fire
   * again it is planned from then: the time it spent switched off, or unable
   * to run, owes no start.
   */
  private unplan(pipeline: PipelineDefinition, trigger: PipelineTrigger): undefined {
    const state = this.read(pipeline.id, trigger.id);
    if (state.nextRunAt !== undefined || state.cron !== undefined) {
      this.write(pipeline.id, trigger.id, {
        ...(state.lastFiredAt !== undefined ? { lastFiredAt: state.lastFiredAt } : {}),
        ...(state.lastOutcome ? { lastOutcome: state.lastOutcome } : {}),
      });
    }
    return undefined;
  }

  /** Keep when a trigger last fired and what came of it. */
  private remember(
    pipeline: PipelineDefinition,
    trigger: PipelineTrigger,
    last: Pick<TriggerState, 'lastFiredAt' | 'lastOutcome'>,
  ): void {
    this.write(pipeline.id, trigger.id, { ...this.read(pipeline.id, trigger.id), ...last });
  }

  /** Forget what is kept of the triggers no saved pipeline holds any more. */
  private forgetAllBut(kept: ReadonlySet<string>): void {
    for (const key of Object.keys(this.deps.store.getByCategory(STATE_CATEGORY))) {
      if (!kept.has(key)) this.deps.store.delete(key);
    }
  }

  /** Wait for the soonest start, or the longest wait, whichever comes first. */
  private arm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.started) return;
    const until = this.soonest === undefined ? CHECK_INTERVAL_MS : this.soonest - this.now();
    const wait = Math.min(Math.max(until, MIN_WAIT_MS), CHECK_INTERVAL_MS);
    this.timer = setTimeout(() => void this.look(), wait);
    // The wait alone never keeps a process alive: a host shutting down is not
    // held open for a schedule.
    this.timer.unref?.();
  }

  /** The schedule and sandbox refresh triggers a saved pipeline holds, read and checked. */
  private triggersOf(pipeline: PipelineDefinition): PipelineTrigger[] {
    const triggers: unknown[] = Array.isArray(pipeline.triggers) ? pipeline.triggers : [];
    return triggers.flatMap((raw) => {
      const parsed = savedTriggerSchema.safeParse(raw);
      if (!parsed.success) return [];
      const trigger = parsed.data as PipelineTrigger;
      return trigger.type === 'schedule' || trigger.type === 'sandbox_refresh' ? [trigger] : [];
    });
  }

  /** What a sandbox refresh trigger needs of the org it names. */
  private orgOf(trigger: PipelineTrigger): { sandbox: boolean } | undefined {
    const orgId = trigger.config.orgId;
    return trigger.type === 'sandbox_refresh' && orgId ? this.deps.org(orgId) : undefined;
  }

  /** Why a pipeline cannot start; a check that throws is itself the reason. */
  private async problemsOf(pipeline: PipelineDefinition): Promise<string[]> {
    try {
      return await this.deps.problems(pipeline);
    } catch (err: unknown) {
      return [`The saved pipeline cannot be read: ${extractErrorMessage(err)}.`];
    }
  }

  private read(pipelineId: string, triggerId: string): TriggerState {
    const parsed = triggerStateSchema.safeParse(
      this.deps.store.get(stateKey(pipelineId, triggerId)),
    );
    return parsed.success ? parsed.data : {};
  }

  private write(pipelineId: string, triggerId: string, state: TriggerState): void {
    this.deps.store.set(stateKey(pipelineId, triggerId), state, STATE_CATEGORY);
  }
}
