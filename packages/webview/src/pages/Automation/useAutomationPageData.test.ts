import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderHook, act } from '@testing-library/react';
import i18n from '../../i18n';
import type { NotificationInput } from '../../stores/useNotificationStore';
import { useAutomationPageData } from './useAutomationPageData';

/** Options captured from every useBridgeMutation call, keyed by request type. */
const mutationOptions = new Map<string, Record<string, unknown> | undefined>();

/** Mutable double standing in for one useBridgeMutation return value. */
interface MutationDouble {
  mutate: ReturnType<typeof vi.fn>;
  data: unknown;
  loading: boolean;
  error: string | null;
  reset: ReturnType<typeof vi.fn>;
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

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({ data: null, loading: false, error: null, refetch: vi.fn() }),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string, options?: Record<string, unknown>) => {
    mutationOptions.set(type, options);
    return mutationFor(type);
  },
}));

/** `sandforge.pipeline.timeout` default, read from the extension manifest. */
function manifestPipelineTimeoutDefault(): number {
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
      configuration: { properties: Record<string, { default?: unknown }> };
    };
  };
  const setting = manifest.contributes.configuration.properties['sandforge.pipeline.timeout'];
  if (typeof setting?.default !== 'number') {
    throw new Error('sandforge.pipeline.timeout has no numeric default in the extension manifest');
  }
  return setting.default;
}

beforeEach(() => {
  mutationOptions.clear();
  mutationDoubles.clear();
  notifications.length = 0;
});

describe('useAutomationPageData — pipeline execution timeout', () => {
  it('should not give up on a run before the host does', () => {
    renderHook(() => useAutomationPageData());

    const options = mutationOptions.get('pipeline:execute');
    // A 30 s UI deadline reported a 45 s pipeline as failed while the host was
    // still running it under a 300 s budget.
    expect(options?.timeoutMs).toBe(manifestPipelineTimeoutDefault());
  });

  it('should still listen on the pipeline:run:response channel', () => {
    renderHook(() => useAutomationPageData());

    expect(mutationOptions.get('pipeline:execute')?.responseType).toBe('pipeline:run:response');
  });

  it('should read a numeric default for sandforge.pipeline.timeout from the manifest', () => {
    // Guards the assertion above: if the setting is renamed or dropped, this
    // fails loudly instead of the comparison silently passing on undefined.
    expect(manifestPipelineTimeoutDefault()).toBeGreaterThan(0);
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
      config: { cron: '0 2 * * *' },
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
