import { describe, expect, it } from 'vitest';
import { FORGE_RUN_GATE_CODES, forgeRunGateStopOf, isForgeRunGateCode } from './forge-run-gate.js';

describe('forge run gate stops', () => {
  it('names the twelve ways a run stops at its gate', () => {
    expect(FORGE_RUN_GATE_CODES).toEqual([
      'PRODUCTION_TARGET',
      'AUTOMATION_DECLINED',
      'READ_DECLINED',
      'WRITE_DECLINED',
      'STORAGE_EXCEEDED',
      'CONFIRMATION_UNAVAILABLE',
      'CHECKPOINT_REFUSED',
      'API_BUDGET_EXCEEDED',
      'READ_BOUND_EXCEEDED',
      'FILES_UNREAD',
      'FILE_STORAGE_UNREAD',
      'FILE_STORAGE_EXCEEDED',
    ]);
  });

  // The file copier of a run that clones no whole org refuses files past the
  // target's file storage under a code of its own, which the command line
  // names: read as a stop, with the megabytes, the page says it in the
  // user's language where it said the host's English on a failed run.
  it('reads files past the file storage left as a stop, with what they take and what is left', () => {
    expect(
      forgeRunGateStopOf({
        code: 'FILE_STORAGE_EXCEEDED',
        storage: { estimateMB: 12.5, remainingMB: -2, kind: 'files' },
      }),
    ).toEqual({
      code: 'FILE_STORAGE_EXCEEDED',
      storage: { estimateMB: 12.5, remainingMB: -2, kind: 'files' },
    });
  });

  // A clone of the whole org asked for its files is refused at its gate when
  // either org would not say what they take: read as any other stop, the page
  // says it in the user's language where it said the host's English.
  it('reads a refusal of the files of a clone of the whole org that could not be weighed', () => {
    expect(forgeRunGateStopOf({ code: 'FILES_UNREAD' })).toEqual({ code: 'FILES_UNREAD' });
    expect(forgeRunGateStopOf({ code: 'FILE_STORAGE_UNREAD' })).toEqual({
      code: 'FILE_STORAGE_UNREAD',
    });
  });

  it('reads which storage a refusal for storage names, the data storage when it says none', () => {
    expect(
      forgeRunGateStopOf({
        code: 'STORAGE_EXCEEDED',
        storage: { estimateMB: 2_048, remainingMB: 1_000, kind: 'files' },
      }),
    ).toEqual({
      code: 'STORAGE_EXCEEDED',
      storage: { estimateMB: 2_048, remainingMB: 1_000, kind: 'files' },
    });
    expect(
      forgeRunGateStopOf({ code: 'STORAGE_EXCEEDED', storage: { estimateMB: 1, remainingMB: 0 } })
        ?.storage,
    ).not.toHaveProperty('kind');
  });

  it('reads a refusal for an API budget of a clone of the whole org: which allowance, of which org, and its figures', () => {
    expect(
      forgeRunGateStopOf({
        code: 'API_BUDGET_EXCEEDED',
        api: { kind: 'requests', org: 'source', estimate: 120_000, remaining: 4_000 },
      }),
    ).toEqual({
      code: 'API_BUDGET_EXCEEDED',
      api: { kind: 'requests', org: 'source', estimate: 120_000, remaining: 4_000 },
    });
    // An org over its allocation says what is left below zero.
    expect(
      forgeRunGateStopOf({
        code: 'API_BUDGET_EXCEEDED',
        api: { kind: 'bulkBatches', org: 'target', estimate: 900, remaining: -2 },
      })?.api,
    ).toEqual({ kind: 'bulkBatches', org: 'target', estimate: 900, remaining: -2 });
    // Said of another stop, it says nothing of it, and is dropped.
    expect(
      forgeRunGateStopOf({
        code: 'STORAGE_EXCEEDED',
        api: { kind: 'requests', org: 'target', estimate: 1, remaining: 0 },
      }),
    ).toEqual({ code: 'STORAGE_EXCEEDED' });
  });

  it('reads a refusal for an object read whole: the bound and each object past it', () => {
    const readBound = {
      bound: 50_000,
      objects: [
        { objectApiName: 'PricebookEntry', rows: 72_000 },
        { objectApiName: 'Product2', rows: 51_000 },
      ],
    };

    expect(isForgeRunGateCode('READ_BOUND_EXCEEDED')).toBe(true);
    expect(forgeRunGateStopOf({ code: 'READ_BOUND_EXCEEDED', readBound })).toEqual({
      code: 'READ_BOUND_EXCEEDED',
      readBound,
    });
    expect(forgeRunGateStopOf({ code: 'API_BUDGET_EXCEEDED', readBound })).toEqual({
      code: 'API_BUDGET_EXCEEDED',
    });
  });

  it('reads a stop for the checkpoint taken first and for the API requests left, as the page words them', () => {
    expect(isForgeRunGateCode('CHECKPOINT_REFUSED')).toBe(true);
    expect(isForgeRunGateCode('API_BUDGET_EXCEEDED')).toBe(true);
    expect(forgeRunGateStopOf({ code: 'CHECKPOINT_REFUSED' })).toEqual({
      code: 'CHECKPOINT_REFUSED',
    });
    expect(forgeRunGateStopOf({ code: 'API_BUDGET_EXCEEDED' })).toEqual({
      code: 'API_BUDGET_EXCEEDED',
    });
  });

  it('reads what refused the checkpoint taken first, by the refusal code the page words', () => {
    expect(forgeRunGateStopOf({ code: 'CHECKPOINT_REFUSED', reason: 'DISK' })).toEqual({
      code: 'CHECKPOINT_REFUSED',
      reason: 'DISK',
    });
    expect(forgeRunGateStopOf({ code: 'CHECKPOINT_REFUSED', reason: 'RUN_WRITING' })).toEqual({
      code: 'CHECKPOINT_REFUSED',
      reason: 'RUN_WRITING',
    });
    // A reason on any other stop says nothing of it, and is dropped.
    expect(forgeRunGateStopOf({ code: 'API_BUDGET_EXCEEDED', reason: 'DISK' })).toEqual({
      code: 'API_BUDGET_EXCEEDED',
    });
    // A reason is a code, never words a page would show as they came.
    expect(
      forgeRunGateStopOf({ code: 'CHECKPOINT_REFUSED', reason: 'The disk is full' }),
    ).toBeNull();
  });

  it('tells a gate code from any other code an execute error carries', () => {
    expect(isForgeRunGateCode('WRITE_DECLINED')).toBe(true);
    expect(isForgeRunGateCode('GUARD_DECLINED')).toBe(false);
    expect(isForgeRunGateCode('EXECUTE_ERROR')).toBe(false);
    expect(isForgeRunGateCode(undefined)).toBe(false);
  });

  it('reads a stop and the storage a refusal for storage names', () => {
    expect(forgeRunGateStopOf({ code: 'AUTOMATION_DECLINED' })).toEqual({
      code: 'AUTOMATION_DECLINED',
    });
    expect(forgeRunGateStopOf({ code: 'READ_DECLINED' })).toEqual({ code: 'READ_DECLINED' });
    expect(
      forgeRunGateStopOf({
        code: 'STORAGE_EXCEEDED',
        storage: { estimateMB: 66.8, remainingMB: -3 },
      }),
    ).toEqual({ code: 'STORAGE_EXCEEDED', storage: { estimateMB: 66.8, remainingMB: -3 } });
    expect(forgeRunGateStopOf({ code: 'READ_DECLINED', ceiling: 200_000 })).toEqual({
      code: 'READ_DECLINED',
      ceiling: 200_000,
    });
  });

  it('reads nothing from a field that is not a stop', () => {
    expect(forgeRunGateStopOf(undefined)).toBeNull();
    expect(forgeRunGateStopOf({ code: 'EXECUTE_ERROR' })).toBeNull();
    expect(forgeRunGateStopOf({ code: 'STORAGE_EXCEEDED', storage: { estimateMB: 'a lot' } })).toBe(
      null,
    );
    expect(forgeRunGateStopOf('PRODUCTION_TARGET')).toBeNull();
    expect(forgeRunGateStopOf({ code: 'READ_DECLINED', ceiling: -1 })).toBeNull();
    expect(
      forgeRunGateStopOf({
        code: 'STORAGE_EXCEEDED',
        storage: { estimateMB: 1, remainingMB: 0, kind: 'logs' },
      }),
    ).toBeNull();
    expect(
      forgeRunGateStopOf({
        code: 'API_BUDGET_EXCEEDED',
        api: { kind: 'calls', org: 'target', estimate: 1, remaining: 0 },
      }),
    ).toBeNull();
    expect(
      forgeRunGateStopOf({
        code: 'API_BUDGET_EXCEEDED',
        api: { kind: 'requests', org: 'both', estimate: 1, remaining: 0 },
      }),
    ).toBeNull();
    expect(
      forgeRunGateStopOf({ code: 'READ_BOUND_EXCEEDED', readBound: { bound: 0, objects: [] } }),
    ).toBeNull();
    expect(
      forgeRunGateStopOf({
        code: 'READ_BOUND_EXCEEDED',
        readBound: {
          bound: 10,
          objects: Array.from({ length: 201 }, (_, i) => ({ objectApiName: `O${i}`, rows: 11 })),
        },
      }),
    ).toBeNull();
  });
});
