import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import {
  mutePlanOf,
  stillRunningOf,
  type CheckpointLeftOutObject,
  type ForgeAutomationWrite,
  type ForgeTargetAutomation,
  type ForgeTargetFlow,
  type ForgeTargetObjectAutomation,
  type OrgCheckpoint,
  type RunCheckpointTaken,
  type StillRunningEntry,
} from '@sandforge/shared';

import {
  BEFORE_RUN_DELETED_WORDS,
  WRITE_PATH_STEPS,
  beforeRunAskedOf,
  beforeRunDiskRefusal,
  beforeRunEstimateOf,
  beforeRunFailedWords,
  beforeRunKeepDaysOf,
  beforeRunNameOf,
  beforeRunOutcomeOf,
  beforeRunProgressWords,
  beforeRunRefusedWords,
  beforeRunScopeOf,
  beforeRunTakenOf,
  settleBeforeRun,
  writePathOrderDefects,
  type BeforeRunScopeInput,
  type WritePathStep,
} from './beforeRunCheckpoint.js';
import type { CheckpointDeleteOutcome } from './OrgCheckpointStore.js';
import type { TakeScope } from './takeCheckpoint.js';

/** A Sync, Seed or Autopilot run that mutes, asks, takes a checkpoint first and writes in two calls. */
const ONE_QUESTION: WritePathStep[] = [
  'reads',
  'leasePlan',
  'stillRunning',
  'deliverabilityRead',
  'question',
  'checkpointTake',
  'leaseAcquire',
  'afterLeaseCheck',
  'write',
  'write',
  'leaseRelease',
  'recordTypeReadBack',
  'result',
];

/** A Forge run: its emails asked with its automation, its rows read, its checkpoint at its write gate. */
const FORGE: WritePathStep[] = [
  'reads',
  'leasePlan',
  'stillRunning',
  'deliverabilityRead',
  'question',
  'reads',
  'question',
  'checkpointTake',
  'leaseAcquire',
  'afterLeaseCheck',
  'write',
  'leaseRelease',
  'recordTypeReadBack',
  'result',
];

/** `steps` with `step` moved to just before `before`. */
function moved(
  steps: WritePathStep[],
  step: WritePathStep,
  before: WritePathStep,
): WritePathStep[] {
  const without = steps.filter((s) => s !== step);
  const at = without.indexOf(before);
  return [...without.slice(0, at), step, ...without.slice(at)];
}

