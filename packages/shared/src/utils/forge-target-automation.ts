import type {
  ForgePermissionSetGrant,
  ForgeRemovalRisk,
  ForgeTargetAutomation,
  ForgeTargetAutomationUnread,
  ForgeTargetFlow,
  ForgeTargetObjectAutomation,
  ForgeTriggerEvent,
} from '../types/forge.types.js';
import { LOCKED_PAST_DRAFT } from '../constants/status-children.js';

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

/** One flow, trigger, process or rule that fires as a write writes a record of its object. */
export interface ForgeFiredOnWrite {
  objectApiName: string;
  write: ForgeAutomationWrite;
  kind: ForgeAutomationFired['kind'];
  /** The flow's, process's or rule's label, or the trigger's name. */
  name: string;
  when: ForgeAutomationFired['when'];
}

/**
 * What fires in the target as `write` writes the records of the objects `on`
 * keeps — every object unless told — per object. What a bypass the user the
 * run writes as holds keeps quiet does not fire for its records, and is left
 * out, as the Automation tab counts it.
 */
export function firedOnWriteOf(
  automation: Pick<ForgeTargetAutomation, 'objects'>,
  write: ForgeAutomationWrite,
  on: (objectApiName: string) => boolean = () => true,
): ForgeFiredOnWrite[] {
  return automation.objects
    .filter((object) => on(object.objectApiName))
    .flatMap((object) =>
      (automationByWrite(object).find((entry) => entry.write === write)?.fired ?? [])
        .filter((fired) => fired.keptQuiet !== true)
        .map((fired) => ({
          objectApiName: object.objectApiName,
          write,
          kind: fired.kind,
          name: fired.name,
          when: fired.when,
        })),
    );
}

/**
 * The custom permissions that keep quiet, for the user who holds them, a
 * flow, a process or a rule firing on the writes `writes` keeps, each once,
 * in name order.
 */
export function bypassesOfWrites(
  automation: Pick<ForgeTargetAutomation, 'objects'>,
  writes: (objectApiName: string, write: ForgeAutomationWrite) => boolean,
): string[] {
  const names = automation.objects.flatMap((object) =>
    automationByWrite(object)
      .filter(({ write }) => writes(object.objectApiName, write))
      .flatMap(({ fired }) => fired)
      .flatMap((fired) =>
        (fired.flow?.permissions ?? []).filter((p) => p.bypass).map((p) => p.name),
      ),
  );
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * What fires in the target as a removal takes a run's records back: as it
 * sets the records of the objects `drafted` back to Draft before deleting
 * them — an activated order, which the platform deletes no other way — then
 * as it deletes the records of every object, in that order.
 */
export function firedOnRemovalOf(
  automation: Pick<ForgeTargetAutomation, 'objects'>,
  drafted: readonly string[],
): ForgeFiredOnWrite[] {
  const drafting = new Set(drafted);
  return [
    ...firedOnWriteOf(automation, 'update', (name) => drafting.has(name)),
    ...firedOnWriteOf(automation, 'delete'),
  ];
}

/**
 * The custom permissions that keep quiet, for the user who holds them, what a
 * removal fires ({@link firedOnRemovalOf}), each once, in name order.
 */
export function removalBypassesOf(
  automation: Pick<ForgeTargetAutomation, 'objects'>,
  drafted: readonly string[],
): string[] {
  const drafting = new Set(drafted);
  return bypassesOfWrites(
    automation,
    (objectApiName, write) =>
      write === 'delete' || (write === 'update' && drafting.has(objectApiName)),
  );
}

/**
 * What it takes to keep quiet the flows a bypass the user the run writes as
 * does not hold excludes: the smallest permission set of the target that
 * includes it, to assign to that user, and the others that do; none when no
 * permission set a user can be assigned holds it, and an admin creates one.
 */
export interface ForgeBypassAssignment {
  /** The custom permission, as `$Permission.<name>` names it. */
  permission: string;
  /** The smallest permission set that includes it; absent when none does. */
  permissionSet?: ForgePermissionSetGrant;
  /** The other permission sets that include it, the smallest first. */
  others: ForgePermissionSetGrant[];
}

/**
 * The assignments of the bypasses among `permissions` whose permission sets
 * the read looked up, in the order given. A bypass it did not look up — the
 * read could not, or the user holds it — has none: nothing is said of it
 * that the read did not find.
 */
export function bypassAssignmentsOf(
  automation: Pick<ForgeTargetAutomation, 'bypassGrants'>,
  permissions: readonly string[],
): ForgeBypassAssignment[] {
  const grants = automation.bypassGrants ?? [];
  return permissions.flatMap((permission) => {
    const grant = grants.find((g) => g.permission.toLowerCase() === permission.toLowerCase());
    if (!grant) return [];
    const [smallest, ...others] = grant.permissionSets;
    return [
      { permission: grant.permission, ...(smallest ? { permissionSet: smallest } : {}), others },
    ];
  });
}

/**
 * A word of a command line as a shell takes it whole: bare when it holds
 * nothing a shell reads, quoted otherwise — an alias may hold a space.
 */
function shellWord(value: string): string {
  return /^[\w.@+:-]+$/.test(value) ? value : `"${value.replace(/["\\$`]/g, '\\$&')}"`;
}

