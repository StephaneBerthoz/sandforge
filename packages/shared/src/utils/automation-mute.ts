import type {
  ForgePermissionSetGrant,
  ForgeTargetAutomation,
  ForgeTargetFlow,
} from '../types/forge.types.js';
import {
  automationFiredOn,
  bypassAssignmentsOf,
  type ForgeAutomationFired,
  type ForgeAutomationWrite,
} from './forge-target-automation.js';

/**
 * Muting the target's automation for a run: through the org's own bypass,
 * never by deactivating anything.
 *
 * The read of the target's automation (`TargetAutomationReader`) finds the
 * custom permissions an org's flows, processes and workflow rules test to stay
 * quiet for the user who holds them, and the smallest permission set holding
 * each. Every run printed "bypass: assign … to the user the run writes as",
 * and left it to the user. A run asked to mute assigns those sets to the user
 * it writes as, for its own duration, and takes them back as it ends
 * (`AutomationMuteLease` in the extension): what is planned here is which
 * sets that is, what they silence, and what still runs.
 */

/** The writes a run may make of a record, each of which fires the target's automation its own way. */
const WRITES: readonly ForgeAutomationWrite[] = ['insert', 'update', 'delete', 'undelete'];

/** One flow, process, workflow rule or Apex trigger of the target, on one object. */
export interface MutedAutomationEntry {
  objectApiName: string;
  kind: ForgeAutomationFired['kind'];
  /** The flow's, process's or rule's label, or the trigger's name. */
  name: string;
}

/** An automation a run's mute keeps quiet, and the bypass that does. */
export interface MutedAutomationSilenced extends MutedAutomationEntry {
  /** The custom permission its condition tests, held through the permission set assigned. */
  permission: string;
}

/**
 * Why a mute leaves an automation running: `noBypass`, its condition names no
 * custom permission that keeps it quiet — an Apex trigger's code is never
 * read, and is always so —; `managedPackage`, a managed package installed it,
 * and no one in the org reads or changes it; `notRead`, its condition was
 * left unread or refused, and what it tests is not known; `noPermissionSet`,
 * it has a bypass that no permission set a user can be assigned holds, or
 * whose permission sets could not be read.
 */
export type MuteStillRunsWhy = 'noBypass' | 'managedPackage' | 'notRead' | 'noPermissionSet';

/** An automation that still runs for a run that mutes, and why. */
export interface MutedAutomationStillRunning extends MutedAutomationEntry {
  why: MuteStillRunsWhy;
}

/** A permission set a mute assigns, and the bypasses it is assigned for. */
export interface MuteAssignment {
  /** Its API name, after its namespace's prefix and two underscores when a package installed it. */
  permissionSet: string;
  label: string;
  /** The bypasses among the custom permissions it holds that the run's automation tests. */
  permissions: string[];
}

/**
 * Something of the target a set a mute assigns lifts beside what it was
 * assigned for: a validation rule, a flow, a process or a workflow rule of an
 * object the run writes whose formula or condition a custom permission the
 * set grants keeps quiet. On the trap org, the set assigned to quiet a
 * workflow rule and a flow held the bypass of two validation rules as well: a
 * contact those rules refused without the mute was written with it, and
 * nothing said so. An Apex trigger is never among them: what its code tests
 * is not read.
 */
export interface MutedAutomationAlsoLifted {
  objectApiName: string;
  kind: 'validationRule' | 'flow' | 'process' | 'workflowRule';
  /** The rule's name, or the flow's, process's or rule's label. */
  name: string;
  /** The custom permission that keeps it quiet, which the set grants. */
  permission: string;
  /** The permission set assigned that grants it, by API name. */
  permissionSet: string;
}

/**
 * What could not be read of what a mute's sets lift, said rather than taken
 * for nothing: what a set grants (`grants`), or the validation rules of the
 * objects the run writes (`validationRules`) — none listed, or `rules` of
 * them whose formula was not read.
 */
export interface MuteLiftsUnread {
  part: 'grants' | 'validationRules';
  /** The set whose grants were not read. */
  permissionSet?: string;
  /** The validation rules whose formula was not read; absent when none could be listed. */
  rules?: number;
  /** The org's answer, or what kept the read from it. */
  reason?: string;
}

