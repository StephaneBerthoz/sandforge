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
  confirmRestoreIntoReplacedOrg,
  createBackgroundComposition,
  runQuestionDetail,
  wireBackgroundNotifications,
  wireOfflineNotifications,
  wireOfflineReplay,
} from './backgroundComposition';
import type { Services } from '../services';
import type {
  AutomationConfirmation,
  SafetyCheckResult,
  WriteConfirmation,
} from '../core/precheck/ProductionGuard';
import { OfflineManager } from '../core/connection/OfflineManager';
import { BackgroundOperationRegistry } from '../core/engine/BackgroundOperationRegistry';
import type { ConfigStore } from '../core/storage/ConfigStore';
import type { ExtensionHandlers } from '../bridge/ExtensionHandlers';
import type { WebviewStateSync } from '../bridge/WebviewStateSync';
import type { WebviewPanelManager } from '../providers/WebviewPanelManager';

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
    const confirmed = await productionGuard.confirmIfNeeded(needsConfirmation, 'production');

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

    await expect(productionGuard.confirmIfNeeded(needsConfirmation, 'production')).resolves.toBe(
      false,
    );
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
    await productionGuard.confirmIfNeeded(needsConfirmation, 'production');

    const options = vi.mocked(vscode.window.showWarningMessage).mock.calls[0][1] as {
      modal: boolean;
      detail: string;
    };
    expect(options.modal).toBe(true);
    expect(options.detail).toBe(
      '1 200 records on Account\n\nCette opération écrit des données dans une org de PRODUCTION.',
    );
  });

  it('does not tell a confirmation another tier asks for that it writes to production', async () => {
    // Staging asks before a delete, a deployment or a large volume, and the
    // modal said "SandForge: production operation … writes data to a
    // PRODUCTION org" over it all the same.
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);

    const { productionGuard } = createBackgroundComposition({
      services,
      configStore: createMockConfigStore(),
    });
    await productionGuard.confirmIfNeeded(needsConfirmation, 'staging');

    const [title, options] = vi.mocked(vscode.window.showWarningMessage).mock.calls[0] as [
      string,
      { modal: boolean; detail: string },
    ];
    expect(title).toBe('SandForge: operation to confirm');
    expect(options.detail).toBe(
      '1 200 records on Account\n\nThis operation needs your confirmation before it runs.',
    );
    expect(`${title} ${options.detail}`).not.toMatch(/production/i);
  });
});