describe('the order of a run’s write path', () => {
  it('lists its steps in the order every module keeps', () => {
    expect(WRITE_PATH_STEPS).toEqual([
      'reads',
      'leasePlan',
      'stillRunning',
      'deliverabilityRead',
      'question',
      'checkpointTake',
      'leaseAcquire',
      'afterLeaseCheck',
      'write',
      'leaseRelease',
      'recordTypeReadBack',
      'result',
    ]);
    expect(writePathOrderDefects([...WRITE_PATH_STEPS])).toEqual([]);
  });

  it('finds nothing amiss in a run of one question, of Forge’s two, or of one without a mute, a checkpoint or emails', () => {
    expect(writePathOrderDefects(ONE_QUESTION)).toEqual([]);
    expect(writePathOrderDefects(FORGE)).toEqual([]);
    expect(writePathOrderDefects(['reads', 'question', 'write', 'result'])).toEqual([]);
  });

  it('finds a lease taken before the question, as Forge took it before its rows and its write gate', () => {
    expect(writePathOrderDefects(moved(FORGE, 'leaseAcquire', 'reads'))).toContain(
      'the lease was taken before the last question',
    );
    const leasedBeforeRows: WritePathStep[] = [
      'reads',
      'leasePlan',
      'question',
      'leaseAcquire',
      'reads',
      'question',
      'checkpointTake',
      'write',
      'leaseRelease',
      'result',
    ];
    expect(writePathOrderDefects(leasedBeforeRows)).toEqual([
      'the lease was taken before the last question',
      'the lease was taken before the checkpoint',
    ]);
  });

  it('finds a checkpoint taken after the lease, or before the question it is asked in', () => {
    expect(writePathOrderDefects(moved(ONE_QUESTION, 'checkpointTake', 'afterLeaseCheck'))).toEqual(
      ['the lease was taken before the checkpoint'],
    );
    expect(writePathOrderDefects(moved(ONE_QUESTION, 'checkpointTake', 'question'))).toEqual([
      'the checkpoint was taken before the last question',
    ]);
  });

  it('finds the deliverability read after the question, or before what still runs was known', () => {
    expect(
      writePathOrderDefects(moved(ONE_QUESTION, 'deliverabilityRead', 'checkpointTake')),
    ).toEqual(['the deliverability was read after the question it belongs to']);
    expect(writePathOrderDefects(moved(ONE_QUESTION, 'deliverabilityRead', 'leasePlan'))).toEqual([
      'the deliverability was read before what still runs was known',
    ]);
  });

  it('finds a write before the lease or its check, a release before the last write, and a lease never given back', () => {
    expect(writePathOrderDefects(moved(ONE_QUESTION, 'afterLeaseCheck', 'leaseRelease'))).toContain(
      'a record was written before the lease was checked',
    );
    const releasedEarly: WritePathStep[] = [
      'reads',
      'question',
      'leaseAcquire',
      'write',
      'leaseRelease',
      'write',
      'result',
    ];
    expect(writePathOrderDefects(releasedEarly)).toEqual([
      'the lease was given back before the last write',
    ]);
    expect(writePathOrderDefects(['reads', 'question', 'leaseAcquire', 'write', 'result'])).toEqual(
      ['the lease was never given back'],
    );
  });

  it('finds the record types read back while the lease is held, and a run going on past its result', () => {
    expect(
      writePathOrderDefects(moved(ONE_QUESTION, 'recordTypeReadBack', 'leaseRelease')),
    ).toEqual(['the record types were read back while the lease was held']);
    expect(writePathOrderDefects(['reads', 'question', 'write', 'result', 'write'])).toEqual([
      'the run went on past its result',
    ]);
  });
});

// ─── The scope of a checkpoint before a run ──────────────────────────────────

/** A flow read with its start condition, creating nothing and naming no permission unless told. */
function flow(overrides: Partial<ForgeTargetFlow> = {}): ForgeTargetFlow {
  return {
    apiName: 'Account_After_Create',
    label: 'Account after create',
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: [],
    ...overrides,
  };
}

/** What still runs of one flow on one write: what `stillRunningOf` lists. */
function firing(
  objectApiName: string,
  write: ForgeAutomationWrite,
  overrides: Partial<ForgeTargetFlow> = {},
  kind: StillRunningEntry['kind'] = 'flow',
): StillRunningEntry {
  const read = flow(overrides);
  return { objectApiName, kind, name: read.label, write, flow: read };
}

/** What a run asks of a checkpoint before it, writing `written`, `firing` still running. */
function input(
  written: string[],
  running: StillRunningEntry[] = [],
  excluded?: string[],
): BeforeRunScopeInput {
  return {
    module: 'forge',
    written,
    running: { firing: running },
    request: excluded ? { excluded } : {},
  };
}

