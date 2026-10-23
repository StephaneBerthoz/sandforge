import { describe, it, expect, expectTypeOf } from 'vitest';
import type * as z from 'zod';

import type {
  CheckpointEstimate,
  CheckpointLeftOutFieldReason,
  CheckpointOrgTier,
  CheckpointReadMode,
  CheckpointScopeMode,
  CheckpointStatus,
  CheckpointTakeRequests,
  OrgCheckpoint,
  RewindResidualReason,
  RewindResult,
  RewindStatus,
} from './checkpoint.types.js';
import type { ForgeUndoObjectResult, ForgeUndoStatus } from './forge.types.js';
import type { SyncRestoreObjectResult, SyncUndeleteObjectResult } from './sync.types.js';
import {
  checkpointLeftOutFieldReasonSchema,
  checkpointOrgTierSchema,
  checkpointReadModeSchema,
  checkpointScopeModeSchema,
  checkpointStatusSchema,
  orgCheckpointSchema,
} from '../schemas/checkpoint.schema.js';

/*
 * These assertions are read by the type checker (`tsc -p tsconfig.test.json`),
 * which fails on the first one that no longer holds: a field added to the
 * interface the file's schema does not read, or the other way round, would
 * let a store write what it then lists as damaged.
 */

describe('the checkpoint file and its schema', () => {
  it('reads exactly the shape OrgCheckpoint declares', () => {
    expectTypeOf<z.infer<typeof orgCheckpointSchema>>().toEqualTypeOf<OrgCheckpoint>();
  });

  it('reads the closed lists the types declare, value for value', () => {
    expectTypeOf<z.infer<typeof checkpointOrgTierSchema>>().toEqualTypeOf<CheckpointOrgTier>();
    expectTypeOf<z.infer<typeof checkpointScopeModeSchema>>().toEqualTypeOf<CheckpointScopeMode>();
    expectTypeOf<z.infer<typeof checkpointReadModeSchema>>().toEqualTypeOf<CheckpointReadMode>();
    expectTypeOf<
      z.infer<typeof checkpointLeftOutFieldReasonSchema>
    >().toEqualTypeOf<CheckpointLeftOutFieldReason>();
    expectTypeOf<z.infer<typeof checkpointStatusSchema>>().toEqualTypeOf<CheckpointStatus>();
    expect(checkpointReadModeSchema.options).toEqual(['query', 'scanAllLive']);
  });

  it('holds a version 1 file, taken by a user who sees and changes all data', () => {
    expectTypeOf<OrgCheckpoint['version']>().toEqualTypeOf<1>();
    expectTypeOf<OrgCheckpoint['takenBy']['viewAllData']>().toEqualTypeOf<true>();
    expectTypeOf<OrgCheckpoint['takenBy']['modifyAllData']>().toEqualTypeOf<true>();
    expectTypeOf<OrgCheckpoint['ignoredFields']>().toEqualTypeOf<string[]>();
    expectTypeOf<OrgCheckpoint['expiresAt']>().toEqualTypeOf<string | null>();
  });
});

describe('the requests of a take', () => {
  it('are estimated and counted over the same phases, each one a number', () => {
    expectTypeOf<NonNullable<CheckpointEstimate['requestsByPhase']>>().toEqualTypeOf<
      CheckpointTakeRequests['byPhase']
    >();
    expectTypeOf<CheckpointTakeRequests['byPhase']['snapshot']>().toEqualTypeOf<number>();
  });
});

describe('the result of a rewind', () => {
  it('reports its three write phases as the removals of a run report them', () => {
    expectTypeOf<RewindResult['deleted']>().toEqualTypeOf<ForgeUndoObjectResult[]>();
    expectTypeOf<RewindResult['restored']>().toEqualTypeOf<SyncRestoreObjectResult[]>();
    expectTypeOf<RewindResult['undeleted']>().toEqualTypeOf<SyncUndeleteObjectResult[]>();
  });

  it('ends as a removal ends, or unstable when someone else wrote during it', () => {
    expectTypeOf<ForgeUndoStatus>().toExtend<RewindStatus>();
    expectTypeOf<Exclude<RewindStatus, ForgeUndoStatus>>().toEqualTypeOf<'unstable'>();
  });

  it('says why each record still differs, those it kept as it had to among them, and the objects its last read could not read', () => {
    expectTypeOf<RewindResidualReason>().toEqualTypeOf<
      | 'automation'
      | 'changedDuringRewind'
      | 'changedSincePreview'
      | 'refused'
      | 'goneForGood'
      | 'kept'
    >();
    expectTypeOf<RewindResult['unread']>().toEqualTypeOf<
      Array<{ objectApiName: string; reason: string }> | undefined
    >();
  });
});