describe("a run's questions, in the production confirmation's modal (localized)", () => {
  const services = {
    getSandforgeSetting: <T>(_key: string, fallback: T): T => fallback,
  } as unknown as Services;

  const automation: AutomationConfirmation = {
    stage: 'automation',
    org: 'DEV',
    orgTier: 'development',
    fired: [
      { objectApiName: 'Contact', kind: 'trigger', name: 'ContactTrigger' },
      { objectApiName: 'Contact', kind: 'flow', name: 'Contact welcome' },
    ],
    unread: [],
    bypass: ['Load_Data'],
  };

  const write: WriteConfirmation = {
    stage: 'write',
    org: 'DEV',
    orgTier: 'development',
    objects: [
      { objectApiName: 'Contact', rows: 2_400 },
      { objectApiName: 'Account', rows: 1 },
    ],
    total: 2_401,
    aboveRecords: 2_000,
    storage: { estimateMB: 4.69, maxMB: 200, remainingMB: 150, near: false },
  };

  beforeEach(() => {
    vi.mocked(vscode.window.showWarningMessage).mockReset();
    l10nBundle.current = {};
  });

  it('names each flow and trigger that fires as the clone inserts, and what keeps flows quiet', () => {
    expect(runQuestionDetail(automation).split('\n')).toEqual([
      'DEV runs automation on the records this clone inserts:',
      '• Contact: Apex trigger ContactTrigger',
      '• Contact: Flow "Contact welcome"',
      'They run on every record the clone inserts, and what they send goes out as it would for a record created by hand.',
      'A user who holds Load_Data does not start some of these Flows: assign it to the user the clone writes as to keep them quiet.',
      'Nothing has been read or written yet.',
    ]);
  });

  it('says what could not be read, and that what fires is then not known', () => {
    expect(
      runQuestionDetail({
        ...automation,
        fired: [],
        bypass: [],
        unread: [
          { part: 'triggers', reason: 'INSUFFICIENT_ACCESS' },
          { part: 'automation', reason: 'session expired' },
        ],
      }).split('\n'),
    ).toEqual([
      'The Apex triggers of DEV could not be read (INSUFFICIENT_ACCESS).',
      'The automation of DEV could not be read (session expired).',
      'What fires as the clone inserts its records is not known.',
      'Nothing has been read or written yet.',
    ]);
  });

  it('names a process and a workflow rule for what they are, and says when they could not be read', () => {
    expect(
      runQuestionDetail({
        ...automation,
        fired: [
          { objectApiName: 'Lead', kind: 'workflowRule', name: 'Lead alert' },
          { objectApiName: 'Lead', kind: 'process', name: 'Lead routing' },
        ],
        bypass: [],
        unread: [
          { part: 'processes', reason: 'P' },
          { part: 'workflowRules', reason: 'W' },
        ],
      }).split('\n'),
    ).toEqual([
      'DEV runs automation on the records this clone inserts:',
      '• Lead: workflow rule "Lead alert"',
      '• Lead: process "Lead routing"',
      'They run on every record the clone inserts, and what they send goes out as it would for a record created by hand.',
      'The Process Builder processes of DEV could not be read (P).',
      'The workflow rules of DEV could not be read (W).',
      'What fires as the clone inserts its records is not known.',
      'Nothing has been read or written yet.',
    ]);
  });

  it('lists the records per object, the setting the total is past, and the storage they take', () => {
    expect(runQuestionDetail(write).split('\n')).toEqual([
      'This clone is about to write 2401 records to DEV:',
      '• Contact: 2400',
      '• Account: 1',
      'That is more than 2000 records, past which the sandforge.safety.confirmAboveRecords setting asks.',
      'They take about 4.69 MB of data storage; DEV has 150 MB left of 200 MB.',
      'The records have been read, and nothing has been written yet.',
    ]);
  });

  it("warns near what is left, of a large volume, and when the target's storage could not be read", () => {
    const near = runQuestionDetail({
      ...write,
      largeVolume: 50_000,
      storage: { estimateMB: 9, maxMB: 200, remainingMB: 10, near: true },
    });
    expect(near).toContain('More than 50000 records is a large volume for this org.');
    expect(near).toContain(
      'That is more than 80% of what is left. Salesforce counts storage a while after a load, so less may be left than it says.',
    );
    expect(
      runQuestionDetail({ ...write, storage: { estimateMB: 4.69, unread: 'INSUFFICIENT_ACCESS' } }),
    ).toContain(
      'They take about 4.69 MB of data storage. What DEV has left could not be read (INSUFFICIENT_ACCESS), so whether they fit is not known.',
    );
  });

  it('lists no more than a dozen entries, and says how many more there are', () => {
    const objects = Array.from({ length: 15 }, (_, i) => ({ objectApiName: `O${i}__c`, rows: 10 }));
    const lines = runQuestionDetail({ ...write, objects, total: 150 }).split('\n');
    expect(lines.filter((line) => line.startsWith('• O'))).toHaveLength(12);
    expect(lines).toContain('• and 3 more objects, 30 records');
  });

  it('asks in a modal and lets the run go only when its translated button is pressed', async () => {
    l10nBundle.current = {
      Execute: 'Exécuter',
      'SandForge: confirm this clone': 'SandForge : confirmer ce clonage',
      '{0} runs automation on the records this clone inserts:':
        "{0} exécute de l'automatisation sur les enregistrements que ce clonage insère :",
    };
    vi.mocked(vscode.window.showWarningMessage).mockImplementation(
      (...args: unknown[]) => Promise.resolve(args[args.length - 1]) as never,
    );
    const { productionGuard } = createBackgroundComposition({
      services,
      configStore: createMockConfigStore(),
    });

    await expect(productionGuard.confirmRun(automation)).resolves.toBe('confirmed');
    const [title, options, button] = vi.mocked(vscode.window.showWarningMessage).mock
      .calls[0] as unknown as [string, { modal: boolean; detail: string }, string];
    expect(title).toBe('SandForge : confirmer ce clonage');
    expect(options.modal).toBe(true);
    expect(options.detail.split('\n')[0]).toBe(
      "DEV exécute de l'automatisation sur les enregistrements que ce clonage insère :",
    );
    expect(button).toBe('Exécuter');
  });

  it('declines when the user dismisses it, whatever the production setting says', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
    const { productionGuard } = createBackgroundComposition({
      services: {
        getSandforgeSetting: <T>(key: string, fallback: T): T =>
          (key === 'safety.requireProdConfirmation' ? false : fallback) as T,
      } as unknown as Services,
      configStore: createMockConfigStore(),
    });

    await expect(productionGuard.confirmRun(write)).resolves.toBe('declined');
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });
});