describe('beforeRunScopeOf', () => {
  it('picks every object the run writes, each once, then what the flows that still run create as the run writes, each named with what creates it', () => {
    const scope = beforeRunScopeOf(
      input(
        ['Account', 'Contact', 'account'],
        [
          firing('Account', 'insert', { label: 'Open a case', creates: ['Case', 'Contact'] }),
          firing('Contact', 'update', { label: 'Log the change', creates: ['Task'] }),
          firing('Contact', 'insert', { label: 'Welcome task', creates: ['task'] }),
        ],
      ),
    );

    expect(scope.written).toEqual(['Account', 'Contact']);
    expect(scope.picked).toEqual(['Account', 'Contact', 'Case', 'Task']);
    expect(scope.added).toEqual([
      {
        objectApiName: 'Case',
        reason: "The target's flow 'Open a case' creates Case records as Account records go in.",
      },
      {
        objectApiName: 'Task',
        reason:
          "The target's flow 'Log the change' creates Task records as Contact records are " +
          "updated; the target's flow 'Welcome task' creates task records as Contact records go in.",
      },
    ]);
    expect(scope.excluded).toEqual([]);
  });

  it('adds nothing an Apex trigger may create, whose code is not read, nor a platform event, which is no record', () => {
    const scope = beforeRunScopeOf(
      input(
        ['Account'],
        [
          { objectApiName: 'Account', kind: 'trigger', name: 'AccountTrigger', write: 'insert' },
          firing('Account', 'insert', { label: 'Publish', creates: ['Account_Created__e'] }),
          firing('Account', 'insert', { label: 'Not read', condition: 'notRead' }),
        ],
      ),
    );

    expect(scope.picked).toEqual(['Account']);
    expect(scope.added).toEqual([]);
  });

  it('names a process and a workflow rule by their kind, three automations at most, the others counted', () => {
    const scope = beforeRunScopeOf(
      input(
        ['Case'],
        [
          firing('Case', 'insert', { label: 'A', creates: ['Task'] }, 'process'),
          firing('Case', 'insert', { label: 'B', creates: ['Task'] }, 'workflowRule'),
          firing('Case', 'delete', { label: 'C', creates: ['Task'] }),
          firing('Case', 'update', { label: 'D', creates: ['Task'] }),
          firing('Case', 'update', { label: 'E', creates: ['Task'] }),
        ],
      ),
    );

    expect(scope.added).toEqual([
      {
        objectApiName: 'Task',
        reason:
          "The target's process 'A' creates Task records as Case records go in; the target's " +
          "workflow rule 'B' creates Task records as Case records go in; the target's flow 'C' " +
          'creates Task records as Case records are deleted; and 2 more.',
      },
    ]);
  });

  it('keeps the objects left out by name among those picked, each once, for the take to name them', () => {
    const scope = beforeRunScopeOf(
      input(['Account'], [firing('Account', 'insert', { creates: ['Task'] })], ['Task', 'task']),
    );

    expect(scope.picked).toEqual(['Account', 'Task']);
    expect(scope.excluded).toEqual(['Task']);
  });
});

/** The objects and the writes a property's target and run are drawn from. */
const OBJECTS = ['Account', 'Contact', 'Case', 'Opportunity', 'Asset', 'Task'] as const;
const CREATED = ['Account', 'Contact', 'Case', 'Asset', 'Task', 'FeedItem', 'Audit__e'] as const;
const STARTS = ['create', 'update', 'createAndUpdate', 'delete'] as const;
const RUN_WRITES = ['insert', 'update', 'delete'] as const;

/** A target drawn at random: flows on each object, some a bypass keeps quiet, some creating records. */
const targetArb: fc.Arbitrary<ForgeTargetAutomation> = fc
  .uniqueArray(
    fc.record({
      objectApiName: fc.constantFrom(...OBJECTS),
      flows: fc.array(
        fc.record({
          startsOn: fc.constantFrom(...STARTS),
          creates: fc.uniqueArray(fc.constantFrom(...CREATED), { maxLength: 3 }),
          // P1 a permission set holds, P2 none: the mute can keep quiet only P1's.
          bypass: fc.constantFrom(undefined, 'P1', 'P2'),
        }),
        { maxLength: 3 },
      ),
    }),
    { selector: (object) => object.objectApiName, maxLength: OBJECTS.length },
  )
  .map((objects) => ({
    objectsRead: objects.map((object) => object.objectApiName),
    objects: objects.map((object): ForgeTargetObjectAutomation => ({
      objectApiName: object.objectApiName,
      triggers: [],
      flows: object.flows.map((drawn, n) =>
        flow({
          apiName: `${object.objectApiName}_${n}`,
          label: `${object.objectApiName} flow ${n}`,
          startsOn: drawn.startsOn,
          ...(drawn.creates.length > 0 ? { creates: [...drawn.creates] } : {}),
          permissions:
            drawn.bypass === undefined ? [] : [{ name: drawn.bypass, bypass: true, held: false }],
        }),
      ),
    })),
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    bypassGrants: [
      { permission: 'P1', permissionSets: [{ name: 'Bypass_P1', label: 'Bypass P1', grants: 1 }] },
    ],
    requests: 1,
  }));

