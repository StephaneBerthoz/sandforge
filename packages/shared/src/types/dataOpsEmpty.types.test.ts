import { describe, expectTypeOf, it } from 'vitest';

import type {
  DataOpsEmptyAccess,
  DataOpsEmptyPreviewKept,
  DataOpsEmptyRefusal,
  DataOpsEmptyRunResult,
  DataOpsEmptyStatus,
  DataOpsEmptyTier,
  DataOpsEmptyUndoObject,
  DataOpsEmptyUndoResult,
} from './dataOpsEmpty.types.js';
import type { AuditOutcome } from './reporting.types.js';
import type {
  DataOpsEmptyPreviewResponse,
  DataOpsEmptyRunResponse,
  DataOpsEmptyUndoResponse,
} from './messages/dataops.messages.js';

/*
 * These assertions are read by the type checker (`tsc -p tsconfig.test.json`):
 * the contract the page and the command line read an emptying by.
 */

describe('the contract of an emptying', () => {
  it('never names a production org: the guard refuses one before anything is read', () => {
    expectTypeOf<DataOpsEmptyTier>().toEqualTypeOf<'staging' | 'development' | 'scratch'>();
    expectTypeOf<DataOpsEmptyPreviewKept['tier']>().toEqualTypeOf<DataOpsEmptyTier>();
  });

  it('ends as the audit trail records a run, cancelled included', () => {
    expectTypeOf<DataOpsEmptyStatus>().toExtend<AuditOutcome>();
    expectTypeOf<DataOpsEmptyRunResult['status']>().toEqualTypeOf<DataOpsEmptyStatus>();
    expectTypeOf<DataOpsEmptyUndoResult['status']>().toEqualTypeOf<DataOpsEmptyStatus>();
  });

  it('says why Undo is not offered, and names apart what an undo cannot bring back', () => {
    expectTypeOf<DataOpsEmptyRunResult['undo']>().toEqualTypeOf<
      { offered: true } | { offered: false; why: 'hard' | 'nothingDeleted' }
    >();
    expectTypeOf<DataOpsEmptyUndoObject>().toHaveProperty('notInBin').toEqualTypeOf<number>();
    expectTypeOf<DataOpsEmptyUndoObject>().toHaveProperty('othersDeletion').toEqualTypeOf<number>();
  });

  it('answers each act with its result, and its dry run with what the run would meet', () => {
    expectTypeOf<
      DataOpsEmptyRunResponse['payload']['result']
    >().toEqualTypeOf<DataOpsEmptyRunResult>();
    expectTypeOf<
      DataOpsEmptyUndoResponse['payload']['result']
    >().toEqualTypeOf<DataOpsEmptyUndoResult>();
    expectTypeOf<DataOpsEmptyPreviewResponse['payload']['refusals']>().toEqualTypeOf<
      DataOpsEmptyRefusal[]
    >();
    expectTypeOf<
      DataOpsEmptyPreviewResponse['payload']['access']
    >().toEqualTypeOf<DataOpsEmptyAccess>();
  });
});