/** What a run that mutes the target's automation would do, planned from the read of it. */
export interface MutePlan {
  /** The permission sets to hold for the run, the fewest that hold every bypass needed. */
  assign: MuteAssignment[];
  /** What they keep quiet, object by object in the order the read lists them. */
  silenced: MutedAutomationSilenced[];
  /** What fires all the same, and why. What a bypass the user already holds keeps quiet is in neither. */
  stillRuns: MutedAutomationStillRunning[];
  /** What those sets lift beside what they are assigned for ({@link MutedAutomationAlsoLifted}); absent when nothing. */
  alsoLifts?: MutedAutomationAlsoLifted[];
  /** What could not be read of what they lift; absent when everything was. */
  liftsUnread?: MuteLiftsUnread[];
}

/**
 * What a run did of the option to mute the target's automation, as its result
 * and the command lines say it. `muted`: the sets were held for the run —
 * assigned, or held already —; `nothing`: nothing found could be muted, and
 * the run went on as without the option; `planned`: a dry run, which assigns
 * nothing.
 */
export interface MutedAutomation {
  state: 'muted' | 'nothing' | 'planned';
  /** The permission sets assigned to the user the run writes as for it, by API name. */
  assigned: string[];
  /**
   * The permission sets the run needed that the user held already — their
   * own, or another run's of this machine still under way —: neither
   * assigned nor taken back by this run.
   */
  held: string[];
  /** The bypasses those sets hold, which the automation silenced tests. */
  permissions: string[];
  silenced: MutedAutomationSilenced[];
  stillRan: MutedAutomationStillRunning[];
  /** What the sets lifted beside what they were assigned for; absent when nothing. */
  alsoLifted?: MutedAutomationAlsoLifted[];
  /** What could not be read of what they lift; absent when everything was. */
  liftsUnread?: MuteLiftsUnread[];
  /**
   * Whether every assignment made for the run was taken back as it ended.
   * False leaves them to the lease's end, released by the next run of this
   * machine that mutes the same org; absent before the run ends, on a dry
   * run, and when nothing was assigned.
   */
  released?: boolean;
  /** When the lease ends, by this machine's clock: what is left past it is taken back by the next run that mutes. */
  leaseEndsAt?: string;
  /** Why nothing was muted, or what could not be taken back, in words. */
  reason?: string;
}

/** What the audit trail keeps of a run's mute: the permission sets by name, the automations by count. */
export interface AuditMutedAutomation {
  state: MutedAutomation['state'];
  assigned: string[];
  held: string[];
  silenced: number;
  stillRan: number;
  /** What the sets lifted beside what they were assigned for, by count; absent when nothing was planned. */
  alsoLifted?: number;
  released?: boolean;
}

/** The entry an automation is listed under, each once. */
function entryKey(entry: MutedAutomationEntry): string {
  return `${entry.objectApiName}\n${entry.kind}\n${entry.name}`;
}

/**
 * The package that installed a flow or a process: what its API name holds
 * before two underscores, which a flow's own name never does. A trigger a
 * package installed is named after its namespace and a dot.
 */
function installedByPackage(fired: ForgeAutomationFired): boolean {
  if (fired.kind === 'trigger') return fired.name.includes('.');
  const apiName = fired.flow?.apiName ?? '';
  return apiName.indexOf('__') > 0;
}

/** The bypasses of `flow` the user does not hold, in the order its condition names them. */
function bypassesNotHeld(flow: ForgeTargetFlow | undefined): string[] {
  return (flow?.permissions ?? [])
    .filter((permission) => permission.bypass && permission.held !== true)
    .map(({ name }) => name);
}

/**
 * Plan a run's mute from the read of the target's automation: the permission
 * sets whose bypasses keep quiet what the run's writes fire, the automations
 * they silence, and those that still run. What a bypass the user already
 * holds keeps quiet is left out of both: it was quiet without the option.
 *
 * Each bypass is given the smallest permission set that holds it — the one
 * the automation report names — unless a set already chosen holds it too:
 * the fewest sets, each granting the least beside the bypass. What else
 * those sets lift is planned with them ({@link liftsOf}).
 *
 * @param writes - The writes the run makes, per object; every write of every
 *   object read when not told. A Forge run inserts, and updates what it
 *   writes a second time; a removal deletes; a rewind undeletes, inserts,
 *   updates and deletes.
 */