/** A run drawn at random: the writes it makes of each object. */
const runArb = fc.uniqueArray(
  fc.tuple(fc.constantFrom(...OBJECTS), fc.constantFrom(...RUN_WRITES)),
  { minLength: 1, selector: ([object, write]) => `${object} ${write}` },
);

describe('beforeRunScopeOf, of any target and any run', () => {
  /** What the run writes, as `stillRunningOf` and `mutePlanOf` are told it. */
  const writesOf =
    (run: ReadonlyArray<readonly [string, string]>) =>
    (objectApiName: string, write: ForgeAutomationWrite): boolean =>
      run.some(([object, made]) => object === objectApiName && made === write);

  it('holds every object the run writes and all that a flow still running creates, and never what only a flow the mute keeps quiet creates', () => {
    fc.assert(
      fc.property(targetArb, runArb, fc.boolean(), (target, run, mutes) => {
        const writes = writesOf(run);
        const plan = mutes ? mutePlanOf(target, writes) : undefined;
        const running = stillRunningOf(target, plan, writes);
        const written = [...new Set(run.map(([object]) => object))];
        const scope = beforeRunScopeOf({
          module: 'sync',
          written,
          running,
          request: {},
        });
        const picked = new Set(scope.picked);

        for (const object of written) expect(picked.has(object)).toBe(true);
        const createdByRunning = new Set(
          running.firing
            .flatMap((entry) => entry.flow?.creates ?? [])
            .filter((name) => !name.endsWith('__e')),
        );
        for (const created of createdByRunning) expect(picked.has(created)).toBe(true);
        // What a flow kept quiet creates is held only when the run writes it,
        // or a flow that still runs creates it too.
        for (const { objectApiName } of scope.added) {
          expect(createdByRunning.has(objectApiName)).toBe(true);
          expect(written).not.toContain(objectApiName);
        }
        expect(scope.picked).toHaveLength(written.length + scope.added.length);
      }),
      { numRuns: 300, seed: 4601, endOnFailure: true },
    );
  });
});

// ─── What it would hold, at the gate ─────────────────────────────────────────

/** A take's scope as `scopeCheckpoint` answers it, holding `held`, leaving out `leftOut`. */
function read(
  held: string[],
  leftOut: CheckpointLeftOutObject[] = [],
  extra: Partial<TakeScope> = {},
): Pick<TakeScope, 'objects' | 'leftOut' | 'estimate' | 'refusal'> {
  return {
    objects: held.map((objectApiName) => ({
      objectApiName,
      label: objectApiName,
      records: 1,
      undeletable: true,
      leftOutFields: [],
    })),
    leftOut,
    estimate: {
      records: 38,
      apiRequests: 68,
      apiRequestsLeft: 14_000,
      seconds: 44,
      bytes: 2_215_295,
    },
    ...extra,
  };
}

const CHATTER =
  'Chatter posts, comments and feeds are left out: Salesforce brings a post back only with ' +
  'what it was posted on.';
const ACTIVITIES =
  'Without View All Data and Modify All Data, tasks and events are left out: Salesforce has ' +
  'no View All for activities, and a private one linked to no record stays out of sight.';

