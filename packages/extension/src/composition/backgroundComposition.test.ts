import { describe, it, expect, vi, beforeEach } from 'vitest';

// backgroundComposition imports vscode for ProductionGuard confirmations and
// for l10n. `l10n.t` is stubbed with the host's semantics — look the source
// string up in a bundle, fall back to it, then interpolate `{0}`. The bundle
// carries a single entry so the action label of the production modal is
// genuinely translated while the rest stays English and readable.
const l10nBundle = vi.hoisted(() => ({ current: {} as Record<string, string> }));

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  l10n: {
    t: (message: string, ...args: unknown[]): string =>
      (l10nBundle.current[message] ?? message).replace(/\{(\d+)\}/g, (_m, i: string) =>
        String(args[Number(i)] ?? ''),
      ),
  },
}));

import * as vscode from 'vscode';
import {
  createBackgroundComposition,
  wireOfflineNotifications,
  wireOfflineReplay,
} from './backgroundComposition';
import type { Services } from '../services';
import type { SafetyCheckResult } from '../core/precheck/ProductionGuard';
import { OfflineManager } from '../core/connection/OfflineManager';
import type { ConfigStore } from '../core/storage/ConfigStore';
import type { ExtensionHandlers } from '../bridge/ExtensionHandlers';

function createMockConfigStore(): ConfigStore {
  const data = new Map<string, unknown>();
  return {
    get: vi.fn(<T>(key: string): T | undefined => data.get(key) as T | undefined),
    set: vi.fn((key: string, value: unknown): void => {
      data.set(key, value);
    }),
  } as unknown as ConfigStore;
}

describe('wireOfflineReplay', () => {
  it('replays queued operations through the handlers when connectivity returns', async () => {
    const manager = new OfflineManager(createMockConfigStore());
    const replay = vi.fn().mockResolvedValue(undefined);
    const handlers = { replayQueuedOperation: replay } as unknown as ExtensionHandlers;

    wireOfflineReplay(manager, handlers);

    manager.enqueue({ id: 'q-1', type: 'sync', orgId: 'tgt-org', payload: { config: {} } });
    manager.setStatus('offline');
    // Coming back online drains the queue through the wired executor.
    manager.setStatus('online');

    // Wait for the full drain (the queue shift happens after the executor
    // promise resolves).
    await vi.waitFor(() => expect(manager.getQueueSize()).toBe(0));
    expect(replay).toHaveBeenCalledTimes(1);
    expect(replay.mock.calls[0][0].id).toBe('q-1');
    manager.dispose();
  });

  it('keeps the queue parked while no executor outcome is possible (offline)', () => {
    const manager = new OfflineManager(createMockConfigStore());
    const replay = vi.fn().mockResolvedValue(undefined);
    const handlers = { replayQueuedOperation: replay } as unknown as ExtensionHandlers;

    wireOfflineReplay(manager, handlers);

    manager.enqueue({ id: 'q-2', type: 'seed', orgId: 'org-1', payload: {} });
    manager.setStatus('offline');

    expect(replay).not.toHaveBeenCalled();
    expect(manager.getQueueSize()).toBe(1);
    manager.dispose();
  });

  it('drains an operation enqueued while already online (failed replay re-enqueue)', async () => {
    const manager = new OfflineManager(createMockConfigStore());
    const replay = vi.fn().mockResolvedValue(undefined);
    const handlers = { replayQueuedOperation: replay } as unknown as ExtensionHandlers;

    wireOfflineReplay(manager, handlers);

    // Status is 'online' by default: the enqueue must schedule a drain on its
    // own, without waiting for an offline→online transition.
    manager.enqueue({ id: 'q-3', type: 'sync', orgId: 'org-1', payload: { config: {} } });

    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(manager.getQueueSize()).toBe(0));
    manager.dispose();
  });
});

