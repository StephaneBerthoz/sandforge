import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderHook, act } from '@testing-library/react';
import i18n from '../../i18n';
import type { NotificationInput } from '../../stores/useNotificationStore';
import type { PipelineDefinition, PipelineTriggerStatus, SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAutomationPageData, nextTriggerRefreshDelay } from './useAutomationPageData';

/** Options captured from every useBridgeMutation call, keyed by request type. */
const mutationOptions = new Map<string, Record<string, unknown> | undefined>();

/** Mutable double standing in for one useBridgeMutation return value. */
interface MutationDouble {
  mutate: ReturnType<typeof vi.fn>;
  data: unknown;
  loading: boolean;
  error: string | null;
  reset: ReturnType<typeof vi.fn>;
  /** Id of the request the last `mutate` sent. */
  requestId: string | null;
}

/**
 * One double per request type, kept across re-renders.
 *
 * The identity has to be stable so a test can land a reply the way the bridge
 * does — set `data`, re-render — and have the hook's effects see a changed
 * dependency rather than a brand-new object every render.
 */
const mutationDoubles = new Map<string, MutationDouble>();

/** The double for `type`, created on first use. */
function mutationFor(type: string): MutationDouble {
  const existing = mutationDoubles.get(type);
  if (existing) return existing;
  const created: MutationDouble = {
    mutate: vi.fn(),
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
    requestId: null,
  };
  mutationDoubles.set(type, created);
  return created;
}

/** Every notification the hook raised during the current test. */
const notifications: NotificationInput[] = [];

/**
 * Stable across renders, like the real zustand action.
 *
 * A fresh function per render would re-fire every effect that lists it as a
 * dependency, doubling the notifications the assertions count.
 */
const addNotification = (input: NotificationInput): string => {
  notifications.push(input);
  return 'test-notification';
};

const notificationStoreSlice = { addNotification };

vi.mock('../../stores/useNotificationStore', () => ({
  useNotificationStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(notificationStoreSlice),
}));

/**
 * One refetch spy per query type, kept across re-renders so a test can count
 * how often the hook asked a given channel again.
 */
const queryRefetches = new Map<string, ReturnType<typeof vi.fn>>();

/** The refetch spy for `type`, created on first use. */
function refetchFor(type: string): ReturnType<typeof vi.fn> {
  const existing = queryRefetches.get(type);
  if (existing) return existing;
  const created = vi.fn();
  queryRefetches.set(type, created);
  return created;
}

/** What each query answered, by request type; nothing until a test sets it. */
const queryData = new Map<string, unknown>();

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => ({
    data: queryData.get(type) ?? null,
    loading: false,
    error: null,
    refetch: refetchFor(type),
  }),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string, options?: Record<string, unknown>) => {
    mutationOptions.set(type, options);
    return mutationFor(type);
  },
}));

/** What the page posts to the extension, as the VS Code API receives it. */
const posted = vi.fn();
const vscodeApi = { postMessage: posted, getState: () => undefined, setState: () => undefined };
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => vscodeApi,
  getVscodeApi: () => vscodeApi,
}));

/** A message from the extension, as the window hands it to the page. */
function receive(type: string, payload: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { id: `ext-${type}-${String(payload.stepId)}`, type, timestamp: Date.now(), payload },
      }),
    );
  });
}

/** `sandforge.pipeline.timeout`'s default and maximum, read from the extension manifest. */
function manifestPipelineTimeout(): { default: number; maximum: number } {
  // vitest may be started from the workspace root or from packages/webview.
  const manifestPath = [
    resolve(process.cwd(), '../extension/package.json'),
    resolve(process.cwd(), 'packages/extension/package.json'),
  ].find((candidate) => existsSync(candidate));
  if (!manifestPath) {
    throw new Error('extension manifest not found from ' + process.cwd());
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    contributes: {
      configuration: { properties: Record<string, { default?: unknown; maximum?: unknown }> };
    };
  };
  const setting = manifest.contributes.configuration.properties['sandforge.pipeline.timeout'];
  if (typeof setting?.default !== 'number' || typeof setting.maximum !== 'number') {
    throw new Error(
      'sandforge.pipeline.timeout has no numeric default and maximum in the extension manifest',
    );
  }
  return { default: setting.default, maximum: setting.maximum };
}

