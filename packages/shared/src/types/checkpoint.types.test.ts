import { describe, it, expect, expectTypeOf } from 'vitest';
import type * as z from 'zod';

import type {
  CheckpointArchiveHeader,
  CheckpointBeforeRun,
  CheckpointBeforeRunModule,
  CheckpointCustomSettingKind,
  CheckpointEstimate,
  CheckpointLeftOutCode,
  CheckpointLeftOutFieldReason,
  CheckpointObjectAccess,
  CheckpointOrgTier,
  CheckpointReadMode,
  CheckpointRefusalCode,
  CheckpointScopeMode,
  CheckpointStatus,
  CheckpointTakeRequests,
  OrgCheckpoint,
  RewindResidualReason,
  RewindResult,
  RewindStatus,
  RunCheckpointEstimate,
  RunCheckpointInfo,
  RunCheckpointRequest,
  RunCheckpointTaken,
} from './checkpoint.types.js';
import type { ForgeUndoObjectResult, ForgeUndoStatus } from './forge.types.js';
import type { SyncRestoreObjectResult, SyncUndeleteObjectResult } from './sync.types.js';
import {
  checkpointArchiveHeaderSchema,
  checkpointBeforeRunSchema,
  checkpointCustomSettingKindSchema,
  checkpointLeftOutCodeSchema,
  checkpointLeftOutFieldReasonSchema,
  checkpointObjectAccessSchema,
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
    expectTypeOf<
      z.infer<typeof checkpointLeftOutCodeSchema>
    >().toEqualTypeOf<CheckpointLeftOutCode>();
    expectTypeOf<z.infer<typeof checkpointStatusSchema>>().toEqualTypeOf<CheckpointStatus>();
    expectTypeOf<
      z.infer<typeof checkpointCustomSettingKindSchema>
    >().toEqualTypeOf<CheckpointCustomSettingKind>();
    expect(checkpointReadModeSchema.options).toEqual(['query', 'scanAllLive']);
  });

  it('holds a version 1 file, taken by a user who sees and changes all data or each object it holds', () => {
    expectTypeOf<OrgCheckpoint['version']>().toEqualTypeOf<1>();
    expectTypeOf<OrgCheckpoint['takenBy']['viewAllData']>().toEqualTypeOf<boolean>();
    expectTypeOf<OrgCheckpoint['takenBy']['modifyAllData']>().toEqualTypeOf<boolean>();
    expectTypeOf<OrgCheckpoint['objects'][number]['access']>().toEqualTypeOf<
      CheckpointObjectAccess | undefined
    >();
    expectTypeOf<
      z.infer<typeof checkpointObjectAccessSchema>
    >().toEqualTypeOf<CheckpointObjectAccess>();
    expect(checkpointObjectAccessSchema.options).toEqual(['org', 'object', 'parent']);
    expectTypeOf<OrgCheckpoint['ignoredFields']>().toEqualTypeOf<string[]>();
    expectTypeOf<OrgCheckpoint['expiresAt']>().toEqualTypeOf<string | null>();
  });

  it('says where a checkpoint a run took before its first write comes from, as its schema reads it', () => {
    expectTypeOf<z.infer<typeof checkpointBeforeRunSchema>>().toEqualTypeOf<CheckpointBeforeRun>();
    expectTypeOf<OrgCheckpoint['beforeRun']>().toEqualTypeOf<CheckpointBeforeRun | undefined>();
    expectTypeOf<CheckpointBeforeRun['module']>().toEqualTypeOf<CheckpointBeforeRunModule>();
    expect(checkpointBeforeRunSchema.shape.module.options).toEqual([
      'forge',
      'sync',
      'seed',
      'autopilot',
      'frozen',
    ]);
  });
});

describe('a checkpoint taken before a run', () => {
  it('is in a run result taken, or deleted when the run wrote nothing, and planned in a question or a simulation', () => {
    expectTypeOf<RunCheckpointInfo['state']>().toEqualTypeOf<'taken' | 'deleted'>();
    expectTypeOf<RunCheckpointEstimate['state']>().toEqualTypeOf<'planned'>();
    expectTypeOf<RunCheckpointEstimate['estimate']>().toEqualTypeOf<CheckpointEstimate>();
    expectTypeOf<RunCheckpointTaken['expiresAt']>().toEqualTypeOf<string | null>();
    expectTypeOf<RunCheckpointRequest>().toEqualTypeOf<{
      keepDays?: number;
      excluded?: string[];
    }>();
  });

  it('is refused when it would hold nothing the run writes, or not fit on the disk', () => {
    expectTypeOf<'NOTHING_HELD' | 'DISK' | 'EMAILS_DELIVERED'>().toExtend<CheckpointRefusalCode>();
  });
});

describe('the header of a checkpoint file', () => {
  it('reads exactly the shape CheckpointArchiveHeader declares', () => {
    expectTypeOf<
      z.infer<typeof checkpointArchiveHeaderSchema>
    >().toEqualTypeOf<CheckpointArchiveHeader>();
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

  it('says why each record still differs, those it kept as it had to and those the org answered are no longer in the recycle bin among them, and the objects its last read could not read', () => {
    expectTypeOf<RewindResidualReason>().toEqualTypeOf<
      | 'automation'
      | 'changedDuringRewind'
      | 'changedSincePreview'
      | 'refused'
      | 'notInBin'
      | 'goneForGood'
      | 'kept'
    >();
    expectTypeOf<RewindResult['unread']>().toEqualTypeOf<
      Array<{ objectApiName: string; reason: string }> | undefined
    >();
  });
});
