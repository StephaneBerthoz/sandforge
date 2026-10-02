import type {
  ForgeTargetAutomation,
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
  /** A record-triggered flow, or an Apex trigger. */
  kind: 'flow' | 'trigger';
  /** The flow's label, or the trigger's name. */
  name: string;
  /** Before the record is saved — or deleted — after it, or both: a trigger can run on both. */
  when: 'before' | 'after' | 'beforeAndAfter';
  /** The flow as it was read; absent for a trigger. */
  flow?: ForgeTargetFlow;
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
 * What each write of a record of `object` fires in the target, in the order
 * the platform runs it: the flows before the save, the triggers, then the
 * flows after it. A flow that starts on a record created or updated fires on
 * both writes, and is listed under each.
 */
export function automationByWrite(object: ForgeTargetObjectAutomation): ForgeAutomationOfWrite[] {
  return WRITES.map((write) => {
    const flows = object.flows.filter((flow) => FLOW_WRITES[flow.startsOn].includes(write));
    const flow = (f: ForgeTargetFlow): ForgeAutomationFired => ({
      kind: 'flow',
      name: f.label,
      when: f.timing === 'afterSave' ? 'after' : 'before',
      flow: f,
    });
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
        ...flows.filter((f) => f.timing !== 'afterSave').map(flow),
        ...triggers,
        ...flows.filter((f) => f.timing === 'afterSave').map(flow),
      ],
    };
  }).filter((entry) => entry.fired.length > 0);
}

/**
 * The custom permissions that keep a flow of the target from starting for the
 * user who holds them, each once, in name order: assigned to the user a run
 * writes as, they keep those flows quiet. A permission a start condition names
 * any other way is not among them.
 */
export function bypassPermissionsOf(automation: Pick<ForgeTargetAutomation, 'objects'>): string[] {
  const names = automation.objects.flatMap((object) =>
    object.flows.flatMap((flow) =>
      flow.permissions.filter((permission) => permission.bypass).map(({ name }) => name),
    ),
  );
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** How many flows and triggers of the target fire as a run inserts its records. */
export function firedOnInsert(automation: Pick<ForgeTargetAutomation, 'objects'>): number {
  return automation.objects.reduce(
    (sum, object) =>
      sum +
      (automationByWrite(object).find((entry) => entry.write === 'insert')?.fired.length ?? 0),
    0,
  );
}