describe('beforeRunEstimateOf', () => {
  const scope = beforeRunScopeOf(
    input(
      ['Contact', 'Account'],
      [
        firing('Contact', 'insert', { label: 'Welcome task', creates: ['Task'] }),
        firing('Account', 'insert', { label: 'Post it', creates: ['FeedItem'] }),
      ],
    ),
  );

  it('lists what it holds, the objects the run writes first, what it adds and why — the files among them — and what it leaves out, with what a rewind does to it', () => {
    const estimate = beforeRunEstimateOf(
      scope,
      read(
        ['Attachment', 'Account', 'ContentDocument', 'Contact'],
        [
          { objectApiName: 'FeedItem', reason: CHATTER },
          { objectApiName: 'Task', reason: ACTIVITIES },
        ],
      ),
      7,
    );

    expect(estimate).toEqual({
      state: 'planned',
      estimate: {
        records: 38,
        apiRequests: 68,
        apiRequestsLeft: 14_000,
        seconds: 44,
        bytes: 2_215_295,
      },
      keepDays: 7,
      objects: ['Contact', 'Account', 'Attachment', 'ContentDocument'],
      added: [
        {
          objectApiName: 'Attachment',
          reason:
            'Attachments, which every checkpoint of picked objects holds: a rewind deletes the ' +
            'attachments added since.',
        },
        {
          objectApiName: 'ContentDocument',
          reason:
            'Files, which every checkpoint of picked objects holds: a rewind deletes the files ' +
            'added since to the records it holds.',
        },
      ],
      notHeld: [
        {
          objectApiName: 'FeedItem',
          reason: `${CHATTER} A rewind leaves its records as they are.`,
        },
        { objectApiName: 'Task', reason: `${ACTIVITIES} A rewind leaves its records as they are.` },
      ],
    });
  });

  it('says what the flows that still run add once the take holds it', () => {
    const estimate = beforeRunEstimateOf(scope, read(['Contact', 'Account', 'Task']), 7);

    expect(estimate.objects).toEqual(['Contact', 'Account', 'Task']);
    expect(estimate.added).toEqual([
      {
        objectApiName: 'Task',
        reason: "The target's flow 'Welcome task' creates Task records as Contact records go in.",
      },
    ]);
    expect(estimate.refusal).toBeUndefined();
  });

  it('refuses one that would hold none of the objects the run writes, naming why each is left out, whatever else it would hold', () => {
    const estimate = beforeRunEstimateOf(
      scope,
      read(
        ['Task'],
        [
          { objectApiName: 'Account', reason: 'Left out as asked.' },
          { objectApiName: 'Contact', reason: 'The org has no object of this name.' },
        ],
        { refusal: { code: 'RUN_WRITING', message: 'A SandForge run is writing.' } },
      ),
      7,
    );

    expect(estimate.refusal).toEqual({
      code: 'NOTHING_HELD',
      message:
        'The checkpoint before the run would hold none of the objects the run writes, so a ' +
        'rewind to it could take nothing of the run back. Contact: The org has no object of ' +
        'this name. Account: Left out as asked. No record was read.',
    });
    // One object the run writes held, and the take's own refusal stands.
    expect(
      beforeRunEstimateOf(
        scope,
        read(['Account'], [], {
          refusal: { code: 'RUN_WRITING', message: 'A SandForge run is writing.' },
        }),
        7,
      ).refusal,
    ).toEqual({ code: 'RUN_WRITING', message: 'A SandForge run is writing.' });
  });

  it('holds the versions of the files a run writes with the files, never naming them left out', () => {
    const files = beforeRunScopeOf(input(['ContentVersion']));
    const heldWithFile =
      "Held with its file (ContentDocument): Salesforce neither deletes nor brings back a file's " +
      'version on its own, and reads the links of a file through the records they tie it to.';

    const withFiles = beforeRunEstimateOf(
      files,
      read(['ContentDocument'], [{ objectApiName: 'ContentVersion', reason: heldWithFile }]),
      7,
    );
    expect(withFiles.refusal).toBeUndefined();
    expect(withFiles.notHeld).toEqual([]);

    const withoutFiles = beforeRunEstimateOf(
      files,
      read([], [{ objectApiName: 'ContentVersion', reason: heldWithFile }]),
      7,
    );
    expect(withoutFiles.refusal?.code).toBe('NOTHING_HELD');
  });

  it('says a guard’s refusal alone, before the org’s objects are read', () => {
    const production = { code: 'PRODUCTION' as const, message: 'Never of a production org.' };
    expect(
      beforeRunEstimateOf(
        scope,
        {
          objects: [],
          leftOut: [],
          estimate: { records: 0, apiRequests: 0, apiRequestsLeft: 0, seconds: 0, bytes: 0 },
          refusal: production,
        },
        7,
      ),
    ).toMatchObject({ objects: [], added: [], notHeld: [], refusal: production });
  });
});

