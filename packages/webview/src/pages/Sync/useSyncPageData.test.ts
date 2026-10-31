import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import '../../i18n';
import { useSyncPageData } from './useSyncPageData';
import { useAppStore } from '../../stores/useAppStore';
import { SYNC_ACCOUNT_HIERARCHY } from '@sandforge/shared';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

vi.mock('../../stores/useNotificationStore', () => ({
  useNotificationStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ addNotification: vi.fn() }),
}));

/** Every query the hook asked, as it asked it on its last render. */
const queries = vi.hoisted(
  () => new Map<string, { payload?: Record<string, unknown>; options?: { skip?: boolean } }>(),
);

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (
    requestType: string,
    payload?: Record<string, unknown>,
    options?: { skip?: boolean },
  ) => {
    queries.set(requestType, { payload, options });
    return {
      data: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

/**
 * State of the sync:execute mutation, set by the tests that need a run going.
 * `mutate` is kept so a test can read the configuration that went out.
 */
const execution = vi.hoisted(() => ({
  loading: false,
  requestId: null as string | null,
  mutate: vi.fn(),
}));

/**
 * Calls of the sync:describe-fields mutation. The mock hands out a new `mutate`
 * on every render, so an effect that listed the mutation among its triggers
 * would fire again on each render.
 */
const describeFields = vi.hoisted(() => ({ mutate: vi.fn() }));

/** State of the sync:simulate mutation, as {@link execution} is of the run's. */
const simulation = vi.hoisted(() => ({
  loading: false,
  requestId: null as string | null,
  data: null as Record<string, unknown> | null,
  mutate: vi.fn(),
  reset: vi.fn(),
}));

/** State of the sync:config:save mutation: what the host answered the last save with. */
const saving = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  mutate: vi.fn(),
}));

/** State of the sync:config:load mutation: the saved configuration read back. */
const readBack = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  mutate: vi.fn(),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (requestType: string) => {
    if (requestType === 'sync:config:load') {
      return {
        mutate: readBack.mutate,
        data: readBack.data,
        loading: false,
        error: null,
        reset: vi.fn(),
        requestId: null,
      };
    }
    if (requestType === 'sync:config:save') {
      return {
        mutate: saving.mutate,
        data: saving.data,
        loading: false,
        error: null,
        reset: vi.fn(),
        requestId: null,
      };
    }
    if (requestType === 'sync:simulate') {
      return {
        mutate: simulation.mutate,
        data: simulation.data,
        loading: simulation.loading,
        error: null,
        reset: simulation.reset,
        requestId: simulation.requestId,
      };
    }
    return {
      mutate:
        requestType === 'sync:execute'
          ? execution.mutate
          : requestType === 'sync:describe-fields'
            ? (payload?: Record<string, unknown>) => describeFields.mutate(payload)
            : vi.fn(),
      data: null,
      loading: requestType === 'sync:execute' ? execution.loading : false,
      error: null,
      reset: vi.fn(),
      requestId: requestType === 'sync:execute' ? execution.requestId : null,
    };
  },
}));

/** The stored draft the page reopens on; a test that needs one sets it. */
const draft = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));