export function mutePlanOf(
  automation: Pick<ForgeTargetAutomation, 'objects' | 'bypassGrants'> & LiftsRead,
  writes: (objectApiName: string, write: ForgeAutomationWrite) => boolean = () => true,
): MutePlan {
  const seen = new Set<string>();
  const silenced: MutedAutomationSilenced[] = [];
  const stillRuns: MutedAutomationStillRunning[] = [];
  const assign: MuteAssignment[] = [];
  const setOf = (permission: string): MuteAssignment | undefined => {
    const key = permission.toLowerCase();
    const chosen = assign.find((a) => a.permissions.some((p) => p.toLowerCase() === key));
    if (chosen) return chosen;
    const [found] = bypassAssignmentsOf(automation, [permission]);
    if (!found?.permissionSet) return undefined;
    const holders = [found.permissionSet, ...found.others].map((set) => set.name);
    const already = assign.find((a) => holders.includes(a.permissionSet));
    if (already) {
      already.permissions.push(found.permission);
      return already;
    }
    const added: MuteAssignment = {
      permissionSet: found.permissionSet.name,
      label: found.permissionSet.label,
      permissions: [found.permission],
    };
    assign.push(added);
    return added;
  };
  for (const object of automation.objects) {
    for (const write of WRITES) {
      if (!writes(object.objectApiName, write)) continue;
      for (const fired of automationFiredOn(object, write)) {
        if (fired.keptQuiet === true) continue;
        const entry: MutedAutomationEntry = {
          objectApiName: object.objectApiName,
          kind: fired.kind,
          name: fired.name,
        };
        const key = entryKey(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        const bypasses = fired.kind === 'trigger' ? [] : bypassesNotHeld(fired.flow);
        const silencing = bypasses.find((permission) => setOf(permission) !== undefined);
        if (silencing !== undefined) {
          silenced.push({ ...entry, permission: silencing });
          continue;
        }
        const why: MuteStillRunsWhy = installedByPackage(fired)
          ? 'managedPackage'
          : bypasses.length > 0
            ? 'noPermissionSet'
            : fired.flow !== undefined && fired.flow.condition !== 'read'
              ? 'notRead'
              : 'noBypass';
        stillRuns.push({ ...entry, why });
      }
    }
  }
  for (const set of assign) set.permissions.sort((a, b) => a.localeCompare(b));
  const { alsoLifts, liftsUnread } = liftsOf(automation, assign, silenced, writes);
  return {
    assign,
    silenced,
    stillRuns,
    ...(alsoLifts.length > 0 ? { alsoLifts } : {}),
    ...(liftsUnread.length > 0 ? { liftsUnread } : {}),
  };
}

/** What of the read says what the sets lift: the validation rules a permission keeps quiet. */
type LiftsRead = Partial<
  Pick<
    ForgeTargetAutomation,
    'validationRuleBypasses' | 'validationRulesNotRead' | 'validationRulesUnread'
  >
>;

/** A permission set of the read, by its API name, as the bypass grants list it. */
function grantOf(
  automation: Pick<ForgeTargetAutomation, 'bypassGrants'>,
  permissionSet: string,
): ForgePermissionSetGrant | undefined {
  return automation.bypassGrants
    ?.flatMap((grant) => grant.permissionSets)
    .find((set) => set.name === permissionSet);
}

/**
 * What the sets of `assign` lift beside what the plan assigns them for: per
 * set, the custom permissions it grants, as the read found them, that keep
 * quiet a validation rule, or a flow, process or workflow rule the plan does
 * not silence, of an object the run writes. A flow is named whatever write
 * starts it: a run that only inserts can update what it inserted through the
 * target's own automation, which the set then lets through as well. What a
 * permission the user holds keeps quiet was quiet without the mute, and is
 * left out. A set whose grants were not read, and validation rules not read,
 * are said, never taken for nothing.
 */
function liftsOf(
  automation: Pick<ForgeTargetAutomation, 'objects' | 'bypassGrants'> & LiftsRead,
  assign: readonly MuteAssignment[],
  silenced: readonly MutedAutomationSilenced[],
  writes: (objectApiName: string, write: ForgeAutomationWrite) => boolean,
): { alsoLifts: MutedAutomationAlsoLifted[]; liftsUnread: MuteLiftsUnread[] } {
  const alsoLifts: MutedAutomationAlsoLifted[] = [];
  const liftsUnread: MuteLiftsUnread[] = [];
  if (assign.length === 0) return { alsoLifts, liftsUnread };
  const granted: Array<{ permissionSet: string; permissions: Set<string> }> = [];
  for (const { permissionSet } of assign) {
    const set = grantOf(automation, permissionSet);
    if (set?.customPermissions === undefined) {
      liftsUnread.push({
        part: 'grants',
        permissionSet,
        ...(set?.customPermissionsUnread ? { reason: set.customPermissionsUnread } : {}),
      });
      continue;
    }
    granted.push({
      permissionSet,
      permissions: new Set(set.customPermissions.map((name) => name.toLowerCase())),
    });
  }
  if (granted.length === 0) return { alsoLifts, liftsUnread };
  const grantedBy = (permission: string): string | undefined =>
    granted.find((set) => set.permissions.has(permission.toLowerCase()))?.permissionSet;
  const written = (objectApiName: string): boolean =>
    WRITES.some((write) => writes(objectApiName, write));
  const quiet = new Set(silenced.map(entryKey));
  for (const object of automation.objects) {
    if (!written(object.objectApiName)) continue;
    const lists: Array<
      [MutedAutomationEntry['kind'] & MutedAutomationAlsoLifted['kind'], readonly ForgeTargetFlow[]]
    > = [
      ['flow', object.flows],
      ['process', object.processes ?? []],
      ['workflowRule', object.workflowRules ?? []],
    ];
    for (const [kind, flows] of lists) {
      for (const flow of flows) {
        const entry = { objectApiName: object.objectApiName, kind, name: flow.label };
        if (quiet.has(entryKey(entry))) continue;
        // Quiet for the user already: the mute changes nothing of it.
        if (flow.permissions.some((p) => p.bypass && p.held === true)) continue;
        const lifting = flow.permissions.find(
          (p) => p.bypass && p.held !== true && grantedBy(p.name) !== undefined,
        );
        if (lifting) {
          alsoLifts.push({
            ...entry,
            permission: lifting.name,
            permissionSet: grantedBy(lifting.name)!,
          });
        }
      }
    }
  }
  if (automation.validationRuleBypasses === undefined) {
    liftsUnread.push({
      part: 'validationRules',
      ...(automation.validationRulesUnread ? { reason: automation.validationRulesUnread } : {}),
    });
    return { alsoLifts, liftsUnread };
  }
  for (const rule of automation.validationRuleBypasses) {
    if (!written(rule.objectApiName)) continue;
    const permission = rule.permissions.find((name) => grantedBy(name) !== undefined);
    if (permission === undefined) continue;
    alsoLifts.push({
      objectApiName: rule.objectApiName,
      kind: 'validationRule',
      name: rule.name,
      permission,
      permissionSet: grantedBy(permission)!,
    });
  }
  const notRead = automation.validationRulesNotRead ?? 0;
  if (notRead > 0) liftsUnread.push({ part: 'validationRules', rules: notRead });
  return { alsoLifts, liftsUnread };
}

/** The bypasses a plan holds, each once, in name order. */
export function mutePermissionsOf(plan: Pick<MutePlan, 'assign'>): string[] {
  const names = plan.assign.flatMap((set) => set.permissions);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * The read of the target's automation as it stands for a run that holds the
 * bypasses `permissions`: each held, as though the read had found the user
 * holding it, and gone from what is left to assign. What every gate counts
 * and asks about — what fires, the emails it sends, what a removal sets off
 * — then leaves out what the mute keeps quiet, and asks only for what still
 * runs.
 */
export function mutedAutomationOf<
  A extends Pick<ForgeTargetAutomation, 'objects'> & {
    bypassGrants?: ForgeTargetAutomation['bypassGrants'];
  },
>(automation: A, permissions: readonly string[]): A {
  if (permissions.length === 0) return automation;
  const muted = new Set(permissions.map((name) => name.toLowerCase()));
  const holding = (flow: ForgeTargetFlow): ForgeTargetFlow =>
    flow.permissions.some((p) => p.bypass && muted.has(p.name.toLowerCase()))
      ? {
          ...flow,
          permissions: flow.permissions.map((p) =>
            p.bypass && muted.has(p.name.toLowerCase()) ? { ...p, held: true } : p,
          ),
        }
      : flow;
  const grants = automation.bypassGrants?.filter(
    (grant) => !muted.has(grant.permission.toLowerCase()),
  );
  return {
    ...automation,
    objects: automation.objects.map((object) => ({
      ...object,
      flows: object.flows.map(holding),
      ...(object.processes ? { processes: object.processes.map(holding) } : {}),
      ...(object.workflowRules ? { workflowRules: object.workflowRules.map(holding) } : {}),
    })),
    ...(grants !== undefined ? { bypassGrants: grants } : {}),
  };
}

/** What the audit trail keeps of a run's mute ({@link AuditMutedAutomation}). */
export function auditMutedOf(muted: MutedAutomation): AuditMutedAutomation {
  return {
    state: muted.state,
    assigned: [...muted.assigned],
    held: [...muted.held],
    silenced: muted.silenced.length,
    stillRan: muted.stillRan.length,
    ...(muted.alsoLifted !== undefined ? { alsoLifted: muted.alsoLifted.length } : {}),
    ...(muted.released !== undefined ? { released: muted.released } : {}),
  };
}

/** How a line names an automation of the target. */
const KIND_WORDS: Readonly<Record<MutedAutomationEntry['kind'], string>> = {
  flow: 'flow',
  trigger: 'Apex trigger',
  process: 'process',
  workflowRule: 'workflow rule',
};

/** Why an automation still runs, as a line says it. */
const WHY_WORDS: Readonly<Record<MuteStillRunsWhy, string>> = {
  noBypass: 'no bypass in its condition',
  managedPackage: 'installed by a managed package',
  notRead: 'its condition was not read',
  noPermissionSet: 'no permission set holds its bypass',
};

/** An automation, as a line names it: its kind, its name, and its object. */
export function mutedEntryWords(entry: MutedAutomationEntry): string {
  return `${entry.objectApiName}: ${KIND_WORDS[entry.kind]} "${entry.name}"`;
}

/** Why an automation still runs, in words. */
export function stillRunsWords(why: MuteStillRunsWhy): string {
  return WHY_WORDS[why];
}

/** How a line names what a set lifts beside what it was assigned for. */
const LIFTED_WORDS: Readonly<Record<MutedAutomationAlsoLifted['kind'], string>> = {
  validationRule: 'validation rule',
  flow: 'flow',
  process: 'process',
  workflowRule: 'workflow rule',
};

/**
 * What a set lifts, as a line names it: its kind, its name, its object, the
 * permission that keeps it quiet and the set that grants it —
 * `validation rule "Email_Required" on Contact (Bypass_VR, in PS_Bypass)`.
 */
export function alsoLiftedWords(entry: MutedAutomationAlsoLifted): string {
  return (
    `${LIFTED_WORDS[entry.kind]} "${entry.name}" on ${entry.objectApiName} ` +
    `(${entry.permission}, in ${entry.permissionSet})`
  );
}

/** What could not be read of what the sets lift, in words. */
export function liftsUnreadWords(unread: MuteLiftsUnread): string {
  const why = unread.reason ? ` (${unread.reason})` : '';
  if (unread.part === 'grants') {
    return `what ${unread.permissionSet ?? 'a permission set'} grants could not be read${why}: what else it lifts is not known`;
  }
  return unread.rules !== undefined
    ? `${unread.rules} validation rule formula(s) not read: whether the sets lift those rules is not known`
    : `the validation rules of the objects written could not be read${why}: whether the sets lift any is not known`;
}