/**
 * The command that assigns a permission set to the user a run writes as,
 * with the Salesforce CLI. SandForge shows it and never runs it: assigning a
 * permission is the org's admin's to decide, and to do.
 *
 * @param permissionSet - The permission set's API name, after its namespace's prefix when it has one.
 * @param targetOrg - The target org, by the alias the Salesforce CLI knows it by.
 * @param username - The user the run writes as.
 */
export function assignPermsetCommand(
  permissionSet: string,
  targetOrg: string,
  username: string,
): string {
  return (
    `sf org assign permset --name ${shellWord(permissionSet)} ` +
    `--target-org ${shellWord(targetOrg)} --on-behalf-of ${shellWord(username)}`
  );
}

/**
 * What may refuse the removal of a run's records, object by object in the
 * order the run writes them, said before the run: the record-triggered flows
 * that run before a record is deleted and the Apex triggers on a delete — a
 * flow or a trigger can refuse it — those a managed package installed apart,
 * as no one in the org can change them, and the objects whose records lock
 * the rows under them past Draft (`LOCKED_PAST_DRAFT`): an activated order's
 * items and actions, an activated contract's item prices. What a bypass the
 * run's user holds keeps quiet is left out: the removal runs as that user.
 *
 * @param leftOut - Objects the run no longer writes since the read.
 */
export function removalRisksOf(
  automation: Pick<ForgeTargetAutomation, 'objects' | 'objectsRead'>,
  leftOut: ReadonlySet<string> = new Set(),
): ForgeRemovalRisk[] {
  const byObject = new Map(automation.objects.map((object) => [object.objectApiName, object]));
  return automation.objectsRead
    .filter((name) => !leftOut.has(name))
    .flatMap((objectApiName): ForgeRemovalRisk[] => {
      const object = byObject.get(objectApiName);
      const onDelete = object
        ? (automationByWrite(object).find((entry) => entry.write === 'delete')?.fired ?? [])
        : [];
      const fired = onDelete
        .filter((entry) => entry.keptQuiet !== true)
        .map((entry): ForgeRemovalRisk => ({
          objectApiName,
          // A trigger a package installed is named after its namespace.
          kind:
            entry.kind !== 'trigger'
              ? 'flow'
              : entry.name.includes('.')
                ? 'packageTrigger'
                : 'trigger',
          name: entry.name,
        }));
      return Object.prototype.hasOwnProperty.call(LOCKED_PAST_DRAFT, objectApiName)
        ? [...fired, { objectApiName, kind: 'lock' }]
        : fired;
    });
}