vi.mock('../../hooks/useWebviewPersistedState', () => ({
  useWebviewPersistedState: (_key: string, defaultValue: unknown) => {
    const state = { current: draft.value ?? defaultValue };
    return [state.current, vi.fn()];
  },
}));

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('useSyncPageData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    draft.value = null;
    execution.loading = false;
    execution.requestId = null;
    execution.mutate.mockClear();
    simulation.loading = false;
    simulation.requestId = null;
    simulation.data = null;
    saving.data = null;
  });

  it('shows the progress of the sync it started, not of another run reporting at the same time', () => {
    // Every open panel receives every operation:progress, and the sync
    // handler uses the request id as the operationId.
    execution.loading = true;
    execution.requestId = 'wv-own-sync';
    const report = (operationId: string, percentage: number): void => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: `ext-${operationId}-${percentage}`,
            type: 'operation:progress',
            timestamp: Date.now(),
            payload: {
              operationId,
              percentage,
              processedRecords: percentage,
              totalRecords: 100,
              currentStep: 'Account',
            },
          },
        }),
      );
    };

    const { result } = renderHook(() => useSyncPageData());

    act(() => {
      report('wv-own-sync', 25);
      report('wv-other-sync', 80);
    });

    expect(result.current.overallPercent).toBe(25);
  });

  it('mutes the target’s automation for the run only once the box beside Run is ticked', () => {
    const { result } = renderHook(() => useSyncPageData());
    act(() => {
      result.current.handleSourceOrgChange('org-1');
      result.current.handleTargetOrgChange('org-2');
      result.current.handleAddObject('Account');
    });
    act(() => {
      result.current.handleExecute();
    });
    expect(result.current.muteAutomation).toBe(false);
    expect(execution.mutate.mock.calls[0][0]).not.toHaveProperty('muteAutomation');

    act(() => {
      result.current.setMuteAutomation(true);
    });
    act(() => {
      result.current.handleExecute();
    });
    expect(execution.mutate.mock.calls[1][0]).toMatchObject({ muteAutomation: true });
  });

  it('sends the transform rule with the settings typed for it', () => {
    // TransformBuilder's inputs were handed a no-op, so a prefix, a replacement
    // or a truncate length never left the page: every value-based rule reached
    // the run with an empty config and changed nothing.
    const { result } = renderHook(() => useSyncPageData());

    act(() => {
      result.current.handleSourceOrgChange('org-1');
      result.current.handleTargetOrgChange('org-2');
      result.current.handleAddObject('Account');
      result.current.handleAddTransform('prefix');
    });
    act(() => {
      result.current.handleChangeTransformConfig(0, 'prefix', 'X-');
    });
    act(() => {
      result.current.handleExecute();
    });

    const sent = execution.mutate.mock.calls[0][0] as {
      config: { objects: { transformRules: { type: string; config: { prefix?: string } }[] }[] };
    };
    expect(sent.config.objects[0].transformRules[0].type).toBe('prefix');
    expect(sent.config.objects[0].transformRules[0].config.prefix).toBe('X-');
  });

  it('sends a truncate length as the number the schema expects', () => {
    // The length box is text, and `length` is a number at the boundary: sent as
    // '5' the whole configuration would be refused before the run.
    const { result } = renderHook(() => useSyncPageData());

    act(() => {
      result.current.handleSourceOrgChange('org-1');
      result.current.handleTargetOrgChange('org-2');
      result.current.handleAddObject('Account');
      result.current.handleAddTransform('truncate');
    });
    act(() => {
      result.current.handleChangeTransformConfig(0, 'length', '5');
    });
    act(() => {
      result.current.handleExecute();
    });

    const sent = execution.mutate.mock.calls[0][0] as {
      config: { objects: { transformRules: { config: { length?: number } }[] }[] };
    };
    expect(sent.config.objects[0].transformRules[0].config.length).toBe(5);
  });

  it('leaves out a truncate length whose text is not a whole number', () => {
    // The box is text and `length` is a positive integer at the boundary:
    // '5.7' must not silently become 5 characters.
    const { result } = renderHook(() => useSyncPageData());

    act(() => {
      result.current.handleSourceOrgChange('org-1');
      result.current.handleTargetOrgChange('org-2');
      result.current.handleAddObject('Account');
      result.current.handleAddTransform('truncate');
    });
    act(() => {
      result.current.handleChangeTransformConfig(0, 'length', '5.7');
    });
    act(() => {
      result.current.handleExecute();
    });

    const sent = execution.mutate.mock.calls[0][0] as {
      config: { objects: { transformRules: { config: { length?: number } }[] }[] };
    };
    expect(sent.config.objects[0].transformRules[0].config.length).toBeUndefined();
  });

  it('reopens a draft that asked for manual review on target wins, and says so', () => {
    // It reopened on source wins without a word: the write every run of it
    // had made under the manual name, kept and still unsaid.
    draft.value = {
      currentStep: 0,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'manual',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      objectEntries: [],
      mappings: [],
      transforms: [],
    };

    const { result } = renderHook(() => useSyncPageData());

    expect(result.current.conflictStrategy).toBe('target_wins');
    expect(result.current.strategyNotice).toBe(true);

    // Picking a strategy is the answer the notice asked for.
    act(() => result.current.setConflictStrategy('newest_wins'));
    expect(result.current.conflictStrategy).toBe('newest_wins');
    expect(result.current.strategyNotice).toBe(false);
  });

  describe('delta', () => {
    const base = {
      currentStep: 0,
      direction: 'source_to_target',
      conflictStrategy: 'source_wins',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      objectEntries: [
        {
          objectApiName: 'Account',
          operation: 'upsert',
          externalIdField: 'Ext__c',
          batchSize: 200,
        },
      ],
      mappingsByObject: {},
      transforms: [],
    };

    it('reopens a draft on delta, and on its deletions only when it is a delta draft', () => {
      draft.value = { ...base, mode: 'delta', propagateDeletes: true };
      expect(renderHook(() => useSyncPageData()).result.current).toMatchObject({
        mode: 'delta',
        propagateDeletes: true,
      });

      draft.value = { ...base, mode: 'full', propagateDeletes: true };
      expect(renderHook(() => useSyncPageData()).result.current).toMatchObject({
        mode: 'full',
        propagateDeletes: false,
      });
    });

    it('keeps deletions to a delta configuration, and drops them when delta is left', () => {
      draft.value = { ...base, mode: 'full' };
      const { result } = renderHook(() => useSyncPageData());

      act(() => result.current.setPropagateDeletes(true));
      expect(result.current.propagateDeletes).toBe(false);

      act(() => result.current.setMode('delta'));
      act(() => result.current.setPropagateDeletes(true));
      expect(result.current.propagateDeletes).toBe(true);

      act(() => result.current.setMode('full'));
      expect(result.current.propagateDeletes).toBe(false);
    });

    it('names the objects a delta run cannot write, and holds the first step while there are any', () => {
      draft.value = {
        ...base,
        mode: 'delta',
        objectEntries: [
          ...base.objectEntries,
          { objectApiName: 'Contact', operation: 'insert', externalIdField: '', batchSize: 200 },
          { objectApiName: 'Case', operation: 'delete', externalIdField: '', batchSize: 200 },
        ],
      };
      const { result } = renderHook(() => useSyncPageData());

      expect(result.current.deltaBlockers).toEqual(['Contact', 'Case']);
      expect(result.current.canGoNext()).toBe(false);

      act(() => result.current.setMode('full'));
      expect(result.current.deltaBlockers).toEqual([]);
      expect(result.current.canGoNext()).toBe(true);
    });

    it('sends deletions with a delta configuration, and never with a full one', () => {
      draft.value = { ...base, currentStep: 4, mode: 'delta', propagateDeletes: true };
      const { result } = renderHook(() => useSyncPageData());

      act(() => result.current.handleExecute());
      const sent = execution.mutate.mock.calls[0][0] as {
        config: { mode: string; propagateDeletes?: boolean };
      };
      expect(sent.config).toMatchObject({ mode: 'delta', propagateDeletes: true });
    });

    it('drops a simulation once the mode changes: it no longer says what a run would do', () => {
      draft.value = { ...base, currentStep: 4, mode: 'full' };
      simulation.data = { objects: [] };
      const { result } = renderHook(() => useSyncPageData());

      act(() => result.current.handleSimulate());
      expect(result.current.simulation).toBeDefined();

      act(() => result.current.setMode('delta'));
      expect(result.current.simulation).toBeUndefined();
    });
  });

  describe('the files of the records', () => {
    const base = {
      currentStep: 4,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'source_wins',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      objectEntries: [
        { objectApiName: 'Account', operation: 'insert', externalIdField: '', batchSize: 200 },
      ],
      mappingsByObject: {},
      transforms: [],
    };

    /** The configuration the run was sent. */
    function sentConfig(): Record<string, unknown> {
      return (execution.mutate.mock.calls.at(-1)?.[0] as { config: Record<string, unknown> })
        .config;
    }

    it('sends no files with a configuration that does not copy them', () => {
      draft.value = base;
      const { result } = renderHook(() => useSyncPageData());

      act(() => result.current.handleExecute());

      expect(result.current.copyFiles).toBe(false);
      expect(sentConfig()).not.toHaveProperty('files');
    });

    it('sends the files with their caps once turned on and saved, the defaults sensible for a sandbox', () => {
      draft.value = base;
      const { result, rerender } = renderHook(() => useSyncPageData());

      act(() => result.current.setCopyFiles(true));
      act(() => result.current.handleSaveConfig('Nightly'));
      const saved = (saving.mutate.mock.calls[0][0] as { config: { id: string } }).config;
      saving.data = { success: true, id: saved.id };
      rerender();
      act(() => result.current.handleExecute());

      expect(sentConfig().files).toEqual({ maxFileSizeMB: 10, maxRunMB: 100 });
      expect(sentConfig().id).toBe(saved.id);
    });

    it('sends neither a run nor a simulation of a configuration copying files that is not saved', () => {
      draft.value = base;
      const { result } = renderHook(() => useSyncPageData());
      expect(result.current.filesNeedSave).toBe(false);

      act(() => result.current.setCopyFiles(true));
      expect(result.current.filesNeedSave).toBe(true);
      act(() => result.current.handleExecute());
      act(() => result.current.handleSimulate());

      // The extension refuses both: sent, the run was refused once the
      // execute step had started.
      expect(execution.mutate).not.toHaveBeenCalled();
      expect(simulation.mutate).not.toHaveBeenCalled();
    });

    it('keeps each cap within what the extension takes', () => {
      draft.value = base;
      const { result } = renderHook(() => useSyncPageData());

      act(() => result.current.setCopyFiles(true));
      act(() => result.current.setFileCap('maxFileSizeMB', 80));
      act(() => result.current.setFileCap('maxRunMB', 0));
      expect(result.current.fileCaps).toEqual({ maxFileSizeMB: 35, maxRunMB: 1 });

      act(() => result.current.setFileCap('maxRunMB', Number.NaN));
      act(() => result.current.setFileCap('maxFileSizeMB', 2.6));
      expect(result.current.fileCaps).toEqual({ maxFileSizeMB: 3, maxRunMB: 1 });
    });

    it('reopens a draft that copies files with its caps', () => {
      draft.value = { ...base, files: { maxFileSizeMB: 5, maxRunMB: 40 } };

      const { result } = renderHook(() => useSyncPageData());

      expect(result.current.copyFiles).toBe(true);
      expect(result.current.fileCaps).toEqual({ maxFileSizeMB: 5, maxRunMB: 40 });
    });

    it('drops a simulation once the files are turned on: it no longer says what a run would do', () => {
      draft.value = base;
      simulation.data = { objects: [] };
      const { result } = renderHook(() => useSyncPageData());

      act(() => result.current.handleSimulate());
      expect(result.current.simulation).toBeDefined();

      act(() => result.current.setCopyFiles(true));
      expect(result.current.simulation).toBeUndefined();
    });
  });

  describe('what a run does with a record the target already holds', () => {
    const upserting = {
      currentStep: 4,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'target_wins',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      objectEntries: [
        {
          objectApiName: 'Account',
          operation: 'upsert',
          externalIdField: 'Ext__c',
          batchSize: 200,
        },
      ],
      mappingsByObject: {},
      transforms: [],
    };

    /** The direction and strategy of the configuration the run was sent. */
    function sent(): { direction: string; conflictStrategy: string } {
      const call = execution.mutate.mock.calls.at(-1)?.[0] as {
        config: { direction: string; conflictStrategy: string };
      };
      return {
        direction: call.config.direction,
        conflictStrategy: call.config.conflictStrategy,
      };
    }

    it('is asked once an object finds one, and sent as the read of the target with the choice', () => {
      // The page asked for a Direction and a Conflict Strategy: Target Wins on
      // Source to Target, the default, was never read, and the run wrote the
      // source's values over the target's.
      draft.value = upserting;
      const { result } = renderHook(() => useSyncPageData());

      expect(result.current.findsHeldRecords).toBe(true);
      expect(result.current.conflictStrategy).toBe('target_wins');
      act(() => result.current.handleExecute());

      expect(sent()).toEqual({ direction: 'bidirectional', conflictStrategy: 'target_wins' });
    });

    it('sends the plain write to overwrite it, and for objects that only insert', () => {
      draft.value = { ...upserting, conflictStrategy: 'source_wins' };
      const overwriting = renderHook(() => useSyncPageData()).result;
      act(() => overwriting.current.handleExecute());
      expect(sent()).toEqual({ direction: 'source_to_target', conflictStrategy: 'source_wins' });

      draft.value = {
        ...upserting,
        objectEntries: [
          { objectApiName: 'Account', operation: 'insert', externalIdField: '', batchSize: 200 },
        ],
      };
      const inserting = renderHook(() => useSyncPageData()).result;
      expect(inserting.current.findsHeldRecords).toBe(false);
      act(() => inserting.current.handleExecute());
      expect(sent()).toEqual({ direction: 'source_to_target', conflictStrategy: 'source_wins' });
    });
  });

  it('reopens a draft on a strategy no run knows on the default, with nothing to say', () => {
    draft.value = {
      currentStep: 0,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'whatever',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      objectEntries: [],
      mappings: [],
      transforms: [],
    };

    const { result } = renderHook(() => useSyncPageData());

    expect(result.current.conflictStrategy).toBe('source_wins');
    expect(result.current.strategyNotice).toBe(false);
  });

  describe('a simulation', () => {
    const ready = {
      currentStep: 4,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'source_wins',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      objectEntries: [
        { objectApiName: 'Account', operation: 'insert', externalIdField: '', batchSize: 200 },
      ],
      mappingsByObject: {},
      transforms: [],
    };

    it('sends the configuration on screen to be simulated, not run', () => {
      draft.value = ready;
      const { result } = renderHook(() => useSyncPageData());

      act(() => result.current.handleSimulate());

      expect(execution.mutate).not.toHaveBeenCalled();
      expect(simulation.mutate).toHaveBeenCalledTimes(1);
      const sent = simulation.mutate.mock.calls[0][0] as {
        config: { objects: Array<{ objectApiName: string }>; sourceOrgId: string };
      };
      expect(sent.config.sourceOrgId).toBe('org-1');
      expect(sent.config.objects.map((o) => o.objectApiName)).toEqual(['Account']);
    });

    it('is followed by its own progress and its own controls while it runs', () => {
      draft.value = ready;
      simulation.loading = true;
      simulation.requestId = 'wv-simulation';

      const { result } = renderHook(() => useSyncPageData());

      expect(result.current.isSimulating).toBe(true);
      expect(result.current.runOperationId).toBe('wv-simulation');
      expect(result.current.canGoNext()).toBe(false);
      // Nothing else starts while it runs.
      act(() => result.current.handleExecute());
      expect(execution.mutate).not.toHaveBeenCalled();
    });

    const found = {
      configId: 'c',
      operationId: 'wv-simulation',
      direction: 'source_to_target',
      conflictStrategy: 'source_wins',
      objects: [],
      duration: 1,
      timestamp: '2026-10-06T00:00:00.000Z',
    };

    it('opens the results step on what it found', () => {
      draft.value = ready;
      const { result, rerender } = renderHook(() => useSyncPageData());

      act(() => result.current.handleSimulate());
      simulation.data = found;
      rerender();

      expect(result.current.currentStep).toBe(5);
      expect(result.current.simulation?.operationId).toBe('wv-simulation');
      expect(result.current.isFinished).toBe(true);
    });

    it('is no longer shown once the configuration it was run on changes', () => {
      // Its "run the sync now" would have run another configuration than the
      // one it had simulated.
      draft.value = {
        ...ready,
        objectEntries: [
          {
            objectApiName: 'Account',
            operation: 'upsert',
            externalIdField: 'Ext__c',
            batchSize: 200,
          },
        ],
      };
      const { result, rerender } = renderHook(() => useSyncPageData());
      act(() => result.current.handleSimulate());
      simulation.data = found;
      rerender();
      expect(result.current.simulation).toBeDefined();

      act(() => result.current.setConflictStrategy('target_wins'));

      expect(result.current.simulation).toBeUndefined();
    });

    it('is put away when the run starts, so its findings never stand under a run', () => {
      draft.value = ready;
      const { result } = renderHook(() => useSyncPageData());

      act(() => result.current.handleExecute());

      expect(simulation.reset).toHaveBeenCalled();
      expect(execution.mutate).toHaveBeenCalledTimes(1);
    });
  });

  it('reopens a draft left on the results step on the step that starts a run', () => {
    // Results are not kept with the draft: the results step had nothing to
    // show, and its Confirm ran the sync straight away.
    draft.value = {
      currentStep: 5,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'source_wins',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      objectEntries: [],
      mappingsByObject: {},
      transforms: [],
    };

    const { result } = renderHook(() => useSyncPageData());

    expect(result.current.currentStep).toBe(4);
    expect(result.current.canGoNext()).toBe(false);
  });

  it('should start at step 0', () => {
    const { result } = renderHook(() => useSyncPageData());
    expect(result.current.currentStep).toBe(0);
  });

  it('canGoNext at step 0 should require both orgs AND at least 1 object', () => {
    const { result } = renderHook(() => useSyncPageData());
    // No orgs, no objects => false
    expect(result.current.canGoNext()).toBe(false);
  });

  it('isFinished should be true when currentStep is 5 and result exists', () => {
    const { result } = renderHook(() => useSyncPageData());
    // At step 0 with no result, isFinished should be false
    expect(result.current.isFinished).toBe(false);
  });

  it('handleApplyTemplate should populate mode, conflictStrategy and objectEntries', () => {
    const { result } = renderHook(() => useSyncPageData());

    act(() => {
      result.current.handleApplyTemplate(SYNC_ACCOUNT_HIERARCHY);
    });

    expect(result.current.findsHeldRecords).toBe(false);
    expect(result.current.mode).toBe('full');
    expect(result.current.conflictStrategy).toBe('source_wins');
    expect(result.current.objectEntries).toHaveLength(5);
    expect(result.current.objectEntries[0].objectApiName).toBe('Account');
    expect(result.current.objectEntries[4].objectApiName).toBe('Note');
  });

  it('handleApplyTemplate should clear mappings and transforms', () => {
    const { result } = renderHook(() => useSyncPageData());

    // Add a mapping first
    act(() => {
      result.current.handleAddMapping('Name', 'Name');
    });
    expect(result.current.mappings).toHaveLength(1);

    // Apply template should clear it
    act(() => {
      result.current.handleApplyTemplate(SYNC_ACCOUNT_HIERARCHY);
    });
    expect(result.current.mappings).toHaveLength(0);
    expect(result.current.transforms).toHaveLength(0);
  });

  it('should expose handleApplyTemplate in the return object', () => {
    const { result } = renderHook(() => useSyncPageData());
    expect(typeof result.current.handleApplyTemplate).toBe('function');
  });

  it("asks for the first object's fields on entering the mapping step, and not on every render", () => {
    const { result, rerender } = renderHook(() => useSyncPageData());
    act(() => {
      result.current.handleSourceOrgChange('org-src');
      result.current.handleTargetOrgChange('org-tgt');
      result.current.handleAddObject('Account');
    });
    expect(describeFields.mutate).not.toHaveBeenCalled();

    act(() => {
      result.current.setCurrentStep(1);
    });
    rerender();
    rerender();

    expect(describeFields.mutate).toHaveBeenCalledTimes(1);
    expect(describeFields.mutate).toHaveBeenCalledWith({
      sourceOrgId: 'org-src',
      targetOrgId: 'org-tgt',
      objectApiName: 'Account',
    });
  });

  it('asks the order a run writes the objects in on Review only, without the dates that change each render', () => {
    const { result } = renderHook(() => useSyncPageData());
    act(() => {
      result.current.handleSourceOrgChange('org-src');
      result.current.handleTargetOrgChange('org-tgt');
      result.current.handleAddObject('Case');
      result.current.handleAddObject('Contact');
    });
    expect(queries.get('sync:write-order')?.options?.skip).toBe(true);

    act(() => {
      result.current.setCurrentStep(3);
    });

    const asked = queries.get('sync:write-order');
    expect(asked?.options?.skip).toBe(false);
    const config = asked?.payload?.config as Record<string, unknown>;
    expect(config.createdAt).toBeUndefined();
    expect(config.updatedAt).toBeUndefined();
    expect(config).toMatchObject({
      sourceOrgId: 'org-src',
      targetOrgId: 'org-tgt',
      objects: [
        expect.objectContaining({ objectApiName: 'Case', insertOrder: 0 }),
        expect.objectContaining({ objectApiName: 'Contact', insertOrder: 1 }),
      ],
    });
  });

  it('starts from the source and target orgs Home recommended syncing, once', () => {
    useAppStore.setState({
      navigationIntent: { route: 'sync', sourceOrgId: 'org-src', targetOrgId: 'org-tgt' },
    });

    const { result } = renderHook(() => useSyncPageData());

    expect(result.current.sourceOrgId).toBe('org-src');
    expect(result.current.targetOrgId).toBe('org-tgt');
    expect(useAppStore.getState().navigationIntent).toBeNull();
  });

  describe('a saved configuration Migration opened here', () => {
    /** A configuration as `sync:config:load` reads it back, a transform of one object alone. */
    const SAVED = {
      id: 'cfg-9',
      name: 'Nightly accounts',
      sourceOrgId: 'org-src',
      targetOrgId: 'org-tgt',
      objects: [
        {
          objectApiName: 'Account',
          operation: 'insert',
          transformRules: [{ type: 'prefix', config: { prefix: 'QA-' } }],
          excludedFields: ['CreatedDate'],
        },
      ],
    };

    function openedFromMigration() {
      useAppStore.setState({
        navigationIntent: {
          route: 'sync',
          sourceOrgId: 'org-src',
          targetOrgId: 'org-tgt',
          syncConfig: { id: 'cfg-9', name: 'Nightly accounts' },
        },
      });
      return renderHook(() => useSyncPageData());
    }

    beforeEach(() => {
      readBack.data = null;
      readBack.mutate.mockClear();
      execution.loading = false;
      simulation.loading = false;
      simulation.data = null;
    });

    it('opens on the execute step, between the orgs it runs between, and names it', () => {
      const { result } = openedFromMigration();

      expect(result.current.currentStep).toBe(4);
      expect(result.current.sourceOrgId).toBe('org-src');
      expect(result.current.targetOrgId).toBe('org-tgt');
      expect(result.current.openedConfigLabel).toBe('Nightly accounts');
      // Nothing is read, simulated or run before a button is pressed.
      expect(readBack.mutate).not.toHaveBeenCalled();
      expect(execution.mutate).not.toHaveBeenCalled();
      expect(useAppStore.getState().navigationIntent).toBeNull();
    });

    it('runs it as it was saved, read back by its id, muted as the box beside Run is left', () => {
      const { result, rerender } = openedFromMigration();

      act(() => result.current.setMuteAutomation(true));
      act(() => result.current.handleExecute());
      expect(readBack.mutate).toHaveBeenCalledWith({ id: 'cfg-9' });
      expect(execution.mutate).not.toHaveBeenCalled();

      readBack.data = { config: SAVED };
      rerender();

      expect(execution.mutate).toHaveBeenCalledTimes(1);
      expect(execution.mutate).toHaveBeenCalledWith({ config: SAVED, muteAutomation: true });
      expect(simulation.mutate).not.toHaveBeenCalled();
      expect(result.current.savedRunLabel).toBe('Nightly accounts');
    });

    it('simulates it as it was saved, and writes nothing', () => {
      const { result, rerender } = openedFromMigration();

      act(() => result.current.handleSimulate());
      expect(readBack.mutate).toHaveBeenCalledWith({ id: 'cfg-9' });

      readBack.data = { config: SAVED };
      rerender();

      expect(simulation.mutate).toHaveBeenCalledWith({ config: SAVED });
      expect(execution.mutate).not.toHaveBeenCalled();
    });

    it('is put away once the wizard’s own steps are opened again: Run is the wizard’s then', () => {
      const { result } = openedFromMigration();

      act(() => result.current.setCurrentStep(3));
      expect(result.current.openedConfigLabel).toBeNull();
      act(() => result.current.handleAddObject('Contact'));
      act(() => result.current.setCurrentStep(4));
      act(() => result.current.handleExecute());

      expect(readBack.mutate).not.toHaveBeenCalled();
      const sent = execution.mutate.mock.calls[0][0] as {
        config: { objects: Array<{ objectApiName: string }> };
      };
      expect(sent.config.objects.map((o) => o.objectApiName)).toEqual(['Contact']);
    });

    it('says it is no longer saved, and runs nothing', () => {
      const { result, rerender } = openedFromMigration();

      act(() => result.current.handleExecute());
      readBack.data = { config: null };
      rerender();

      expect(execution.mutate).not.toHaveBeenCalled();
      expect(result.current.error).toBe('This configuration is no longer saved: nothing was run.');
    });
  });
});