beforeEach(() => {
  mutationOptions.clear();
  mutationDoubles.clear();
  queryRefetches.clear();
  queryData.clear();
  notifications.length = 0;
  posted.mockClear();
});

describe('useAutomationPageData — pipeline execution timeout', () => {
  it('should not give up on a run before the host does, whatever budget the host is given', () => {
    renderHook(() => useAutomationPageData());

    const timeoutMs = mutationOptions.get('pipeline:execute')?.timeoutMs;
    // A 30 s UI deadline reported a 45 s pipeline as failed while the host was
    // still running it under a 300 s budget; a deadline equal to that budget
    // starts first and ends first, before the host's answer to a run the
    // budget stopped. The host answers every run, so the page waits out the
    // longest budget the setting accepts.
    expect(typeof timeoutMs).toBe('number');
    expect(timeoutMs as number).toBeGreaterThan(manifestPipelineTimeout().maximum);
  });

  it('should still listen on the pipeline:run:response channel', () => {
    renderHook(() => useAutomationPageData());

    expect(mutationOptions.get('pipeline:execute')?.responseType).toBe('pipeline:run:response');
  });

  it('should read a numeric default and maximum for sandforge.pipeline.timeout from the manifest', () => {
    // Guards the assertion above: if the setting is renamed or dropped, this
    // fails loudly instead of the comparison silently passing on undefined.
    const { default: byDefault, maximum } = manifestPipelineTimeout();
    expect(byDefault).toBeGreaterThan(0);
    expect(maximum).toBeGreaterThanOrEqual(byDefault);
  });
});

/** Notifications carrying `message`, whatever their level. */
function messages(message: string): NotificationInput[] {
  return notifications.filter((n) => n.message === message);
}

describe('useAutomationPageData — the save is announced only when acknowledged', () => {
  const savedMessage = i18n.t('automation.pipelineSaved');

  it('should stay silent between the click and the reply', () => {
    const { result } = renderHook(() => useAutomationPageData());
    act(() => result.current.handleCreatePipeline());

    act(() => result.current.handleSavePipeline());

    // The request left; nothing has come back yet.
    expect(mutationFor('pipeline:save').mutate).toHaveBeenCalledTimes(1);
    // The toast used to fire on the line after mutate(), so the user read
    // "saved" before a single byte had been written.
    expect(messages(savedMessage)).toEqual([]);
  });

  it('should announce the save once pipeline:save:response acknowledges it', () => {
    const { result, rerender } = renderHook(() => useAutomationPageData());
    act(() => result.current.handleCreatePipeline());
    act(() => result.current.handleSavePipeline());
    expect(messages(savedMessage)).toEqual([]);

    mutationFor('pipeline:save').data = { success: true, id: 'pipe-1' };
    rerender();

    expect(messages(savedMessage)).toHaveLength(1);
    expect(messages(savedMessage)[0].level).toBe('success');
  });

  it('should report the failure instead of the success when the host rejects the save', () => {
    const { result, rerender } = renderHook(() => useAutomationPageData());
    act(() => result.current.handleCreatePipeline());
    act(() => result.current.handleSavePipeline());

    // handlePipelineSave replies on `pipeline:error`, the mutation's default
    // error channel; useBridgeMutation surfaces it as `error`.
    mutationFor('pipeline:save').error = 'ConfigStore is read-only';
    rerender();

    expect(messages(savedMessage)).toEqual([]);
    expect(messages('ConfigStore is read-only')).toHaveLength(1);
    expect(messages('ConfigStore is read-only')[0].level).toBe('error');
    expect(result.current.error).toBe('ConfigStore is read-only');
  });
});

