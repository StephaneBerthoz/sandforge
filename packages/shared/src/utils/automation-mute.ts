import type { ForgeTargetAutomation, ForgeTargetFlow } from '../types/forge.types.js';
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

/** What a run that mutes the target's automation would do, planned from the read of it. */
export interface MutePlan {
  /** The permission sets to hold for the run, the fewest that hold every bypass needed. */
  assign: MuteAssignment[];
  /** What they keep quiet, object by object in the order the read lists them. */
  silenced: MutedAutomationSilenced[];
  /** What fires all the same, and why. What a bypass the user already holds keeps quiet is in neither. */
  stillRuns: MutedAutomationStillRunning[];
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
 * the fewest sets, each granting the least beside the bypass.
 *
 * @param writes - The writes the run makes, per object; every write of every
 *   object read when not told. A Forge run inserts, and updates what it
 *   writes a second time; a removal deletes; a rewind undeletes, inserts,
 *   updates and deletes.
 */
export function mutePlanOf(
  automation: Pick<ForgeTargetAutomation, 'objects' | 'bypassGrants'>,
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
  return { assign, silenced, stillRuns };
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