describe('beforeRunDiskRefusal', () => {
  const bytes = 2_215_295;

  it('lets a take through with its bytes and a tenth more free, and refuses one short of that, saying both', () => {
    expect(beforeRunDiskRefusal(bytes, Math.ceil(bytes * 1.1))).toBeUndefined();
    expect(beforeRunDiskRefusal(bytes, Math.ceil(bytes * 1.1) - 1)).toEqual({
      code: 'DISK',
      message:
        'The checkpoint before the run takes about 2.1 MB on this machine, and its disk has ' +
        '2.3 MB free, less than that and a tenth more: make room, or leave objects out of the ' +
        'checkpoint. No record was read.',
    });
    // More free than the bytes alone, less than the tenth more.
    expect(beforeRunDiskRefusal(bytes, bytes + 1)?.code).toBe('DISK');
  });

  it('refuses nothing where the system does not say what is free', () => {
    expect(beforeRunDiskRefusal(bytes, undefined)).toBeUndefined();
  });
});

// ─── The take ────────────────────────────────────────────────────────────────

describe('what a take before a run is asked', () => {
  it('names it after the module, its date put in by the take, kept the days asked, its objects picked and left out by name, its origin the run', () => {
    const scope = beforeRunScopeOf(
      input(['Account'], [firing('Account', 'insert', { creates: ['Task'] })], ['Task']),
    );

    expect(
      beforeRunAskedOf(scope, {
        ...input(['Account']),
        module: 'frozen',
        operationId: 'op-1',
        tool: 'cli',
        keepDays: 0,
      }),
    ).toEqual({
      mode: 'picked',
      objects: ['Account', 'Task'],
      excluded: ['Task'],
      nameWithDate: 'Before Frozen Dataset load {date}',
      keepDays: 0,
      unprovenLeftOut: true,
      beforeRun: { module: 'frozen', operationId: 'op-1', tool: 'cli' },
    });
    expect(beforeRunNameOf('forge')).toBe('Before Forge run {date}');
    expect(beforeRunNameOf('autopilot')).toBe('Before Autopilot run {date}');
  });

  it('keeps it the days asked, else the setting’s, else seven; a setting outside its bounds is not set, a request outside them refused', () => {
    expect(beforeRunKeepDaysOf(undefined, undefined)).toBe(7);
    expect(beforeRunKeepDaysOf(undefined, 30)).toBe(30);
    expect(beforeRunKeepDaysOf(3, 30)).toBe(3);
    expect(beforeRunKeepDaysOf(0, 30)).toBe(0);
    expect(beforeRunKeepDaysOf(undefined, 0)).toBe(0);
    expect(beforeRunKeepDaysOf(undefined, -2)).toBe(7);
    expect(beforeRunKeepDaysOf(undefined, 3_651)).toBe(7);
    expect(beforeRunKeepDaysOf(undefined, '30')).toBe(7);
    expect(() => beforeRunKeepDaysOf(1.5, 30)).toThrow(RangeError);
    expect(() => beforeRunKeepDaysOf(3_651, 30)).toThrow(RangeError);
  });
});