describe('each object carries its own field mappings', () => {
  it('keeps one object’s mappings off the others', () => {
    // The step describes one object at a time, and its mappings used to be
    // attached to every object of the run: Contact and Opportunity were
    // written through Account's fields and judged against them.
    const { result } = renderHook(() => useSyncPageData());
    act(() => {
      result.current.handleAddObject('Account');
      result.current.handleAddObject('Contact');
    });

    act(() => {
      result.current.setMappedObject('Account');
    });
    act(() => {
      result.current.handleAddMapping('Name', 'Name');
    });
    act(() => {
      result.current.setMappedObject('Contact');
    });
    act(() => {
      result.current.handleAddMapping('Email', 'Email');
    });

    execution.mutate.mockClear();
    act(() => {
      result.current.handleSourceOrgChange('src');
      result.current.handleTargetOrgChange('tgt');
    });
    act(() => {
      result.current.handleExecute();
    });
    const sent = execution.mutate.mock.calls.at(-1)?.[0] as {
      config: {
        objects: Array<{ objectApiName: string; fieldMappings: Array<{ sourceField: string }> }>;
      };
    };
    const byObject = Object.fromEntries(
      sent.config.objects.map((o) => [o.objectApiName, o.fieldMappings.map((m) => m.sourceField)]),
    );
    expect(byObject).toEqual({ Account: ['Name'], Contact: ['Email'] });
  });

  it('leaves an object nobody mapped with no mapping at all', () => {
    // No mapping means "copy the record as read" — which is what the writer
    // now does, and what an object mapped through another one's fields did not.
    const { result } = renderHook(() => useSyncPageData());
    act(() => {
      result.current.handleAddObject('Account');
      result.current.handleAddObject('Contact');
    });
    act(() => {
      result.current.setMappedObject('Account');
    });
    act(() => {
      result.current.handleAddMapping('Name', 'Name');
    });

    execution.mutate.mockClear();
    act(() => {
      result.current.handleSourceOrgChange('src');
      result.current.handleTargetOrgChange('tgt');
    });
    act(() => {
      result.current.handleExecute();
    });
    const sent = execution.mutate.mock.calls.at(-1)?.[0] as {
      config: { objects: Array<{ objectApiName: string; fieldMappings: unknown[] }> };
    };
    expect(sent.config.objects.find((o) => o.objectApiName === 'Contact')?.fieldMappings).toEqual(
      [],
    );
  });
});
