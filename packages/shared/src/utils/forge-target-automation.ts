import type {
  ForgeTargetAutomation,
  ForgeTargetAutomationUnread,
  ForgeTargetFlow,
  ForgeTargetObjectAutomation,
  ForgeTriggerEvent,
} from '../types/forge.types.js';

/**
 * A write a Forge run makes of a record: the insert of every record it
 * creates, the update of those it writes a second time — a lookup filled in
 * once its record exists, an order given back its status — and the delete of
 * a removal of the run.
 */
export type ForgeAutomationWrite = 'insert' | 'update' | 'delete';

/** What one write of a record fires of the target's automation. */
export interface ForgeAutomationFired {
  /** A record-triggered flow, an Apex trigger, a Process Builder process, or a workflow rule. */
  kind: 'flow' | 'trigger' | 'process' | 'workflowRule';
  /** The flow's, process's or rule's label, or the trigger's name. */
  name: string;
  /** Before the record is saved — or deleted — after it, or both: a trigger can run on both. */
  when: 'before' | 'after' | 'beforeAndAfter';
  /** The flow, process or rule as it was read; absent for a trigger. */
  flow?: ForgeTargetFlow;
  /**
   * True when the user the run writes as holds a custom permission that keeps
   * it from doing anything: it fires for other users, not for this run.
   */
  keptQuiet?: boolean;
}

/** What one write fires on an object, the writes that fire nothing left out. */
export interface ForgeAutomationOfWrite {
  write: ForgeAutomationWrite;
  fired: ForgeAutomationFired[];
}

/** The writes that start a flow, by what `RecordTriggerType` says. */
const FLOW_WRITES: Readonly<Record<ForgeTargetFlow['startsOn'], readonly ForgeAutomationWrite[]>> =
  {
    create: ['insert'],
    update: ['update'],
    createAndUpdate: ['insert', 'update'],
    delete: ['delete'],
  };

/**
 * The trigger events of each write, before then after. `afterUndelete` is
 * none of them: a run never takes a record back from the recycle bin.
 */
const TRIGGER_EVENTS: Readonly<
  Record<ForgeAutomationWrite, readonly [ForgeTriggerEvent, ForgeTriggerEvent]>
> = {
  insert: ['beforeInsert', 'afterInsert'],
  update: ['beforeUpdate', 'afterUpdate'],
  delete: ['beforeDelete', 'afterDelete'],
};

const WRITES: readonly ForgeAutomationWrite[] = ['insert', 'update', 'delete'];

/**
 * Whether the user the run writes as holds a permission that keeps `flow`
 * from doing anything: a bypass is only read as one when it ends the whole of
 * it, start condition or the Decision every path of it starts with.
 */
function keptQuiet(flow: ForgeTargetFlow): boolean {
  return flow.permissions.some((permission) => permission.bypass && permission.held === true);
}

/**
 * What each write of a record of `object` fires in the target, in the order
 * the platform runs it: the flows before the save, the triggers, the workflow
 * rules, the processes, then the flows after it. A flow that starts on a
 * record created or updated fires on both writes, and is listed under each.
 */
export function automationByWrite(object: ForgeTargetObjectAutomation): ForgeAutomationOfWrite[] {
  return WRITES.map((write) => {
    const starting = (list: readonly ForgeTargetFlow[] | undefined): ForgeTargetFlow[] =>
      (list ?? []).filter((flow) => FLOW_WRITES[flow.startsOn].includes(write));
    const entry =
      (kind: ForgeAutomationFired['kind']) =>
      (f: ForgeTargetFlow): ForgeAutomationFired => ({
        kind,
        name: f.label,
        when: f.timing === 'afterSave' ? 'after' : 'before',
        flow: f,
        ...(keptQuiet(f) ? { keptQuiet: true } : {}),
      });
    const flows = starting(object.flows);
    const [before, after] = TRIGGER_EVENTS[write];
    const triggers = object.triggers.flatMap((trigger): ForgeAutomationFired[] => {
      const runsBefore = trigger.events.includes(before);
      const runsAfter = trigger.events.includes(after);
      if (!runsBefore && !runsAfter) return [];
      const when = runsBefore && runsAfter ? 'beforeAndAfter' : runsBefore ? 'before' : 'after';
      return [{ kind: 'trigger', name: trigger.name, when }];
    });
    return {
      write,
      fired: [
        ...flows.filter((f) => f.timing !== 'afterSave').map(entry('flow')),
        ...triggers,
        ...starting(object.workflowRules).map(entry('workflowRule')),
        ...starting(object.processes).map(entry('process')),
        ...flows.filter((f) => f.timing === 'afterSave').map(entry('flow')),
      ],
    };
  }).filter((entry) => entry.fired.length > 0);
}

/** Every flow, process and workflow rule the target runs on the objects of `automation`. */
function flowsOf(automation: Pick<ForgeTargetAutomation, 'objects'>): ForgeTargetFlow[] {
  return automation.objects.flatMap((object) => [
    ...object.flows,
    ...(object.processes ?? []),
    ...(object.workflowRules ?? []),
  ]);
}

/**
 * The custom permissions that keep a flow, a process or a workflow rule of
 * the target from doing anything for the user who holds them, each once, in
 * name order: assigned to the user a run writes as, they keep those quiet. A
 * permission a condition names any other way is not among them.
 */
export function bypassPermissionsOf(automation: Pick<ForgeTargetAutomation, 'objects'>): string[] {
  const names = flowsOf(automation).flatMap((flow) =>
    flow.permissions.filter((permission) => permission.bypass).map(({ name }) => name),
  );
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * Those of {@link bypassPermissionsOf} the user the run writes as already
 * holds, as the read found them: what they keep quiet stays quiet for the run.
 */
export function heldBypassPermissionsOf(
  automation: Pick<ForgeTargetAutomation, 'objects'>,
): string[] {
  const names = flowsOf(automation).flatMap((flow) =>
    flow.permissions
      .filter((permission) => permission.bypass && permission.held === true)
      .map(({ name }) => name),
  );
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * The parts the read takes one item at a time — start conditions,
 * definitions, the permissions of the user — where one refused leaves what
 * the rest found standing.
 */
const PARTS_READ_IN_PIECES: ReadonlySet<ForgeTargetAutomationUnread['part']> = new Set([
  'conditions',
  'definitions',
  'userPermissions',
]);

/**
 * Whether what could not be read leaves "nothing runs on these objects"
 * unsaid: a part read whole that the target refused — its flows, its
 * triggers, its rules — was never seen, which is not the same as empty.
 */
export function blindedBy(unread: readonly ForgeTargetAutomationUnread[]): boolean {
  return unread.some(({ part }) => !PARTS_READ_IN_PIECES.has(part));
}

/**
 * How many flows, triggers, processes and workflow rules of the target fire
 * as a run inserts its records: those a permission of the user the run writes
 * as keeps quiet do not.
 */
export function firedOnInsert(automation: Pick<ForgeTargetAutomation, 'objects'>): number {
  return automation.objects.reduce(
    (sum, object) =>
      sum +
      (automationByWrite(object)
        .find((entry) => entry.write === 'insert')
        ?.fired.filter((fired) => fired.keptQuiet !== true).length ?? 0),
    0,
  );
}