/** A checkpoint kept, holding `objects` of one record each, `leftOut` named. */
function checkpointOf(
  objects: string[],
  leftOut: CheckpointLeftOutObject[] = [],
): Pick<OrgCheckpoint, 'checkpointId' | 'name' | 'takenAt' | 'expiresAt' | 'bytes'> &
  OrgCheckpoint {
  return {
    checkpointId: 'ck-20261022-140512-a1b2',
    name: 'Before Forge run 2026-10-22 14:05 UTC',
    takenAt: '2026-10-22T14:05:40.000Z',
    expiresAt: '2026-10-29T14:05:10.000Z',
    bytes: 4_096,
    scope: { mode: 'picked', leftOut },
    objects: objects.map((objectApiName, readOrder) => ({
      objectApiName,
      records: 2,
      inBin: 0,
      readOrder,
      readMode: 'query',
      undeletable: true,
      cascadeParents: [],
      fingerprint: 'f',
      fields: ['Name'],
      leftOutFields: [],
    })),
  } as unknown as OrgCheckpoint;
}

/** A store whose deletions are counted, answering as told. */
function storeOf(answer: CheckpointDeleteOutcome = { outcome: 'deleted' }) {
  return { delete: vi.fn(async (_checkpointId: string) => answer) };
}

describe('the checkpoint a take before a run kept', () => {
  const scope = beforeRunScopeOf(
    input(['Account'], [firing('Account', 'insert', { label: 'Open a case', creates: ['Case'] })]),
  );

  it('is named in the run’s result with where to rewind to, what it holds and adds, what it leaves out, and what it cost', async () => {
    const store = storeOf();
    const kept = {
      checkpoint: checkpointOf(
        ['Case', 'Account'],
        [{ objectApiName: 'FeedItem', reason: CHATTER }],
      ),
      requests: { total: 66, byPhase: {} as never },
      estimate: { records: 4, apiRequests: 68, apiRequestsLeft: 14_000, seconds: 3, bytes: 4_000 },
    };

    const outcome = await beforeRunOutcomeOf(store, scope, kept);

    expect(outcome).toEqual({
      taken: true,
      checkpoint: {
        state: 'taken',
        checkpointId: 'ck-20261022-140512-a1b2',
        name: 'Before Forge run 2026-10-22 14:05 UTC',
        takenAt: '2026-10-22T14:05:40.000Z',
        expiresAt: '2026-10-29T14:05:10.000Z',
        objects: ['Account', 'Case'],
        records: 4,
        bytes: 4_096,
        requests: 66,
        added: [
          {
            objectApiName: 'Case',
            reason:
              "The target's flow 'Open a case' creates Case records as Account records go in.",
          },
        ],
        notHeld: [
          {
            objectApiName: 'FeedItem',
            reason: `${CHATTER} A rewind leaves its records as they are.`,
          },
        ],
      },
    });
    expect(store.delete).not.toHaveBeenCalled();
    // Without the org's count of what it sent, the take's estimate says it.
    expect(beforeRunTakenOf(scope, { ...kept, requests: undefined }).requests).toBe(68);
  });

  it('is deleted again and refused when it holds none of the objects the run writes', async () => {
    const store = storeOf();

    const outcome = await beforeRunOutcomeOf(store, scope, {
      checkpoint: checkpointOf(['Case'], [{ objectApiName: 'Account', reason: ACTIVITIES }]),
      estimate: { records: 2, apiRequests: 9, apiRequestsLeft: 14_000, seconds: 1, bytes: 100 },
    });

    expect(outcome).toMatchObject({ taken: false, refusal: { code: 'NOTHING_HELD' } });
    expect(outcome.taken === false && 'refusal' in outcome && outcome.refusal.message).toMatch(
      /It was deleted again; nothing was written\.$/,
    );
    expect(store.delete).toHaveBeenCalledWith('ck-20261022-140512-a1b2');

    // The org's lock held meanwhile by a rewind: it is kept, and said so.
    const locked = storeOf({
      outcome: 'busy',
      holder: { operation: 'rewind', pid: 4242, host: 'build-1' } as never,
    });
    const kept = await beforeRunOutcomeOf(locked, scope, {
      checkpoint: checkpointOf(['Case'], [{ objectApiName: 'Account', reason: ACTIVITIES }]),
      estimate: { records: 2, apiRequests: 9, apiRequestsLeft: 14_000, seconds: 1, bytes: 100 },
    });
    expect(kept.taken === false && 'refusal' in kept && kept.refusal.message).toMatch(
      /It is kept all the same, as a rewind is writing \(process 4242 on build-1\): delete it from the Checkpoints page once that has ended\. Nothing was written\.$/,
    );
  });
});