describe('restore confirmation for an org a refresh replaced (localized)', () => {
  const question = {
    alias: 'uat',
    backedUpFrom: '00DXX00000AbCdE2A1',
    now: '00Dxx00000FgHiJ3B2',
  };

  beforeEach(() => {
    vi.mocked(vscode.window.showWarningMessage).mockReset();
    l10nBundle.current = {};
  });

  it('asks in a modal naming the org and both org ids, and restores on the translated label', async () => {
    l10nBundle.current = { 'Restore anyway': 'Restaurer quand même' };
    vi.mocked(vscode.window.showWarningMessage).mockImplementation(
      (...args: unknown[]) => Promise.resolve(args[args.length - 1]) as never,
    );

    await expect(confirmRestoreIntoReplacedOrg(question)).resolves.toBe(true);

    const call = vi.mocked(vscode.window.showWarningMessage).mock.calls[0];
    const options = call[1] as { modal: boolean; detail: string };
    expect(options.modal).toBe(true);
    expect(options.detail).toContain('uat answered as org 00DXX00000AbCdE2A1');
    expect(options.detail).toContain('answers as org 00Dxx00000FgHiJ3B2 now');
    expect(call[call.length - 1]).toBe('Restaurer quand même');
  });

  it('restores nothing when the user dismisses the modal', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);

    await expect(confirmRestoreIntoReplacedOrg(question)).resolves.toBe(false);
  });
});

describe('wireBackgroundNotifications', () => {
  /** A registry wired as activation wires it, with no SandForge panel on screen. */
  function wired(): { registry: BackgroundOperationRegistry; stateSync: WebviewStateSync } {
    const registry = new BackgroundOperationRegistry();
    const stateSync = { setActiveOperations: vi.fn() } as unknown as WebviewStateSync;
    const panelManager = {
      isAnyPanelVisible: () => false,
      openPanel: vi.fn(),
    } as unknown as WebviewPanelManager;
    wireBackgroundNotifications({ backgroundRegistry: registry, stateSync, panelManager });
    return { registry, stateSync };
  }

  /** Register an operation of `module` that settles when `ends` does. */
  function run(
    registry: BackgroundOperationRegistry,
    module: string,
    ends: Promise<unknown>,
  ): void {
    registry.register('op-1', module, `${module} run`, ends, new AbortController());
  }

  /** A promise that never settles: an operation still going. */
  const going = (): Promise<never> => new Promise<never>(() => undefined);

  beforeEach(() => {
    vi.mocked(vscode.window.showInformationMessage).mockReset();
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as never);
    l10nBundle.current = {};
  });

  it.each([
    [
      'completed',
      'SandForge: seed completed',
      (r: BackgroundOperationRegistry) => run(r, 'seed', Promise.resolve()),
    ],
    [
      'failed',
      'SandForge: seed failed — refused',
      (r: BackgroundOperationRegistry) => run(r, 'seed', Promise.reject(new Error('refused'))),
    ],
    [
      'was cancelled',
      'SandForge: seed cancelled',
      (r: BackgroundOperationRegistry) => {
        run(r, 'seed', going());
        r.abort('op-1');
      },
    ],
  ])('says an operation %s, and nothing else', async (_ending, sentence, end) => {
    const { registry } = wired();

    end(registry);
    // The registry reads a settled promise on the next turns of the queue.
    await Promise.resolve();
    await Promise.resolve();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(sentence, 'Show Details');
  });

  it('says a cancelled operation was cancelled, translated, with how far it went', () => {
    // A cancel ended with an event nothing listened to: not a word of it, and
    // the operations the panels were sent still listed it as running.
    l10nBundle.current = { 'SandForge: {0} cancelled — {1}': 'SandForge : {0} annulé — {1}' };
    const { registry, stateSync } = wired();
    run(registry, 'dataops', going());
    registry.updateProgress('op-1', 40, '2 of 5 objects read');
    vi.mocked(stateSync.setActiveOperations).mockClear();

    registry.abort('op-1');

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'SandForge : dataops annulé — 2 of 5 objects read',
      'Show Details',
    );
    expect(stateSync.setActiveOperations).toHaveBeenCalledWith([
      expect.objectContaining({ operationId: 'op-1', status: 'aborted' }),
    ]);
  });
});
