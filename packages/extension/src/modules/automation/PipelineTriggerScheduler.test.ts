import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  PipelineDefinition,
  PipelineHistoryEntry,
  PipelineRun,
  PipelineTrigger,
} from '@sandforge/shared';
import {
  PipelineTriggerScheduler,
  CHECK_INTERVAL_MS,
  LATE_AFTER_MS,
} from './PipelineTriggerScheduler';
import type { AutomaticTrigger, TriggerReport } from './PipelineTriggerScheduler';
import { memoryTriggerClaims } from './TriggerClaims';
import type { RunHolder, TriggerClaims } from './TriggerClaims';
import { ConfigStore } from '../../core/storage/ConfigStore';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend';

function pipeline(
  id: string,
  triggers: PipelineTrigger[],
  name = `Pipeline ${id}`,
): PipelineDefinition {
  return {
    id,
    name,
    description: '',
    version: 1,
    steps: [
      { id: 's1', name: 'Wait', type: 'delay', config: { seconds: 1 }, continueOnError: false },
    ],
    triggers,
    variables: [],
    tags: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function schedule(cron: string, extra: Partial<PipelineTrigger> = {}): PipelineTrigger {
  return {
    id: 'sched',
    type: 'schedule',
    enabled: true,
    config: { cron, timezone: 'UTC' },
    ...extra,
  };
}

function refreshOf(orgId: string, extra: Partial<PipelineTrigger> = {}): PipelineTrigger {
  return { id: 'refresh', type: 'sandbox_refresh', enabled: true, config: { orgId }, ...extra };
}

const iso = (time: string): number => Date.parse(time);

/** A run as the handler resolves it, in the status given. */
function runEnding(status: PipelineRun['status'], error?: string): PipelineRun {
  return {
    id: 'run-1',
    pipelineId: 'p1',
    pipelineName: 'Pipeline p1',
    status,
    triggeredBy: 'schedule',
    stepResults: [],
    variables: {},
    startTime: new Date().toISOString(),
    ...(error ? { error } : {}),
  };
}

interface HarnessOptions {
  pipelines: PipelineDefinition[];
  problems?: Record<string, string[]>;
  orgs?: Record<string, { name: string; sandbox: boolean }>;
  claims?: TriggerClaims;
  store?: ConfigStore;
  run?: () => Promise<PipelineRun | undefined>;
}

/** A scheduler over the pipelines given, with what it starts, records and reports laid bare. */
function harness(options: HarnessOptions) {
  const store = options.store ?? new ConfigStore(new InMemoryConfigStoreBackend());
  const started: Array<{ pipelineId: string; triggeredBy: AutomaticTrigger; at: string }> = [];
  const history = new Map<string, PipelineHistoryEntry>();
  const reports: TriggerReport[] = [];
  const state = { pipelines: options.pipelines, busy: undefined as RunHolder | undefined };
  let ids = 0;
  const scheduler = new PipelineTriggerScheduler({
    pipelines: () => state.pipelines,
    problems: async (p) => options.problems?.[p.id] ?? [],
    org: (orgId) => options.orgs?.[orgId],
    start: (p, triggeredBy) => {
      if (state.busy) return { started: false, busy: state.busy };
      started.push({ pipelineId: p.id, triggeredBy, at: new Date().toISOString() });
      return { started: true, run: options.run?.() ?? Promise.resolve(runEnding('completed')) };
    },
    record: (entry) => history.set(entry.runId, entry),
    store,
    claims: options.claims ?? memoryTriggerClaims(),
    report: (report) => reports.push(report),
    log: () => undefined,
    newId: () => `id-${++ids}`,
  });
  return { scheduler, store, started, history, reports, state };
}

/** Let the scheduler's looks and the promises they wait on run. */
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('PipelineTriggerScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T01:59:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('a schedule', () => {
    it('starts its pipeline when it falls due, and not before', async () => {
      const h = harness({ pipelines: [pipeline('p1', [schedule('0 2 * * *')])] });
      h.scheduler.start();
      await settle();
      expect(h.started).toEqual([]);

      await settle(59_000);
      expect(h.started).toEqual([]);
      await settle(1_000);
      expect(h.started).toEqual([
        { pipelineId: 'p1', triggeredBy: 'schedule', at: '2026-09-23T02:00:00.000Z' },
      ]);
      h.scheduler.stop();
    });

    it('starts it again at each time it falls due while VS Code runs', async () => {
      const h = harness({ pipelines: [pipeline('p1', [schedule('*/5 * * * *')])] });
      h.scheduler.start();
      await settle(16 * 60_000);
      expect(h.started.map((start) => start.at)).toEqual([
        '2026-09-23T02:00:00.000Z',
        '2026-09-23T02:05:00.000Z',
        '2026-09-23T02:10:00.000Z',
        '2026-09-23T02:15:00.000Z',
      ]);
      expect(h.history.size).toBe(0);
      h.scheduler.stop();
    });

    it('shows its next start, and the time zone it is read in', async () => {
      const h = harness({
        pipelines: [
          pipeline('p1', [
            schedule('0 2 * * *', { config: { cron: '0 2 * * *', timezone: 'Europe/Paris' } }),
          ]),
        ],
      });
      h.scheduler.start();
      await settle();
      expect(await h.scheduler.statuses()).toEqual([
        {
          pipelineId: 'p1',
          triggerId: 'sched',
          type: 'schedule',
          armed: true,
          timezone: 'Europe/Paris',
          // 02:00 in Paris, in September: midnight UTC.
          nextRunAt: '2026-09-24T00:00:00.000Z',
        },
      ]);
      h.scheduler.stop();
    });

    it('shows when it last started the pipeline', async () => {
      const h = harness({ pipelines: [pipeline('p1', [schedule('0 2 * * *')])] });
      h.scheduler.start();
      await settle(60_000);
      const [status] = await h.scheduler.statuses();
      expect(status).toMatchObject({
        lastFiredAt: '2026-09-23T02:00:00.000Z',
        lastOutcome: 'started',
        nextRunAt: '2026-09-24T02:00:00.000Z',
      });
      h.scheduler.stop();
    });

    it('reports a start that fell due while VS Code was closed, and does not make it', async () => {
      const store = new ConfigStore(new InMemoryConfigStoreBackend());
      const pipelines = [pipeline('p1', [schedule('0 2 * * *')], 'Nightly backup')];
      // The window that planned 02:00 is closed a minute before it.
      const before = harness({ pipelines, store });
      before.scheduler.start();
      await settle();
      before.scheduler.stop();

      // VS Code opens again at 08:30.
      vi.setSystemTime(new Date('2026-09-23T08:30:00.000Z'));
      const after = harness({ pipelines, store });
      after.scheduler.start();
      await settle();

      expect(after.started).toEqual([]);
      const [entry] = [...after.history.values()];
      expect(entry).toMatchObject({
        pipelineId: 'p1',
        pipelineName: 'Nightly backup',
        status: 'missed',
        triggeredBy: 'schedule',
        startTime: '2026-09-23T02:00:00.000Z',
        stepCount: 0,
        missed: { reason: 'closed', count: 1 },
      });
      expect(after.reports).toEqual([
        {
          kind: 'missed',
          pipelineName: 'Nightly backup',
          triggeredBy: 'schedule',
          dueAt: '2026-09-23T02:00:00.000Z',
          missed: { reason: 'closed', count: 1 },
          nextRunAt: '2026-09-24T02:00:00.000Z',
        },
      ]);
      // Nothing is replayed later either: the schedule goes on from tomorrow.
      await settle(3 * 60 * 60_000);
      expect(after.started).toEqual([]);
      expect((await after.scheduler.statuses())[0].nextRunAt).toBe('2026-09-24T02:00:00.000Z');
      after.scheduler.stop();
    });

    it('does not make a start that fell due a moment before VS Code opened', async () => {
      const store = new ConfigStore(new InMemoryConfigStoreBackend());
      const pipelines = [pipeline('p1', [schedule('0 2 * * *')])];
      const before = harness({ pipelines, store });
      before.scheduler.start();
      await settle();
      before.scheduler.stop();

      // Thirty seconds late: a look would still make it, VS Code open.
      vi.setSystemTime(new Date('2026-09-23T02:00:30.000Z'));
      const after = harness({ pipelines, store });
      after.scheduler.start();
      await settle();
      expect(after.started).toEqual([]);
      expect([...after.history.values()].map((entry) => entry.missed)).toEqual([
        { reason: 'closed', count: 1 },
      ]);
      after.scheduler.stop();
    });

    it('counts every start it missed while closed in one report', async () => {
      const store = new ConfigStore(new InMemoryConfigStoreBackend());
      const pipelines = [pipeline('p1', [schedule('0 * * * *')])];
      const before = harness({ pipelines, store });
      before.scheduler.start();
      await settle();
      before.scheduler.stop();

      vi.setSystemTime(new Date('2026-09-23T06:30:00.000Z'));
      const after = harness({ pipelines, store });
      after.scheduler.start();
      await settle();
      const [entry] = [...after.history.values()];
      expect(entry.startTime).toBe('2026-09-23T02:00:00.000Z');
      expect(entry.missed).toEqual({
        reason: 'closed',
        count: 5,
        lastDueAt: '2026-09-23T06:00:00.000Z',
      });
      expect(after.started).toEqual([]);
      after.scheduler.stop();
    });

    it('says "at least" past the bound of a long absence', async () => {
      const store = new ConfigStore(new InMemoryConfigStoreBackend());
      const pipelines = [pipeline('p1', [schedule('* * * * *')])];
      const before = harness({ pipelines, store });
      before.scheduler.start();
      await settle();
      before.scheduler.stop();

      vi.setSystemTime(new Date('2026-09-25T09:00:00.000Z'));
      const after = harness({ pipelines, store });
      after.scheduler.start();
      await settle();
      const [entry] = [...after.history.values()];
      expect(entry.missed).toMatchObject({ reason: 'closed', count: 51, atLeast: true });
      after.scheduler.stop();
    });

    it('makes a start its look reaches a little late, and reports one it reaches too late', async () => {
      // A computer asleep moves the clock on and holds the timers back: the
      // look waiting for 02:00 comes as long after it as the sleep lasted.
      const h = harness({ pipelines: [pipeline('p1', [schedule('0 * * * *')])] });
      h.scheduler.start();
      await settle(30_000);
      vi.setSystemTime(new Date('2026-09-23T02:00:30.000Z'));
      await settle(30_000);
      // A minute late, within the two minutes a start may still be made in.
      expect(h.started.map((start) => start.at)).toEqual(['2026-09-23T02:01:00.000Z']);
      expect(h.history.size).toBe(0);
      expect(LATE_AFTER_MS).toBe(2 * 60_000);

      // It sleeps through 03:00, and the look comes ten minutes after it.
      await settle(iso('2026-09-23T02:59:30.000Z') - Date.now());
      vi.setSystemTime(new Date('2026-09-23T03:09:30.000Z'));
      await settle(30_000);
      expect(h.started).toHaveLength(1);
      const [entry] = [...h.history.values()];
      expect(entry.startTime).toBe('2026-09-23T03:00:00.000Z');
      expect(entry.missed).toEqual({ reason: 'asleep', count: 1 });
      expect(h.reports).toEqual([
        expect.objectContaining({ kind: 'missed', missed: { reason: 'asleep', count: 1 } }),
      ]);
      h.scheduler.stop();
    });

    it('does not start its pipeline while a run of it is going, and gathers the starts it holds up', async () => {
      const h = harness({ pipelines: [pipeline('p1', [schedule('*/5 * * * *')])] });
      h.state.busy = { startedAt: '2026-09-23T01:58:00.000Z', triggeredBy: 'manual' };
      h.scheduler.start();
      await settle(11 * 60_000);

      expect(h.started).toEqual([]);
      // 02:00, 02:05 and 02:10 fell due during the one run: one entry.
      expect([...h.history.values()]).toEqual([
        expect.objectContaining({
          status: 'missed',
          startTime: '2026-09-23T02:00:00.000Z',
          missed: {
            reason: 'busy',
            count: 3,
            busySince: '2026-09-23T01:58:00.000Z',
            lastDueAt: '2026-09-23T02:10:00.000Z',
          },
        }),
      ]);
      // Said once, at the first start it held up.
      expect(h.reports).toHaveLength(1);
      expect(h.reports[0]).toMatchObject({ kind: 'missed', missed: { reason: 'busy', count: 1 } });

      // Once that run has ended, the schedule starts the pipeline again.
      h.state.busy = undefined;
      await settle(5 * 60_000);
      expect(h.started.map((start) => start.at)).toEqual(['2026-09-23T02:15:00.000Z']);
      h.scheduler.stop();
    });

    it('opens a new entry for the starts held up by the next run', async () => {
      const h = harness({ pipelines: [pipeline('p1', [schedule('*/5 * * * *')])] });
      h.state.busy = { startedAt: '2026-09-23T01:58:00.000Z', triggeredBy: 'manual' };
      h.scheduler.start();
      await settle(61_000);
      h.state.busy = { startedAt: '2026-09-23T02:03:00.000Z', triggeredBy: 'sandbox_refresh' };
      await settle(5 * 60_000);
      expect([...h.history.values()].map((entry) => entry.missed?.busySince)).toEqual([
        '2026-09-23T01:58:00.000Z',
        '2026-09-23T02:03:00.000Z',
      ]);
      expect(h.reports).toHaveLength(2);
      h.scheduler.stop();
    });

    it('starts a pipeline once when two windows see it fall due', async () => {
      const pipelines = [pipeline('p1', [schedule('0 2 * * *')])];
      const shared = memoryTriggerClaims();
      const first = harness({ pipelines, claims: shared });
      const second = harness({ pipelines, claims: shared });
      first.scheduler.start();
      second.scheduler.start();
      await settle(60_000);
      expect([...first.started, ...second.started]).toHaveLength(1);
      first.scheduler.stop();
      second.scheduler.stop();
    });

    it('reports a start missed while closed once, whichever window opens first', async () => {
      // globalState: each window loads its own copy of it when it opens.
      const globalState = new InMemoryConfigStoreBackend();
      const opened = (): ConfigStore => {
        const store = new ConfigStore(globalState);
        store.initialize();
        return store;
      };
      const pipelines = [pipeline('p1', [schedule('0 2 * * *')])];
      const before = harness({ pipelines, store: opened() });
      before.scheduler.start();
      await settle();
      before.scheduler.stop();

      vi.setSystemTime(new Date('2026-09-23T08:30:00.000Z'));
      const shared = memoryTriggerClaims();
      // Two windows restored together read the same plan.
      const one = harness({ pipelines, store: opened(), claims: shared });
      const two = harness({ pipelines, store: opened(), claims: shared });
      one.scheduler.start();
      two.scheduler.start();
      await settle();
      expect([...one.history.values(), ...two.history.values()]).toEqual([
        expect.objectContaining({ status: 'missed', missed: { reason: 'closed', count: 1 } }),
      ]);
      expect(one.reports.length + two.reports.length).toBe(1);
      one.scheduler.stop();
      two.scheduler.stop();
    });

    it('starts nothing, and plans nothing, while a step of its pipeline cannot run', async () => {
      const refusal = 'Pipeline step "Seed" (seed) cannot run in a pipeline.';
      const problems: Record<string, string[]> = { p1: [refusal] };
      const h = harness({ pipelines: [pipeline('p1', [schedule('0 2 * * *')])], problems });
      h.scheduler.start();
      await settle(2 * 60_000);
      expect(h.started).toEqual([]);
      expect(h.history.size).toBe(0);
      expect(await h.scheduler.statuses()).toEqual([
        expect.objectContaining({ armed: false, idle: 'cannotRun', detail: refusal }),
      ]);

      // Once it can run, it is planned from then: the time it could not run owes nothing.
      delete problems.p1;
      await settle(CHECK_INTERVAL_MS);
      expect(h.history.size).toBe(0);
      expect((await h.scheduler.statuses())[0]).toMatchObject({
        armed: true,
        nextRunAt: '2026-09-24T02:00:00.000Z',
      });
      h.scheduler.stop();
    });

    it('owes nothing for the time it was switched off', async () => {
      const store = new ConfigStore(new InMemoryConfigStoreBackend());
      const on = pipeline('p1', [schedule('0 * * * *')]);
      const off = pipeline('p1', [schedule('0 * * * *', { enabled: false })]);
      const h = harness({ pipelines: [on], store });
      h.scheduler.start();
      await settle();
      h.state.pipelines = [off];
      await settle(3 * 60 * 60_000);
      expect(h.started).toEqual([]);
      expect((await h.scheduler.statuses())[0]).toMatchObject({ armed: false, idle: 'disabled' });

      h.state.pipelines = [on];
      await h.scheduler.reload();
      expect(h.history.size).toBe(0);
      await settle(60 * 60_000);
      expect(h.started.map((start) => start.at)).toEqual(['2026-09-23T05:00:00.000Z']);
      h.scheduler.stop();
    });

    it('plans a changed expression afresh, without reporting the old one missed', async () => {
      const h = harness({ pipelines: [pipeline('p1', [schedule('0 2 * * *')])] });
      h.scheduler.start();
      await settle();
      h.state.pipelines = [pipeline('p1', [schedule('30 3 * * *')])];
      await h.scheduler.reload();
      await settle(2 * 60 * 60_000);
      expect(h.history.size).toBe(0);
      expect(h.started.map((start) => start.at)).toEqual(['2026-09-23T03:30:00.000Z']);
      h.scheduler.stop();
    });

    it('says why a schedule gives no time', async () => {
      const h = harness({ pipelines: [pipeline('p1', [schedule('* * * * * *')])] });
      h.scheduler.start();
      await settle(2 * 60_000);
      expect(h.started).toEqual([]);
      expect((await h.scheduler.statuses())[0]).toMatchObject({ armed: false, idle: 'badCron' });
      h.scheduler.stop();
    });

    it('starts nothing, and plans nothing, on a day none of its months has', async () => {
      // Each field of `0 0 31 2,4 *` parses; its next run used to come out in 2054.
      const h = harness({ pipelines: [pipeline('p1', [schedule('0 0 31 2,4 *')])] });
      h.scheduler.start();
      await settle(2 * 60_000);
      expect(h.started).toEqual([]);
      expect((await h.scheduler.statuses())[0]).toMatchObject({
        armed: false,
        idle: 'noNextRun',
        detail: expect.stringContaining('No date in the coming year'),
      });
      expect(h.store.get('pipeline-trigger:p1:sched')).toBeUndefined();
      h.scheduler.stop();
    });

    it('drops a start it planned decades away for such a schedule before it was refused', async () => {
      const store = new ConfigStore(new InMemoryConfigStoreBackend());
      store.set(
        'pipeline-trigger:p1:sched',
        { cron: '0 0 31 2,4 *', timezone: 'UTC', nextRunAt: iso('2054-02-07T00:00:00.000Z') },
        'pipeline-triggers',
      );
      const h = harness({ pipelines: [pipeline('p1', [schedule('0 0 31 2,4 *')])], store });
      h.scheduler.start();
      await settle();
      expect((await h.scheduler.statuses())[0]).toMatchObject({ armed: false, idle: 'noNextRun' });
      expect(h.store.get('pipeline-trigger:p1:sched')).toEqual({});
      h.scheduler.stop();
    });

    it('tells the user when a run it started failed', async () => {
      const h = harness({
        pipelines: [pipeline('p1', [schedule('0 2 * * *')], 'Nightly compare')],
        run: () =>
          Promise.resolve(runEnding('failed', 'Compare step "Diff" failed: org unreachable')),
      });
      h.scheduler.start();
      await settle(60_000);
      expect(h.reports).toEqual([
        {
          kind: 'failed',
          pipelineName: 'Nightly compare',
          triggeredBy: 'schedule',
          error: 'Compare step "Diff" failed: org unreachable',
        },
      ]);
      h.scheduler.stop();
    });

    it('says nothing of a run that completed: the history has it', async () => {
      const h = harness({ pipelines: [pipeline('p1', [schedule('0 2 * * *')])] });
      h.scheduler.start();
      await settle(60_000);
      expect(h.started).toHaveLength(1);
      expect(h.reports).toEqual([]);
      h.scheduler.stop();
    });

    it('starts nothing once stopped', async () => {
      const h = harness({ pipelines: [pipeline('p1', [schedule('0 2 * * *')])] });
      h.scheduler.start();
      await settle();
      h.scheduler.stop();
      await settle(10 * 60_000);
      expect(h.started).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect((await h.scheduler.statuses())[0]).toMatchObject({ armed: false, idle: 'stopped' });
    });

    it('forgets what it kept of a trigger no saved pipeline holds any more', async () => {
      const h = harness({ pipelines: [pipeline('p1', [schedule('0 2 * * *')])] });
      h.scheduler.start();
      await settle();
      expect(Object.keys(h.store.getByCategory('pipeline-triggers'))).toEqual([
        'pipeline-trigger:p1:sched',
      ]);
      h.state.pipelines = [];
      await h.scheduler.reload();
      expect(h.store.getByCategory('pipeline-triggers')).toEqual({});
      h.scheduler.stop();
    });
  });

  describe('a sandbox refresh trigger', () => {
    const orgs = {
      'org-uat': { name: 'uat', sandbox: true },
      'org-dev': { name: 'dev', sandbox: true },
      'org-prod': { name: 'prod', sandbox: false },
    };

    it('starts its pipeline when the sandbox it names is refreshed, and no other', async () => {
      const h = harness({
        pipelines: [
          pipeline('p1', [refreshOf('org-uat')]),
          pipeline('p2', [refreshOf('org-dev')]),
          pipeline('p3', [refreshOf('org-uat', { enabled: false })]),
        ],
        orgs,
      });
      h.scheduler.start();
      await settle();
      await h.scheduler.onSandboxRefresh({ orgId: 'org-uat', key: '00D000000000011' });
      expect(h.started.map(({ pipelineId, triggeredBy }) => ({ pipelineId, triggeredBy }))).toEqual(
        [{ pipelineId: 'p1', triggeredBy: 'sandbox_refresh' }],
      );
      expect((await h.scheduler.statuses()).find((s) => s.pipelineId === 'p1')).toMatchObject({
        armed: true,
        lastOutcome: 'started',
      });
      h.scheduler.stop();
    });

    it('starts it once for one refresh, however many windows notice it', async () => {
      const shared = memoryTriggerClaims();
      const pipelines = [pipeline('p1', [refreshOf('org-uat')])];
      const one = harness({ pipelines, orgs, claims: shared });
      const two = harness({ pipelines, orgs, claims: shared });
      one.scheduler.start();
      two.scheduler.start();
      await settle();
      await one.scheduler.onSandboxRefresh({ orgId: 'org-uat', key: '00D000000000011' });
      await two.scheduler.onSandboxRefresh({ orgId: 'org-uat', key: '00D000000000011' });
      expect(one.started.length + two.started.length).toBe(1);
      // The next refresh of the same sandbox is another one.
      await two.scheduler.onSandboxRefresh({ orgId: 'org-uat', key: '00D000000000012' });
      expect(one.started.length + two.started.length).toBe(2);
      one.scheduler.stop();
      two.scheduler.stop();
    });

    it('does not start a pipeline a step of which cannot run, and says so', async () => {
      const refusal = 'Pipeline step "Anonymize" (anonymize) cannot run in a pipeline.';
      const h = harness({
        pipelines: [pipeline('p1', [refreshOf('org-uat')], 'After refresh')],
        orgs,
        problems: { p1: [refusal] },
      });
      h.scheduler.start();
      await settle();
      expect((await h.scheduler.statuses())[0]).toMatchObject({ armed: false, idle: 'cannotRun' });
      await h.scheduler.onSandboxRefresh({ orgId: 'org-uat', key: '00D000000000011' });
      expect(h.started).toEqual([]);
      expect([...h.history.values()]).toEqual([
        expect.objectContaining({
          status: 'missed',
          triggeredBy: 'sandbox_refresh',
          missed: { reason: 'cannotRun', count: 1, detail: refusal },
        }),
      ]);
      expect(h.reports).toEqual([
        expect.objectContaining({
          kind: 'missed',
          pipelineName: 'After refresh',
          sandboxName: 'uat',
          missed: expect.objectContaining({ reason: 'cannotRun' }),
        }),
      ]);
      h.scheduler.stop();
    });

    it('does not start its pipeline while a run of it is going', async () => {
      const h = harness({ pipelines: [pipeline('p1', [refreshOf('org-uat')])], orgs });
      h.state.busy = { startedAt: '2026-09-23T01:50:00.000Z', triggeredBy: 'schedule' };
      h.scheduler.start();
      await settle();
      await h.scheduler.onSandboxRefresh({ orgId: 'org-uat', key: '00D000000000011' });
      expect(h.started).toEqual([]);
      expect([...h.history.values()][0].missed).toEqual({
        reason: 'busy',
        count: 1,
        busySince: '2026-09-23T01:50:00.000Z',
      });
      h.scheduler.stop();
    });

    it('says why it starts nothing on an org that is not a registered sandbox', async () => {
      const h = harness({
        pipelines: [
          pipeline('p1', [refreshOf('org-prod')]),
          pipeline('p2', [refreshOf('org-gone')]),
          pipeline('p3', [{ id: 'refresh', type: 'sandbox_refresh', enabled: true, config: {} }]),
        ],
        orgs,
      });
      h.scheduler.start();
      await settle();
      expect((await h.scheduler.statuses()).map((status) => status.idle)).toEqual([
        'notSandbox',
        'unknownSandbox',
        'noSandbox',
      ]);
      await h.scheduler.onSandboxRefresh({ orgId: 'org-prod', key: 'k' });
      expect(h.started).toEqual([]);
      h.scheduler.stop();
    });

    it('starts nothing before the scheduler runs', async () => {
      const h = harness({ pipelines: [pipeline('p1', [refreshOf('org-uat')])], orgs });
      await h.scheduler.onSandboxRefresh({ orgId: 'org-uat', key: 'k' });
      expect(h.started).toEqual([]);
    });
  });

  it('leaves manual, event, webhook and deployment triggers alone: nothing fires them', async () => {
    const h = harness({
      pipelines: [
        pipeline('p1', [
          { id: 'm', type: 'manual', enabled: true, config: {} },
          { id: 'e', type: 'event', enabled: true, config: { eventType: 'deploy' } },
          { id: 'w', type: 'webhook', enabled: true, config: {} },
          { id: 'd', type: 'deployment_complete', enabled: true, config: {} },
        ]),
      ],
    });
    h.scheduler.start();
    await settle(10 * 60_000);
    expect(h.started).toEqual([]);
    expect(await h.scheduler.statuses()).toEqual([]);
    h.scheduler.stop();
  });

  it('skips a saved trigger that does not read as one', async () => {
    const broken = pipeline('p1', [
      { id: 'bad', type: 'schedule', config: { cron: '0 2 * * *' } } as unknown as PipelineTrigger,
      schedule('0 2 * * *'),
    ]);
    const h = harness({ pipelines: [broken] });
    h.scheduler.start();
    await settle(60_000);
    expect(h.started).toHaveLength(1);
    expect((await h.scheduler.statuses()).map((status) => status.triggerId)).toEqual(['sched']);
    h.scheduler.stop();
  });
});