describe('wireOfflineNotifications', () => {
  beforeEach(() => {
    vi.mocked(vscode.window.showInformationMessage).mockClear();
    vi.mocked(vscode.window.showWarningMessage).mockClear();
  });

  it('notifies when an operation is queued', () => {
    const manager = new OfflineManager(createMockConfigStore());
    wireOfflineNotifications(manager);

    manager.enqueue({ id: 'q-1', type: 'sync', orgId: 'org-1', payload: {} });

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('queued'),
    );
    manager.dispose();
  });

  it('notifies when a queued operation is restarted', async () => {
    const manager = new OfflineManager(createMockConfigStore());
    wireOfflineNotifications(manager);
    manager.setOperationExecutor(vi.fn().mockResolvedValue(undefined));

    manager.setStatus('offline');
    manager.enqueue({ id: 'q-2', type: 'sync', orgId: 'org-1', payload: {} });
    await manager.drainQueue();

    // The drain cannot know whether the replay succeeded (startExecution
    // returns right after registry registration), so the wording stays honest:
    // the operation was restarted, not "replayed".
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('restarted'),
    );
    manager.dispose();
  });

  it('warns when a queued operation fails to replay', async () => {
    const manager = new OfflineManager(createMockConfigStore());
    wireOfflineNotifications(manager);
    manager.setOperationExecutor(vi.fn().mockRejectedValue(new Error('replay boom')));

    manager.setStatus('offline');
    manager.enqueue({ id: 'q-3', type: 'sync', orgId: 'org-1', payload: {} });
    await manager.drainQueue();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('dropped'),
    );
    manager.dispose();
  });
});

describe('production confirmation modal (localized)', () => {
  const services = {
    getSandforgeSetting: <T>(_key: string, fallback: T): T => fallback,
  } as unknown as Services;

  /** A check result that actually reaches the confirmation UI. */
  const needsConfirmation: SafetyCheckResult = {
    allowed: true,
    requiresConfirmation: true,
    requiresApproval: false,
    impactSummary: '1 200 records on Account',
    warnings: [],
  };

  beforeEach(() => {
    vi.mocked(vscode.window.showWarningMessage).mockReset();
    l10nBundle.current = {};
  });

  it('accepts the confirmation when the action label is translated', async () => {
    l10nBundle.current = { Execute: 'Exécuter' };
    // The host hands back the label of the button the user pressed.
    vi.mocked(vscode.window.showWarningMessage).mockImplementation(
      (...args: unknown[]) => Promise.resolve(args[args.length - 1]) as never,
    );

    const { productionGuard } = createBackgroundComposition({
      services,
      configStore: createMockConfigStore(),
    });
    const confirmed = await productionGuard.confirmIfNeeded(needsConfirmation);

    // Comparing the choice against a hardcoded English 'Execute' would deny
    // every production write for a translated UI.
    expect(confirmed).toBe(true);
    const call = vi.mocked(vscode.window.showWarningMessage).mock.calls[0];
    expect(call[call.length - 1]).toBe('Exécuter');
  });

  it('still declines when the user dismisses the modal', async () => {
    l10nBundle.current = { Execute: 'Exécuter' };
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);

    const { productionGuard } = createBackgroundComposition({
      services,
      configStore: createMockConfigStore(),
    });

    await expect(productionGuard.confirmIfNeeded(needsConfirmation)).resolves.toBe(false);
  });

  it('routes the modal body through l10n with the impact summary interpolated', async () => {
    l10nBundle.current = {
      '{0}\n\nThis operation writes data to a PRODUCTION org.':
        '{0}\n\nCette opération écrit des données dans une org de PRODUCTION.',
    };
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);

    const { productionGuard } = createBackgroundComposition({
      services,
      configStore: createMockConfigStore(),
    });
    await productionGuard.confirmIfNeeded(needsConfirmation);

    const options = vi.mocked(vscode.window.showWarningMessage).mock.calls[0][1] as {
      modal: boolean;
      detail: string;
    };
    expect(options.modal).toBe(true);
    expect(options.detail).toBe(
      '1 200 records on Account\n\nCette opération écrit des données dans une org de PRODUCTION.',
    );
  });
});