describe('settleBeforeRun', () => {
  const taken: RunCheckpointTaken = {
    state: 'taken',
    checkpointId: 'ck-20261022-140512-a1b2',
    name: 'Before Sync run 2026-10-22 14:05 UTC',
    takenAt: '2026-10-22T14:05:40.000Z',
    expiresAt: null,
    objects: ['Account'],
    records: 2,
    bytes: 4_096,
    requests: 12,
    added: [],
    notHeld: [],
  };

  it('keeps the checkpoint of a run that wrote a record, and deletes that of a run that wrote none', async () => {
    const store = storeOf();
    expect(await settleBeforeRun(store, taken, true)).toEqual({ info: taken });
    expect(store.delete).not.toHaveBeenCalled();

    expect(await settleBeforeRun(store, taken, false)).toEqual({
      info: { state: 'deleted', deleted: 'nothingWritten' },
    });
    expect(store.delete).toHaveBeenCalledWith(taken.checkpointId);
  });

  it('keeps one a take, a rewind or an undo of its org holds the lock over, saying why', async () => {
    const store = storeOf({
      outcome: 'busy',
      holder: { operation: 'rewind', pid: 4242, host: 'build-1', startedAt: '' } as never,
    });

    const settled = await settleBeforeRun(store, taken, false);

    expect(settled.info).toBe(taken);
    expect(settled.notDeleted).toBe(
      "The checkpoint 'Before Sync run 2026-10-22 14:05 UTC' taken before the run is kept, " +
        'though the run wrote nothing: a rewind is writing (process 4242 on build-1). Delete it ' +
        'from the Checkpoints page once that has ended.',
    );
  });
});

describe('what the run says of its checkpoint', () => {
  it('says a refusal with nothing written and what to do, without the take’s own last words', () => {
    expect(
      beforeRunRefusedWords({
        message:
          'A SandForge run is writing to DEV-SB: start this run once it has ended. No record was read.',
      }),
    ).toBe(
      'The checkpoint before the run was refused: A SandForge run is writing to DEV-SB: start ' +
        'this run once it has ended. Nothing was written. Untick Checkpoint first to run ' +
        'without it, or fix what refuses it.',
    );
  });

  it('says a failure, a deletion and its progress', () => {
    expect(beforeRunFailedWords(new Error('ENOSPC: no space left on device.'))).toBe(
      'The checkpoint before the run could not be taken: ENOSPC: no space left on device. ' +
        'Nothing was written.',
    );
    expect(BEFORE_RUN_DELETED_WORDS).toBe(
      'The checkpoint taken before the run was deleted: the run wrote nothing.',
    );
    expect(beforeRunProgressWords(41.6)).toBe('Taking the checkpoint first (42%)');
  });
});