describe('useAutomationPageData — the AI-generated pipeline reaches the canvas', () => {
  it('should load the generated pipeline when the response arrives', () => {
    const { result, rerender } = renderHook(() => useAutomationPageData());
    act(() => result.current.setGenDescription('sync accounts nightly'));
    act(() => result.current.handleGenSubmit());

    expect(mutationFor('ai:generate-pipeline').mutate).toHaveBeenCalledWith({
      description: 'sync accounts nightly',
    });
    // Before the reply there is nothing to show — that part was never the bug.
    expect(result.current.pipeline).toBeUndefined();

    mutationFor('ai:generate-pipeline').data = {
      success: true,
      pipeline: {
        name: 'Pipeline_SyncAccountsNightly',
        description: 'sync accounts nightly',
        steps: [{ name: 'Sync accounts', type: 'sync', config: { objects: ['Account'] } }],
        schedule: '0 2 * * *',
      },
    };
    rerender();

    // The response used to be dropped: the user waited, then got nothing.
    expect(result.current.pipeline?.name).toBe('Pipeline_SyncAccountsNightly');
    expect(result.current.stepCount).toBe(1);
    expect(result.current.pipeline?.steps[0].type).toBe('sync');
    expect(result.current.pipeline?.steps[0].config).toEqual({ objects: ['Account'] });
    expect(result.current.pipeline?.triggers[0]).toMatchObject({
      type: 'schedule',
      enabled: true,
      // In the reader's time zone, as a schedule added by hand.
      config: { cron: '0 2 * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    });
    expect(result.current.activeTab).toBe('canvas');
  });

  it('should keep a step the canvas cannot type rather than lose it', () => {
    const { result, rerender } = renderHook(() => useAutomationPageData());

    // The host generator maps keywords to strings that are not PipelineStepType
    // members ('dataops', 'monitor'), and emits 'error_detected' as a trigger.
    mutationFor('ai:generate-pipeline').data = {
      success: true,
      pipeline: {
        name: 'Nightly refresh',
        steps: [{ name: 'Anonymize PII', type: 'dataops', config: {} }],
        triggers: ['error_detected', 'sandbox_refresh'],
      },
    };
    rerender();

    expect(result.current.stepCount).toBe(1);
    expect(result.current.pipeline?.steps[0].name).toBe('Anonymize PII');
    expect(result.current.pipeline?.steps[0].type).toBe('script');
    expect(result.current.pipeline?.triggers.map((tr) => tr.type)).toEqual(['sandbox_refresh']);
  });

  it('should explain a refused generation instead of failing silently', () => {
    const { result, rerender } = renderHook(() => useAutomationPageData());

    mutationFor('ai:generate-pipeline').data = {
      success: false,
      error: 'AI not configured. Set your API key in Settings > AI to enable this feature.',
    };
    rerender();

    const reason = 'AI not configured. Set your API key in Settings > AI to enable this feature.';
    expect(result.current.pipeline).toBeUndefined();
    expect(messages(reason)).toHaveLength(1);
    expect(messages(reason)[0].level).toBe('error');
    expect(result.current.error).toBe(reason);
  });

  it('should surface a generation that failed on the bridge itself', () => {
    const { result, rerender } = renderHook(() => useAutomationPageData());

    // `ai:error` and the 30 s timeout had no reader at all on this page.
    mutationFor('ai:generate-pipeline').error = "Bridge mutation 'ai:generate-pipeline' timed out";
    rerender();

    expect(result.current.error).toBe("Bridge mutation 'ai:generate-pipeline' timed out");
    expect(messages("Bridge mutation 'ai:generate-pipeline' timed out")).toHaveLength(1);
  });
});

describe('useAutomationPageData — marketplace install', () => {
  const template = {
    id: 'tpl-nightly',
    name: 'Nightly sandbox refresh',
    description: 'Refresh then reseed',
  };

  it('should ask the host to install, and claim nothing before it answers', () => {
    // It used to build an EMPTY pipeline wearing the template's name and toast
    // "Template installed as new pipeline" — the steps never crossed the bridge.
    const { result } = renderHook(() => useAutomationPageData());

    act(() => result.current.handleInstallTemplate(template));

    expect(mutationFor('marketplace:install').mutate).toHaveBeenCalledWith({
      templateId: 'tpl-nightly',
    });
    expect(result.current.pipeline).toBeUndefined();
    expect(messages(i18n.t('automation.templateInstalled'))).toEqual([]);
    expect(notifications.some((n) => n.level === 'success')).toBe(false);
  });

  it('should load the installed pipeline once the host returns it', () => {
    const { result, rerender } = renderHook(() => useAutomationPageData());

    act(() => result.current.handleInstallTemplate(template));

    mutationFor('marketplace:install').data = {
      success: true,
      pipeline: { name: 'Nightly sandbox refresh', steps: [{ id: 's1', type: 'seed' }] },
    };
    rerender();

    expect(result.current.pipeline?.steps).toHaveLength(1);
    expect(messages(i18n.t('automation.templateInstalled'))).toHaveLength(1);
  });

  it('should report the host refusal instead of a success', () => {
    const { result, rerender } = renderHook(() => useAutomationPageData());

    act(() => result.current.handleInstallTemplate(template));

    mutationFor('marketplace:install').data = {
      success: false,
      error: 'Template "tpl-nightly" not found.',
    };
    rerender();

    expect(result.current.pipeline).toBeUndefined();
    expect(result.current.error).toBe('Template "tpl-nightly" not found.');
    expect(notifications.some((n) => n.level === 'success')).toBe(false);
  });
});

describe('useAutomationPageData — the History tab follows the runs', () => {
  it('should ask for the history again once a run answers', () => {
    // The host writes the run when it ends but only answers pipeline:history
    // on request; fetched once on mount, the tab stayed empty after a run.
    const { result, rerender } = renderHook(() => useAutomationPageData());
    act(() => result.current.handleCreatePipeline());
    act(() => result.current.handleRunPipeline());
    expect(refetchFor('pipeline:history')).not.toHaveBeenCalled();

    mutationFor('pipeline:execute').data = { runId: 'run-1', status: 'failed' };
    rerender();

    expect(refetchFor('pipeline:history')).toHaveBeenCalledTimes(1);
  });

  it('should not ask again while no run has answered', () => {
    const { rerender } = renderHook(() => useAutomationPageData());
    rerender();

    expect(refetchFor('pipeline:history')).not.toHaveBeenCalled();
  });
});

describe('useAutomationPageData — a pipeline with a step that cannot run is not sent', () => {
  it('does not add a step of a type that cannot run', () => {
    const { result } = renderHook(() => useAutomationPageData());
    act(() => result.current.handleCreatePipeline());

    act(() => result.current.handleAddStep('seed'));
    act(() => result.current.handleAddStep('condition'));
    expect(result.current.stepCount).toBe(0);

    act(() => result.current.handleAddStep('delay'));
    expect(result.current.stepCount).toBe(1);
  });

  it('marks every step of an AI draft that cannot run, and refuses to send it', () => {
    const { result, rerender } = renderHook(() => useAutomationPageData());

    mutationFor('ai:generate-pipeline').data = {
      success: true,
      pipeline: {
        name: 'Nightly refresh',
        steps: [
          { name: 'Copy accounts', type: 'sync', config: {} },
          // 'dataops' is not a step type: it lands as a script step.
          { name: 'Mask PII', type: 'dataops', config: {} },
        ],
      },
    };
    rerender();

    expect(
      result.current.runBlockers.map((blocked) => [blocked.stepName, blocked.blocker]),
    ).toEqual([
      ['Copy accounts', 'writesToOrg'],
      ['Mask PII', 'typeCannotRun'],
    ]);

    act(() => result.current.handleRunPipeline());
    expect(mutationFor('pipeline:execute').mutate).not.toHaveBeenCalled();
  });

  it('marks an installed template that holds a step that cannot run', () => {
    const { result, rerender } = renderHook(() => useAutomationPageData());

    mutationFor('marketplace:install').data = {
      success: true,
      pipeline: {
        name: 'API Limit Monitoring',
        steps: [
          { name: 'Check API Usage', type: 'precheck', config: {} },
          // A condition written in `config` is no condition at all.
          { name: 'Evaluate Thresholds', type: 'condition', config: { field: 'x' } },
        ],
      },
    };
    rerender();

    expect(result.current.runBlockers.map((blocked) => blocked.blocker)).toEqual([
      'needsOrg',
      'conditionNeedsCondition',
    ]);
  });

  it('keeps the condition an installed Condition step carries, so it can run', () => {
    const { result, rerender } = renderHook(() => useAutomationPageData());

    // The API Limit Monitoring template as the host exports it now.
    mutationFor('marketplace:install').data = {
      success: true,
      pipeline: {
        name: 'API Limit Monitoring',
        steps: [
          { name: 'Check API Usage', type: 'precheck', config: { checks: ['apiLimits'] } },
          {
            name: 'Evaluate Thresholds',
            type: 'condition',
            config: {},
            condition: { field: 'apiUsagePercent', operator: 'gt', value: 60 },
          },
          {
            name: 'Show Notification',
            type: 'notification',
            config: { message: 'API usage has passed 60% of the daily limit.' },
          },
        ],
      },
    };
    rerender();

    expect(result.current.pipeline?.steps[1].condition).toEqual({
      field: 'apiUsagePercent',
      operator: 'gt',
      value: 60,
    });
    // Only the org the pre-check reads is left to choose.
    expect(
      result.current.runBlockers.map((blocked) => [blocked.stepName, blocked.blocker]),
    ).toEqual([['Check API Usage', 'needsOrg']]);
  });

  it('sends a pipeline whose every step can run', () => {
    const { result } = renderHook(() => useAutomationPageData());
    act(() => result.current.handleCreatePipeline());
    act(() => result.current.handleAddStep('delay'));
    const [step] = result.current.pipeline?.steps ?? [];
    act(() => result.current.handleUpdateStep(step.id, { config: { seconds: 1 } }));

    expect(result.current.runBlockers).toEqual([]);
    act(() => result.current.handleRunPipeline());
    expect(mutationFor('pipeline:execute').mutate).toHaveBeenCalledTimes(1);
  });
});

describe('useAutomationPageData — a failed run says why', () => {
  it('reports the host reason under a translated headline', () => {
    const { result, rerender } = renderHook(() => useAutomationPageData());
    const reason =
      'Pipeline did not start: Step "Load" is a seed step, and this step type cannot run in a pipeline yet.';

    mutationFor('pipeline:execute').data = { id: 'run-1', status: 'failed', error: reason };
    rerender();

    const message = i18n.t('automation.runFailed', { reason });
    expect(message).toBe(`The pipeline run failed: ${reason}`);
    expect(result.current.error).toBe(message);
    expect(messages(message)).toHaveLength(1);
    expect(messages(message)[0].level).toBe('error');
  });

  it("falls back to the first failed step's error when the run carries none", () => {
    const { result, rerender } = renderHook(() => useAutomationPageData());

    mutationFor('pipeline:execute').data = {
      id: 'run-2',
      status: 'failed',
      stepResults: [
        { stepId: 'a', status: 'completed' },
        { stepId: 'b', status: 'failed', error: 'Step execution timed out' },
      ],
    };
    rerender();

    expect(result.current.error).toBe('The pipeline run failed: Step execution timed out');
  });

  it('adds nothing to a run that completed', () => {
    const { result, rerender } = renderHook(() => useAutomationPageData());

    mutationFor('pipeline:execute').data = { id: 'run-3', status: 'completed', stepResults: [] };
    rerender();

    expect(result.current.error).toBeNull();
    expect(notifications.some((n) => n.level === 'error')).toBe(false);
    expect(refetchFor('pipeline:history')).toHaveBeenCalledTimes(1);
  });
});

describe('useAutomationPageData — a run in progress', () => {
  /** A pipeline of two steps, running under the request `wv-run-1`. */
  function startRun(): { result: { current: ReturnType<typeof useAutomationPageData> } } {
    const hook = renderHook(() => useAutomationPageData());
    act(() => hook.result.current.handleCreatePipeline());
    act(() => hook.result.current.handleAddStep('delay'));
    act(() => hook.result.current.handleAddStep('delay'));
    const [first, second] = hook.result.current.pipeline?.steps ?? [];
    act(() => hook.result.current.handleUpdateStep(first.id, { config: { seconds: 1 } }));
    act(() => hook.result.current.handleUpdateStep(second.id, { config: { seconds: 1 } }));
    act(() => hook.result.current.handleRunPipeline());
    mutationFor('pipeline:execute').loading = true;
    mutationFor('pipeline:execute').requestId = 'wv-run-1';
    hook.rerender();
    return hook;
  }

  it('follows each step as the extension reports it, and no other run', () => {
    const { result } = startRun();
    const [first, second] = result.current.pipeline?.steps ?? [];
    expect(result.current.executionData?.steps.map((s) => s.status)).toEqual([
      'pending',
      'pending',
    ]);

    receive('pipeline:step', { operationId: 'wv-run-1', stepId: first.id, status: 'running' });
    expect(result.current.executionData?.steps.map((s) => s.status)).toEqual([
      'running',
      'pending',
    ]);

    receive('pipeline:step', {
      operationId: 'wv-run-1',
      stepId: first.id,
      status: 'completed',
      duration: 1000,
      summary: 'Waited 1 s.',
    });
    // Another run's step, reported to every panel, is not this run's.
    receive('pipeline:step', { operationId: 'wv-other', stepId: second.id, status: 'failed' });

    expect(result.current.executionData?.steps.map((s) => s.status)).toEqual([
      'completed',
      'pending',
    ]);
    expect(result.current.executionData?.steps[0].summary).toBe('Waited 1 s.');
    expect(result.current.executionData?.progress).toBe(50);
  });

  it('cancels its own run on execution:abort, which stops the run in the extension', () => {
    const { result } = startRun();

    act(() => result.current.handleCancelRun());

    expect(posted).toHaveBeenCalledOnce();
    const envelope = posted.mock.calls[0][0] as {
      payload: { type: string; payload: { operationId: string } };
    };
    expect(envelope.payload.type).toBe('execution:abort');
    expect(envelope.payload.payload.operationId).toBe('wv-run-1');
  });

  it('sends no cancel before a run has started', () => {
    const { result } = renderHook(() => useAutomationPageData());
    act(() => result.current.handleCancelRun());
    expect(posted).not.toHaveBeenCalled();
  });
});

describe('useAutomationPageData — triggers', () => {
  /** A saved pipeline with one schedule trigger. */
  function saved(id: string, cron = '0 2 * * *'): PipelineDefinition {
    return {
      id,
      name: `Pipeline ${id}`,
      description: '',
      version: 1,
      steps: [],
      triggers: [
        { id: `${id}-t`, type: 'schedule', enabled: true, config: { cron, timezone: 'UTC' } },
      ],
      variables: [],
      tags: [],
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
  }

  /** What the extension says of the schedule of the saved pipeline `id`. */
  function statusOf(id: string, nextRunAt: string): PipelineTriggerStatus {
    return {
      pipelineId: id,
      triggerId: `${id}-t`,
      type: 'schedule',
      armed: true,
      timezone: 'UTC',
      nextRunAt,
    };
  }

  afterEach(() => {
    vi.useRealTimers();
    useOrgStore.setState({ orgs: [] });
  });

  it('gives the trigger panel what the extension says of the pipeline on the canvas, and of no other', () => {
    const p1 = saved('p1');
    const p2 = saved('p2');
    queryData.set('pipeline:list', {
      pipelines: [p1, p2],
      triggers: [
        statusOf('p1', '2099-01-01T02:00:00.000Z'),
        statusOf('p2', '2099-01-01T02:00:00.000Z'),
      ],
    });
    const { result } = renderHook(() => useAutomationPageData());
    act(() => result.current.handleLoadPipeline(p1));

    expect(result.current.triggerStatuses.map((status) => status.pipelineId)).toEqual(['p1']);
    expect(result.current.savedTriggers).toEqual(p1.triggers);
    // The Scheduler tab lists the schedule of every saved pipeline.
    expect(
      result.current.pipelineSchedules.map((row) => [row.pipelineName, row.status?.pipelineId]),
    ).toEqual([
      ['Pipeline p1', 'p1'],
      ['Pipeline p2', 'p2'],
    ]);
  });

  it('asks for the saved pipelines again once a save is acknowledged, so what a trigger does follows the save', () => {
    const { result, rerender } = renderHook(() => useAutomationPageData());
    act(() => result.current.handleCreatePipeline());
    act(() => result.current.handleSavePipeline());
    expect(refetchFor('pipeline:list')).not.toHaveBeenCalled();

    mutationFor('pipeline:save').data = { success: true, id: 'p1' };
    rerender();
    expect(refetchFor('pipeline:list')).toHaveBeenCalledTimes(1);
  });

  it('asks for the history again when a run a trigger started ends, and for no other operation', () => {
    renderHook(() => useAutomationPageData());
    receive('operation:completed', { operationId: 'pipeline:trigger:6f1c', result: {} });
    expect(refetchFor('pipeline:history')).toHaveBeenCalledTimes(1);
    expect(refetchFor('pipeline:list')).toHaveBeenCalledTimes(1);

    receive('operation:failed', {
      operationId: 'pipeline:trigger:7a2d',
      error: 'x',
      retryable: false,
    });
    expect(refetchFor('pipeline:history')).toHaveBeenCalledTimes(2);

    // A sync, or a run from a page, is not a run a trigger started.
    receive('operation:completed', { operationId: 'sync:schedule:1', result: {} });
    receive('operation:failed', { operationId: 'wv-1', error: 'x', retryable: false });
    expect(refetchFor('pipeline:history')).toHaveBeenCalledTimes(2);
  });

  it('asks again a moment after the soonest planned start, when its run is in the history', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T01:59:00.000Z'));
    queryData.set('pipeline:list', {
      pipelines: [saved('p1'), saved('p2', '0 3 * * *')],
      triggers: [
        statusOf('p1', '2026-09-23T02:00:00.000Z'),
        statusOf('p2', '2026-09-23T03:00:00.000Z'),
      ],
    });
    renderHook(() => useAutomationPageData());

    act(() => vi.advanceTimersByTime(60_000));
    expect(refetchFor('pipeline:history')).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(5_000));
    expect(refetchFor('pipeline:history')).toHaveBeenCalledTimes(1);
    expect(refetchFor('pipeline:list')).toHaveBeenCalledTimes(1);
  });

  it('works out when to ask again from the armed schedules only', () => {
    const now = Date.parse('2026-09-23T01:59:00.000Z');
    expect(nextTriggerRefreshDelay([], now)).toBeUndefined();
    expect(
      nextTriggerRefreshDelay(
        [{ ...statusOf('p1', '2026-09-23T02:00:00.000Z'), armed: false, idle: 'disabled' }],
        now,
      ),
    ).toBeUndefined();
    expect(nextTriggerRefreshDelay([statusOf('p1', '2026-09-23T02:00:00.000Z')], now)).toBe(65_000);
    // A start already past is asked about once the extension has looked at it,
    // within a minute; a far one no later than six hours.
    expect(nextTriggerRefreshDelay([statusOf('p1', '2026-09-23T01:00:00.000Z')], now)).toBe(65_000);
    expect(nextTriggerRefreshDelay([statusOf('p1', '2026-12-25T00:00:00.000Z')], now)).toBe(
      6 * 60 * 60_000,
    );
  });

  it('adds a schedule read in the time zone of the person who writes it', () => {
    const { result } = renderHook(() => useAutomationPageData());
    act(() => result.current.handleCreatePipeline());
    act(() => result.current.handleAddTrigger('schedule'));
    act(() => result.current.handleAddTrigger('sandbox_refresh'));
    const [schedule, refresh] = result.current.pipeline?.triggers ?? [];
    expect(schedule.config).toEqual({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(refresh.config).toEqual({});
  });

  it('changes the expression and the time zone of a trigger, one field at a time', () => {
    const { result } = renderHook(() => useAutomationPageData());
    act(() => result.current.handleCreatePipeline());
    act(() => result.current.handleAddTrigger('schedule'));
    const id = result.current.pipeline?.triggers[0].id ?? '';
    act(() => result.current.handleUpdateTriggerConfig(id, { cron: '0 2 * * *' }));
    act(() => result.current.handleUpdateTriggerConfig(id, { timezone: 'Asia/Tokyo' }));
    expect(result.current.pipeline?.triggers[0].config).toEqual({
      cron: '0 2 * * *',
      timezone: 'Asia/Tokyo',
    });
  });

  it('offers the registered sandboxes to a sandbox refresh trigger, and no other org', () => {
    useOrgStore.setState({
      orgs: [
        { id: 'org-uat', alias: 'uat', username: 'u1', orgType: 'Sandbox' },
        { id: 'org-prod', alias: 'prod', username: 'u2', orgType: 'Production' },
        { id: 'org-dev', alias: '', username: 'admin@example.test.dev', orgType: 'Sandbox' },
      ] as unknown as SalesforceOrg[],
    });
    const { result } = renderHook(() => useAutomationPageData());
    expect(result.current.sandboxes).toEqual([
      { id: 'org-uat', alias: 'uat' },
      { id: 'org-dev', alias: 'admin@example.test.dev' },
    ]);
  });
});
