/**
 * What applying a file to an org would do: a pure function of the file, the
 * state, what the org holds of each applied run (its removal preview), what
 * each resource to write would write (its own dry run), and what the org has
 * left today. It reads nothing and writes nothing; the command line runs the
 * previews and the dry runs it asks for, through the scripts.
 *
 * Per resource, one action:
 *
 * - `create`: the state holds none of it, or only what a destroy took back;
 * - `keep`: applied from the same fingerprint, and the org holds every record
 *   of its run as written;
 * - `drifted`: applied from the same fingerprint, and records of it are gone,
 *   changed since by someone, or could not be read — or, for a frozen
 *   resource, its verification FAILED an object, named: left alone unless
 *   `--replace` or `--replace-drifted` asks;
 * - `replace`: what it writes changed in the file; a resource it depends on
 *   runs again (new records, new Ids); its last run was stopped part way,
 *   partial or failed; or the line asks. Its runs are taken back, then it
 *   runs again;
 * - `delete`: in the state, gone from the file: its runs are taken back;
 * - `blocked`: its dry run, its removal's preview, a summed gate or what this
 *   SandForge does not do refuses it — and the whole apply with it, before
 *   its first write.
 *
 * A mask resource has no removal to preview: its own dry run, on every plan
 * but a quick one, reads what the org holds of it. Applied from the same
 * fingerprint, it is kept while its condition selects as many records as it
 * masked, and drifted once it selects others — records copied in since,
 * which hold their original values. Replaced, it masks again, nothing taken
 * back first; deleted, its store goes, its snapshots with it, and its
 * records stay masked. A masking creates no record: what depends on one is
 * not replaced with it.
 *
 * A seed resource whose relations draw their parents from the records
 * another resource created is counted exactly once that resource has run:
 * its dry run is handed their ids. While that resource runs in the same
 * apply, nobody knows them: its count is the most the file gives, and the
 * plan says so, and how many parents each relation draws once they are known.
 *
 * Each script gates its own run against what the org has left, and sees no
 * other: three seeds that each fit can together overrun a Developer Edition's
 * day. So the plan adds up, across what it writes, each dry run's API
 * requests, data storage and emails, and blocks every writing action when a
 * sum goes past what the target has left. An environment half applied is
 * worse than none in a pipeline, and fifteen emails spent are gone for the
 * day.
 *
 * The checkpoints the file asks (`envCheckpoints.ts`) are part of the plan:
 * each take's cost, by the checkpoint script's own estimate, in the sum of
 * the API requests, and its refusal as the apply's, before its first write.
 * With a checkpoint taken after the last apply, the whole org is compared
 * with it, through its own preview: records of the environment written since
 * that hold again what they held once applied — a reset gives them back, and
 * dates them — are kept, not drifted.
 */

import {
  BYTES_PER_MB,
  type EnvAction,
  type EnvActionDraw,
  type EnvActionGates,
  type EnvActionKind,
  type EnvEmailLimit,
  type EnvPlan,
  type EnvPlanDrift,
  type EnvPlanObject,
  type EnvResourceKind,
  type EnvResourceState,
  type EnvState,
} from '@sandforge/shared';
import { formatMB } from '../../src/modules/forge/ForgeRunGate.js';
import {
  checkpointPlanLines,
  checkpointRefusalOf,
  checkpointRequestsOf,
  checkpointStepsOf,
  checkpointWarningsOf,
  planCheckpointsOf,
  type CheckpointEstimateRead,
} from './envCheckpoints.js';
import { fingerprintOf, type EnvFileResolved, type EnvFileResource } from './envFile.js';
import {
  drawnCountsOf,
  dryRunCountOf,
  targetRefusalOf,
  notesOf,
  type EnvDryRunAnswer,
  type EnvPreviewAnswer,
} from './envKinds.js';
import type { EnvDryRunCount } from './kinds/common.js';
import {
  DATAOPS_SCRIPT,
  MASK_STATUS_WHY,
  maskDeleteWhy,
  maskDriftWhy,
  maskHeldOf,
  maskKeptWhy,
  maskReplaceWords,
  type MaskPlace,
} from './kinds/mask.js';

/**
 * What a resource's own verification of its last run found, where its kind
 * has one a plan reads (a frozen resource's): the objects it FAILED, each
 * named; or why it could not say.
 */
export type EnvRefreshed = { failed: string[] } | { unread: string };

/** What a removal preview of one run of a resource said, or why it said nothing. */
export type EnvRunPreview =
  | { n: number; preview: EnvPreviewAnswer; refreshed?: EnvRefreshed }
  /** The run left nothing to take back from: no summary, no run file, so it wrote nothing. */
  | { n: number; nothing: true }
  | { n: number; failed: string };

/** A resource's dry run, through its own script, or why it did not answer. */
export type EnvDryRun = { answer: EnvDryRunAnswer } | { failed: string };

/** What the target has left today, read once from its `/limits`. */
export interface EnvBudget {
  apiRequests: { remaining: number; max: number } | { unread: string };
  storage: { remainingMB: number; maxMB: number } | { unread: string };
  emails: Partial<Record<EnvEmailLimit, { remaining: number; max: number }>> | { unread: string };
}

/** What a plan is made from. */
export interface EnvPlanInput {
  resolved: EnvFileResolved;
  org: EnvPlan['org'];
  state: EnvState | undefined;
  /** Each applied resource's runs, previewed; absent with `--quick`. */
  previews?: Readonly<Record<string, readonly EnvRunPreview[]>>;
  /** Each resource to create or replace, dry-run; absent with `--quick`. */
  dryRuns?: Readonly<Record<string, EnvDryRun>>;
  /** Absent with `--quick`. */
  budget?: EnvBudget;
  /** Each mask resource's DataOps store, from the root: where its plan says its snapshots are. */
  maskStores?: Readonly<Record<string, string>>;
  /** Resources the line asks to replace (`--replace`). */
  replace?: readonly string[];
  /** Replace every drifted resource (`--replace-drifted`). */
  replaceDrifted?: boolean;
  /** What a real apply would meet now, a guard's: no state without `--accept-no-state`. */
  refusal?: string;
  warnings?: readonly string[];
  /** What the checkpoint script estimates a take costs, when the apply takes one; absent with `--quick`. */
  checkpointEstimate?: CheckpointEstimateRead;
  /** The whole org against the checkpoint taken after the last apply; absent with `--quick`. */
  drift?: EnvPlanDrift;
  /**
   * Of each seed resource whose relations draw their parents from another
   * resource's records: what each draw is handed, and why one cannot be.
   */
  draws?: Readonly<Record<string, { draws: EnvActionDraw[]; refusals: string[] }>>;
}

/** A resource's action before its dry run and the gates are read. */
export interface EnvActionDraft {
  resource: string;
  kind: EnvResourceKind;
  action: Exclude<EnvActionKind, 'blocked'>;
  why: string;
  objects: EnvPlanObject[];
  /** What refuses it already: its removal's preview. */
  refusal?: string;
}

const WRITES: ReadonlySet<EnvActionKind> = new Set(['create', 'replace', 'delete']);
const RUNS: ReadonlySet<EnvActionKind> = new Set(['create', 'replace']);

/** Whether an action writes to the org: it runs a script, or takes a run back. */
export function writes(action: Pick<EnvAction, 'action'>): boolean {
  return WRITES.has(action.action);
}

/**
 * The resources a state holds that are still the org's: every one but those a
 * destroy took back whole.
 */
export function liveResources(state: EnvState | undefined): Array<[string, EnvResourceState]> {
  return Object.entries(state?.resources ?? {}).filter(
    ([, resource]) => resource.status !== 'destroyed',
  );
}

/**
 * Names in an order where each comes after those it depends on, ties in the
 * order given; a dependency on a name not given is passed over.
 */
export function dependencyOrder(
  names: readonly string[],
  dependsOn: (name: string) => readonly string[],
): string[] {
  const order: string[] = [];
  const placed = new Set<string>();
  const given = new Set(names);
  while (order.length < names.length) {
    const next =
      names.find(
        (name) =>
          !placed.has(name) &&
          dependsOn(name).every((dep) => !given.has(dep) || placed.has(dep) || dep === name),
      ) ?? names.find((name) => !placed.has(name));
    // A circle a state could only hold if written by hand: taken in the order given.
    if (next === undefined) break;
    order.push(next);
    placed.add(next);
  }
  return order;
}

/**
 * The order the runs of a state's resources are taken back in: each before
 * those it depended on when it was applied, the last applied first. The
 * removal keeps a record while records that stay hang from it: taking the
 * accounts back before the contacts under them would keep every account.
 */
export function removalOrder(state: EnvState | undefined, names: readonly string[]): string[] {
  const resources = state?.resources ?? {};
  return dependencyOrder(names, (name) => resources[name]?.dependsOn ?? []).reverse();
}

/**
 * Whether the org holds a resource as applied though records of it were
 * written since: they are only changed — none gone, none unread — and the
 * whole org holds what the checkpoint taken after the apply holds. A rewind
 * to it gives records their values back and dates them; a removal reads the
 * date alone.
 */
function heldAsApplied(held: Held, drift: EnvPlanDrift | undefined): boolean {
  if (drift === undefined || drift.differs || drift.unread !== undefined) return false;
  return [...held.objects.values()].every((counts) => counts.gone === 0 && counts.unread === 0);
}

/** What a resource's record counts come to across its runs' previews. */
interface Held {
  objects: Map<string, { present: number; gone: number; changed: number; unread: number }>;
  changedBy: Map<string, number>;
  refusals: string[];
  failed: string[];
  /** What its verification FAILED, each object named. */
  verified: string[];
}

function heldOf(previews: readonly EnvRunPreview[]): Held {
  const held: Held = {
    objects: new Map(),
    changedBy: new Map(),
    refusals: [],
    failed: [],
    verified: [],
  };
  for (const run of previews) {
    if ('failed' in run) {
      held.failed.push(`run ${run.n}: ${run.failed}`);
      continue;
    }
    if ('nothing' in run) continue;
    const refreshed = run.refreshed;
    if (refreshed !== undefined && 'unread' in refreshed) {
      held.failed.push(`run ${run.n}: its verification did not say (${refreshed.unread})`);
    } else if (refreshed !== undefined) {
      held.verified.push(...refreshed.failed);
    }
    const { preview } = run.preview;
    for (const object of preview.objects) {
      const counts = held.objects.get(object.objectApiName) ?? {
        present: 0,
        gone: 0,
        changed: 0,
        unread: 0,
      };
      counts.present += object.toDelete + object.keptChanged + object.undeletable;
      counts.gone += object.alreadyGone + object.notVisible;
      counts.changed += object.changedSince;
      counts.unread += object.unread;
      held.objects.set(object.objectApiName, counts);
      for (const [userId, n] of Object.entries(object.changedBy)) {
        const name = preview.userNames[userId] ?? userId;
        held.changedBy.set(name, (held.changedBy.get(name) ?? 0) + n);
      }
    }
    for (const refusal of run.preview.refusals) {
      if (!held.refusals.includes(refusal)) held.refusals.push(refusal);
    }
  }
  return held;
}

function heldObjects(held: Held): EnvPlanObject[] {
  return [...held.objects].map(([object, counts]) => ({
    object,
    present: counts.present,
    gone: counts.gone,
    changed: counts.changed,
  }));
}

/** What drifted of a resource, in words, or nothing when the org holds it as written. */
function driftOf(held: Held): string | undefined {
  const parts = [...held.objects].flatMap(([object, counts]) => {
    const said = [
      counts.gone > 0 ? `${counts.gone} gone` : '',
      counts.changed > 0 ? `${counts.changed} changed` : '',
      counts.unread > 0 ? `${counts.unread} not read` : '',
    ].filter(Boolean);
    return said.length > 0 ? [`${object} ${said.join(', ')}`] : [];
  });
  if (held.verified.length > 0) parts.push(`its verification: ${held.verified.join('; ')}`);
  if (parts.length === 0) return undefined;
  const by = [...held.changedBy].sort((a, b) => b[1] - a[1]);
  const who =
    by.length > 0 ? ` (last changed by ${by.map(([name, n]) => `${name} ${n}`).join(', ')})` : '';
  return `${parts.join('; ')}${who}`;
}

/** Why a resource's last run calls for a replace, from its status. */
const STATUS_WHY: Readonly<Partial<Record<EnvResourceState['status'], string>>> = {
  applying:
    'its last run was stopped part way: what it wrote is taken back from its run file, then it runs again',
  partial: 'its last run was partial: the org refused records of it, or kept some of its records',
  failed: 'its last run failed',
  destroying: 'a removal of it was stopped part way',
};

/**
 * Why a resource cannot be planned, before anything of the org is read: a
 * forge resource whose source the plan did not read, or could not — its
 * fingerprint is of the org its alias reaches and the record its query names;
 * a frozen resource whose dataset the plan did not read, or is not the one
 * the file pins.
 */
function sourceRefusal(resource: EnvFileResource): string | undefined {
  if (resource.kind === 'frozen') {
    const read = resource.dataset.read;
    if (read === undefined)
      return `its dataset at ${resource.dataset.dir} was not read: plan again`;
    return 'refusal' in read ? read.refusal : undefined;
  }
  if (resource.kind !== 'forge') return undefined;
  const read = resource.source.read;
  if (read === undefined) {
    return `its source, the ${resource.source.role} org, was not read: plan again`;
  }
  return 'refusal' in read ? read.refusal : undefined;
}

/**
 * Each resource's action before its dry run is read: the file against the
 * state and what the org holds of it. In the order the plan lists them:
 * what is taken back first, the last applied first; then the file's
 * resources in the order apply runs them.
 */
export function classifyResources(
  input: Pick<
    EnvPlanInput,
    | 'resolved'
    | 'state'
    | 'previews'
    | 'replace'
    | 'replaceDrifted'
    | 'drift'
    | 'dryRuns'
    | 'maskStores'
  > &
    Partial<Pick<EnvPlanInput, 'org'>>,
): EnvActionDraft[] {
  const { resolved, state, previews } = input;
  const quick = previews === undefined;
  const asked = new Set(input.replace ?? []);
  const live = new Map(liveResources(state));
  const inFile = new Set(resolved.resources.map((resource) => resource.name));
  const actions = new Map<string, EnvActionDraft>();

  for (const resource of resolved.resources) {
    const kept = live.get(resource.name);
    const unread = sourceRefusal(resource);
    const kind = resource.kind;
    if (kept === undefined) {
      actions.set(resource.name, {
        resource: resource.name,
        kind,
        action: 'create',
        why:
          state?.resources[resource.name]?.status === 'destroyed'
            ? 'taken back by an earlier destroy: applied again'
            : 'not applied to this org yet',
        objects: [],
        ...(unread !== undefined ? { refusal: unread } : {}),
      });
      continue;
    }
    const held = heldOf(previews?.[resource.name] ?? []);
    const reasons: string[] = [];
    // A fingerprint is chained through what the resource depends on: one it
    // depends on changed moves it too. Said as its own change, a resource
    // the file left as it was read "what it writes changed in the file".
    const asIfDepsKept = fingerprintOf(
      resource,
      Object.fromEntries(
        resource.dependsOn.map((dep) => [dep, state?.resources[dep]?.fingerprint]),
      ),
    );
    if (kept.fingerprint !== resource.fingerprint && kept.fingerprint !== asIfDepsKept) {
      reasons.push('what it writes changed in the file since it was applied');
    }
    const statusWhy = (kind === 'mask' ? MASK_STATUS_WHY : STATUS_WHY)[kept.status];
    if (statusWhy !== undefined) reasons.push(statusWhy);
    // A masking run again writes over the same records, and makes no new one.
    const changedDeps = resource.dependsOn.filter((dep) => {
      const action = actions.get(dep);
      return action !== undefined && RUNS.has(action.action) && action.kind !== 'mask';
    });
    if (changedDeps.length > 0) {
      reasons.push(
        `the resources it depends on run again, with new records: ${changedDeps.join(', ')}`,
      );
    }
    if (asked.has(resource.name)) reasons.push('--replace asks it');
    if (kind === 'mask') {
      actions.set(resource.name, maskDraft(resource.name, kept, reasons, input, quick));
      continue;
    }
    const seen = quick ? undefined : driftOf(held);
    const given = seen !== undefined && heldAsApplied(held, input.drift);
    const drift = given ? undefined : seen;
    if (reasons.length === 0 && drift !== undefined && input.replaceDrifted === true) {
      reasons.push(`its records drifted (${drift}), and --replace-drifted asks it`);
    }
    const objects = heldObjects(held);
    const refusal =
      unread ??
      (held.refusals.length > 0
        ? `a removal of its runs would be refused now: ${held.refusals.join(' ')}`
        : held.failed.length > 0
          ? `what the org holds of it could not be read (${held.failed.join('; ')}): plan again`
          : undefined);
    if (reasons.length > 0) {
      actions.set(resource.name, {
        resource: resource.name,
        kind,
        action: 'replace',
        why: `replaced: ${reasons.join('; ')}`,
        objects,
        ...(refusal !== undefined ? { refusal } : {}),
      });
    } else if (quick) {
      actions.set(resource.name, {
        resource: resource.name,
        kind,
        action: 'keep',
        why: 'applied from the same file; what the org holds of it was not read (--quick)',
        objects,
        ...(unread !== undefined ? { refusal: unread } : {}),
      });
    } else if (unread !== undefined || held.failed.length > 0) {
      actions.set(resource.name, {
        resource: resource.name,
        kind,
        action: 'keep',
        why: 'applied from the same file',
        objects,
        refusal:
          unread ??
          `what the org holds of it could not be read (${held.failed.join('; ')}): plan again`,
      });
    } else if (drift !== undefined) {
      actions.set(resource.name, {
        resource: resource.name,
        kind,
        action: 'drifted',
        why:
          `its records changed since it was applied: ${drift}. Left as they are: ` +
          `--replace ${resource.name} or --replace-drifted replaces it`,
        objects,
      });
    } else {
      const records = objects.reduce((sum, object) => sum + (object.present ?? 0), 0);
      const since = objects.reduce((sum, object) => sum + (object.changed ?? 0), 0);
      actions.set(resource.name, {
        resource: resource.name,
        kind,
        action: 'keep',
        why: given
          ? `applied, and the org holds its ${records} record(s) as the checkpoint taken after ` +
            `the apply holds them: ${since} written since hold their values again, as a reset ` +
            'gives them back'
          : `applied, and the org holds its ${records} record(s) as written`,
        objects,
      });
    }
  }

  const deletes = removalOrder(
    state,
    [...live.keys()].filter((name) => !inFile.has(name)),
  ).map((name): EnvActionDraft => {
    const kept = live.get(name);
    if (kept?.kind === 'mask') {
      return {
        resource: name,
        kind: 'mask',
        action: 'delete',
        why: maskDeleteWhy('apply', name, kept, maskPlaceOf(input, name)),
        objects: maskKeptObjects(kept),
      };
    }
    const held = heldOf(previews?.[name] ?? []);
    const refusal =
      held.refusals.length > 0
        ? `a removal of its runs would be refused now: ${held.refusals.join(' ')}`
        : held.failed.length > 0
          ? `what the org holds of it could not be read (${held.failed.join('; ')}): plan again`
          : undefined;
    return {
      resource: name,
      kind: live.get(name)?.kind ?? 'seed',
      action: 'delete',
      why: 'in the state, gone from the file: its records are taken back',
      objects: heldObjects(held),
      ...(refusal !== undefined ? { refusal } : {}),
    };
  });
  return [...deletes, ...resolved.resources.flatMap((r) => actions.get(r.name) ?? [])];
}

/**
 * A mask resource's action, from what it runs again for: replaced for its
 * reasons, masking again; or, for none, kept or drifted as its own dry run
 * reads what the org holds of it — the records its condition selects now,
 * against those it masked. Drafted before its dry run, it is kept, and
 * drafted again once the dry run has read the org.
 */
function maskDraft(
  name: string,
  kept: EnvResourceState,
  reasons: readonly string[],
  input: Pick<EnvPlanInput, 'dryRuns' | 'replaceDrifted'>,
  quick: boolean,
): EnvActionDraft {
  const draft = (
    action: EnvActionDraft['action'],
    why: string,
    objects: EnvPlanObject[] = [],
    refusal?: string,
  ): EnvActionDraft => ({
    resource: name,
    kind: 'mask',
    action,
    why,
    objects,
    ...(refusal !== undefined ? { refusal } : {}),
  });
  if (reasons.length > 0) {
    return draft('replace', `replaced: ${reasons.join('; ')}; ${maskReplaceWords(kept)}`);
  }
  if (quick) {
    return draft(
      'keep',
      'applied from the same file; what the org holds of it was not read (--quick)',
    );
  }
  if (input.dryRuns === undefined) return draft('keep', 'applied from the same file');
  const dry = input.dryRuns[name];
  if (dry === undefined) {
    return draft('keep', 'applied from the same file', [], 'it was not dry-run: plan again');
  }
  if ('failed' in dry || dry.answer.tool !== DATAOPS_SCRIPT) {
    const said = 'failed' in dry ? dry.failed : `${dry.answer.tool} answered its dry run`;
    return draft(
      'keep',
      'applied from the same file',
      [],
      `what the org holds of it could not be read (its dry run: ${said}): plan again`,
    );
  }
  const held = maskHeldOf(kept, dry.answer);
  if (held.unread !== undefined) {
    return draft(
      'keep',
      'applied from the same file',
      held.objects,
      `what the org holds of it could not be read: ${held.unread}`,
    );
  }
  if (held.drift === undefined) return draft('keep', maskKeptWhy(held.masked), held.objects);
  if (input.replaceDrifted === true) {
    return draft(
      'replace',
      `replaced: its condition selects other records than it masked (${held.drift}), and ` +
        `--replace-drifted asks it; ${maskReplaceWords(kept)}`,
      held.objects,
    );
  }
  return draft('drifted', maskDriftWhy(name, held.drift), held.objects);
}

/** Where a plan says a mask resource's store is, and the org a restore of it would name. */
function maskPlaceOf(
  input: Pick<EnvPlanInput, 'maskStores' | 'state'> & Partial<Pick<EnvPlanInput, 'org'>>,
  name: string,
): MaskPlace {
  const store = input.maskStores?.[name];
  const org = input.org ?? input.state?.org;
  return {
    alias: org?.alias ?? org?.organizationId ?? '<alias>',
    ...(store !== undefined ? { store } : {}),
  };
}

/** What a mask resource's last run masked, per object: what stays masked whatever a destroy does. */
function maskKeptObjects(kept: Pick<EnvResourceState, 'runs'>): EnvPlanObject[] {
  return (kept.runs.at(-1)?.objects ?? []).map((object) => ({
    object: object.objectApiName,
    present: object.masked ?? 0,
  }));
}

/**
 * The resources each resource depends on that run in the same apply before
 * it: its dry run read the org before they wrote, so what it draws from
 * their records — the existing parents of a relation — it could not count.
 * A masking writes over records the org holds, and creates none.
 */
export function readBefore(
  resolved: EnvFileResolved,
  drafts: ReadonlyArray<Pick<EnvActionDraft, 'resource' | 'action' | 'kind'>>,
): Map<string, string[]> {
  const running = new Set(drafts.filter((d) => RUNS.has(d.action)).map((d) => d.resource));
  const writing = new Set(
    drafts.filter((d) => RUNS.has(d.action) && d.kind !== 'mask').map((d) => d.resource),
  );
  const out = new Map<string, string[]>();
  for (const resource of resolved.resources) {
    if (!running.has(resource.name)) continue;
    const before = resource.dependsOn.filter((dep) => writing.has(dep));
    if (before.length > 0) out.set(resource.name, before);
  }
  return out;
}

/** Add the counts of a dry run to an action's objects, by object. */
function withWouldCreate(objects: EnvPlanObject[], count: EnvDryRunCount): EnvPlanObject[] {
  const merged = objects.map((object) => ({ ...object }));
  for (const counted of count.objects) {
    const said = {
      wouldCreate: counted.wouldCreate,
      ...(counted.atMost === true ? { atMost: true as const } : {}),
    };
    const at = merged.find((object) => object.object === counted.object);
    if (at) Object.assign(at, said);
    else merged.push({ object: counted.object, ...said });
  }
  return merged;
}

/**
 * What a dry run counted, read as its kind reads it. A seed relation may draw
 * existing parents from what the resources it depends on write first in the
 * same apply: its dry run read the org before they did, and counted none of
 * those, which the file's count then stands in for, as the most it writes.
 */
function countOf(
  resolved: EnvFileResolved,
  name: string,
  answer: EnvDryRunAnswer,
  readTooEarly: boolean,
): { count: EnvDryRunCount } {
  const resource = resolved.resources.find((each) => each.name === name);
  const drawn = readTooEarly && resource !== undefined ? drawnCountsOf(resource) : undefined;
  const count = dryRunCountOf(answer, drawn);
  const target = resource !== undefined ? targetRefusalOf(resource, answer) : undefined;
  return {
    count:
      target !== undefined && count.refusal === undefined ? { ...count, refusal: target } : count,
  };
}

/** Whether a resource's records hang from records the org holds before its run. */
function drawsFromEarlier(resolved: EnvFileResolved, name: string): boolean {
  const resource = resolved.resources.find((each) => each.name === name);
  return resource !== undefined && (drawnCountsOf(resource)?.size ?? 0) > 0;
}

/** The resources of `deps` a seed resource's relations draw their parents from. */
function drawnFromAmong(
  resolved: EnvFileResolved,
  name: string,
  deps: readonly string[],
): string[] {
  const resource = resolved.resources.find((each) => each.name === name);
  if (resource?.kind !== 'seed') return [];
  const from = new Set((resource.run.draws ?? []).map((draw) => draw.from));
  return deps.filter((dep) => from.has(dep));
}

/**
 * What a dry run counted that a run is held to: its records in all, as its
 * kind counts them. A forge run is given it as its `--max-total`, so a
 * scope that widened since its dry run is refused before its first write.
 */
export function dryRunTotalOf(dry: EnvDryRun | undefined): number | undefined {
  return dry !== undefined && 'answer' in dry ? dryRunCountOf(dry.answer).total : undefined;
}

/** What the summed gates refuse, each in its own words, against what the target has left. */
function summedRefusals(gates: EnvPlan['gates'], alias: string): string[] {
  const refusals: string[] = [];
  const { apiRequests, storage, emails } = gates;
  if (apiRequests.leftToday !== undefined && apiRequests.estimate > apiRequests.leftToday) {
    refusals.push(
      `The resources the plan writes take about ${apiRequests.estimate} API requests, and ` +
        `${alias} has ${apiRequests.leftToday} left today: the apply would stop part way. ` +
        'Apply once the org has requests to spare — the limit is counted over the last 24 ' +
        'hours — or write fewer records.',
    );
  }
  if (storage.left !== undefined && storage.bytes > storage.left) {
    refusals.push(
      `The resources the plan writes take about ${formatMB(storage.bytes / BYTES_PER_MB)} MB ` +
        `of data storage, and ${alias} has ${formatMB(storage.left / BYTES_PER_MB)} MB left: ` +
        'the org would refuse records part way. Write fewer records, or free storage first.',
    );
  }
  for (const limit of emails) {
    if (limit.left !== undefined && limit.emails > limit.left) {
      refusals.push(
        `The resources the plan writes make ${alias} send ${limit.emails} ${limit.limit} ` +
          `emails, and it has ${limit.left} left today: each resource alone may fit, the day ` +
          'does not. Apply the resources over two days, or keep the automation that sends ' +
          'them quiet.',
      );
    }
  }
  return refusals;
}

/**
 * The day's budget, summed across the resources the plan writes, each by
 * the action it was drafted with: a resource blocked still counts what it
 * would write. A removal's requests are not estimated, and are said to be
 * left out.
 */
function sumGates(
  drafts: readonly EnvActionDraft[],
  dryRuns: EnvPlanInput['dryRuns'],
  budget: EnvBudget | undefined,
  before: ReadonlyMap<string, string[]>,
  checkpoints: ReturnType<typeof checkpointRequestsOf>,
): EnvPlan['gates'] {
  // A checkpoint's take reads every record of the org: its requests are the day's too.
  let estimate = checkpoints.estimate;
  let bytes = 0;
  const emails = new Map<EnvEmailLimit, number>();
  const notCounted: string[] = [...checkpoints.notCounted];
  for (const draft of drafts) {
    // A masking is never taken back: its replace runs again, and its delete
    // deletes its store, on this machine.
    if ((draft.action === 'delete' || draft.action === 'replace') && draft.kind !== 'mask') {
      notCounted.push(`the removal of the runs of ${draft.resource}`);
    }
    if (!RUNS.has(draft.action)) continue;
    const dry = dryRuns?.[draft.resource];
    if (dry === undefined || 'failed' in dry) {
      notCounted.push(`the run of ${draft.resource}, not dry-run`);
      continue;
    }
    const deps = before.get(draft.resource);
    if (deps !== undefined && draft.kind !== 'mask') {
      notCounted.push(
        `what ${draft.resource} draws from the records ${deps.join(', ')} writes first`,
      );
    }
    const count = dryRunCountOf(dry.answer);
    if (count.apiRequests === undefined) {
      notCounted.push(
        `the requests of the run of ${draft.resource}, which its script does not estimate`,
      );
    } else {
      estimate += count.apiRequests;
    }
    bytes += count.storageBytes;
    for (const { limit, emails: n } of count.emails) {
      emails.set(limit, (emails.get(limit) ?? 0) + n);
    }
  }
  const api = budget?.apiRequests;
  const storage = budget?.storage;
  const mail = budget?.emails;
  return {
    apiRequests: {
      estimate,
      ...(api !== undefined && !('unread' in api) ? { leftToday: api.remaining } : {}),
      partial: notCounted.length > 0,
      ...(notCounted.length > 0 ? { notCounted } : {}),
      ...(api !== undefined && 'unread' in api ? { unread: api.unread } : {}),
      ...(budget === undefined ? { unread: 'not read: --quick' } : {}),
    },
    storage: {
      bytes,
      ...(storage !== undefined && !('unread' in storage)
        ? { left: Math.floor(storage.remainingMB * BYTES_PER_MB) }
        : {}),
      ...(storage !== undefined && 'unread' in storage ? { unread: storage.unread } : {}),
      ...(budget === undefined ? { unread: 'not read: --quick' } : {}),
    },
    emails: [...emails].map(([limit, n]) => {
      const left = mail !== undefined && !('unread' in mail) ? mail[limit]?.remaining : undefined;
      return { limit, emails: n, ...(left !== undefined ? { left } : {}) };
    }),
  };
}

/**
 * What applying the file to the org would do, from what the command line
 * read: see the module's comment. Writes nothing.
 */
export function envPlan(input: EnvPlanInput): EnvPlan {
  const quick = input.previews === undefined;
  const drafts = classifyResources(input);
  const before = readBefore(input.resolved, drafts);
  const actions: EnvAction[] = drafts.map((draft) => {
    let objects = draft.objects;
    let gates: EnvActionGates | undefined;
    let refusal = draft.refusal;
    const dry = RUNS.has(draft.action) ? input.dryRuns?.[draft.resource] : undefined;
    // A relation of it may draw existing parents from what they write: its
    // dry run read the org before they did, and counted none of those.
    const deps = before.get(draft.resource);
    const drawn = deps !== undefined && drawsFromEarlier(input.resolved, draft.resource);
    const draws = RUNS.has(draft.action) ? input.draws?.[draft.resource] : undefined;
    if (draws !== undefined && draws.refusals.length > 0) {
      refusal ??= draws.refusals.join(' ');
    }
    let dryNotes: string[] = [];
    if (dry !== undefined && 'failed' in dry) {
      refusal ??= `its dry run did not answer: ${dry.failed}`;
    } else if (dry !== undefined) {
      const counted = countOf(input.resolved, draft.resource, dry.answer, deps !== undefined);
      objects = withWouldCreate(objects, counted.count);
      gates = {
        ...(counted.count.apiRequests !== undefined
          ? { apiRequests: counted.count.apiRequests }
          : {}),
        storageBytes: counted.count.storageBytes,
        emails: counted.count.emails,
      };
      const own = counted.count.refusal;
      if (own !== undefined) refusal ??= `its own dry run says a real run would be refused: ${own}`;
      dryNotes = counted.count.notes ?? [];
    } else if (RUNS.has(draft.action) && !quick) {
      refusal ??= 'it was not dry-run: plan again';
    }
    // The resources it draws its parents from by their ids, among those that
    // run first: nobody knows their records before they run.
    const unknown = deps !== undefined ? drawnFromAmong(input.resolved, draft.resource, deps) : [];
    const counted =
      deps !== undefined && dry !== undefined && draft.kind === 'mask'
        ? `; its dry run read the org before ${deps.join(', ')} writes: what they write under ` +
          'its condition it masks too, uncounted here'
        : deps !== undefined && dry !== undefined && drawn
          ? unknown.length > 0
            ? `; it draws its parents from the records ${unknown.join(', ')} creates in this ` +
              'apply, which nobody knows before it runs: counted at most as the file gives it'
            : `; its dry run read the org before ${deps.join(', ')} writes: what it draws from ` +
              'those records is counted at most as the file gives it'
          : '';
    // What its own dry run says of the load (encrypted fields, rewritten
    // picklists) goes with why; what the file asks of its data (real data
    // from production, a masking one-way) on lines of its own.
    const why = `${draft.why}${counted}${dryNotes.length > 0 ? `; ${dryNotes.join('; ')}` : ''}`;
    const resource = input.resolved.resources.find((each) => each.name === draft.resource);
    const notes =
      resource !== undefined && RUNS.has(draft.action)
        ? notesOf(resource, maskPlaceOf(input, draft.resource))
        : [];
    return {
      resource: draft.resource,
      kind: draft.kind,
      action: refusal !== undefined ? 'blocked' : draft.action,
      why,
      objects,
      ...(draws !== undefined && draws.draws.length > 0 ? { draws: draws.draws } : {}),
      ...(gates !== undefined ? { gates } : {}),
      ...(refusal !== undefined ? { refusal } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
  });

  const file = input.resolved.checked.file;
  const checkpoints = planCheckpointsOf(
    checkpointStepsOf(
      file,
      input.state,
      drafts.some((draft) => WRITES.has(draft.action)),
    ),
    quick ? undefined : (input.checkpointEstimate ?? { unread: 'not estimated' }),
    // What a masking writes over is in the org already, and in the take's estimate.
    actions
      .filter((action) => RUNS.has(action.action) && action.kind !== 'mask')
      .flatMap((action) => action.objects)
      .reduce((sum, object) => sum + (object.wouldCreate ?? 0), 0),
  );
  const gates = sumGates(
    drafts,
    input.dryRuns,
    input.budget,
    before,
    checkpointRequestsOf(checkpoints),
  );
  const alias = input.org.alias ?? input.org.organizationId;
  const summed = summedRefusals(gates, alias);
  if (summed.length > 0) {
    for (const action of actions) {
      if (!writes(action)) continue;
      action.refusal = summed.join(' ');
      action.action = 'blocked';
    }
  }

  const blocked = actions.filter((action) => action.action === 'blocked');
  const refusal =
    input.refusal ??
    (summed.length > 0
      ? `${summed.join(' ')} Nothing was written.`
      : blocked.length > 0
        ? `${blocked.length === 1 ? 'A resource is' : `${blocked.length} resources are`} ` +
          `blocked, and the apply refuses before its first write: ` +
          `${blocked.map((action) => `${action.resource} (${action.refusal ?? action.why})`).join('; ')}`
        : undefined) ??
    checkpointRefusalOf(checkpoints);
  // A Frozen load's dry run counts no email: the day's email gate holds
  // without what its records make the org send. Live, a load of 73 contacts
  // into a Developer Edition of 15 single emails a day was let through,
  // said nothing of.
  const loads = actions
    .filter((action) => action.kind === 'frozen' && RUNS.has(action.action))
    .map((action) => action.resource);
  // Nor does a masking's: an update of every contact can send as many.
  const masks = actions
    .filter((action) => action.kind === 'mask' && RUNS.has(action.action))
    .map((action) => action.resource);
  const warnings = [
    ...(input.warnings ?? []),
    ...checkpointWarningsOf(file, input.state),
    ...(loads.length > 0
      ? [
          `the emails the org sends as ${loads.join(', ')} ${loads.length === 1 ? 'loads' : 'load'} ` +
            'are not counted: a Frozen load’s dry run does not count them, and the day’s email ' +
            'gate holds without them',
        ]
      : []),
    ...(masks.length > 0
      ? [
          `the emails the org sends as ${masks.join(', ')} ${masks.length === 1 ? 'masks' : 'mask'} ` +
            'are not counted: a masking’s dry run does not count them, and the day’s email gate ' +
            'holds without them',
        ]
      : []),
  ];

  const count = (kind: EnvActionKind): number =>
    actions.filter((action) => action.action === kind).length;
  const state = input.state;
  return {
    env: input.resolved.checked.file.name,
    org: input.org,
    state: state !== undefined ? { found: true, serial: state.serial } : { found: false },
    actions,
    totals: {
      create: count('create'),
      keep: count('keep'),
      replace: count('replace'),
      delete: count('delete'),
      drifted: count('drifted'),
      blocked: count('blocked'),
    },
    gates,
    ...(checkpoints.length > 0 ? { checkpoints } : {}),
    ...(input.drift !== undefined ? { drift: input.drift } : {}),
    ...(refusal !== undefined ? { refusal } : {}),
    ...(quick ? { quick: true as const } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * What a destroy would take back: every resource the state holds, the last
 * applied first, each with what the org holds of it, as its runs' previews
 * read it with the destroy's own switches. A resource whose removal a
 * preview says would be refused now is blocked, and the destroy with it,
 * before its first delete: taken back part way, the resources before it
 * would be gone and its own records would keep theirs.
 */
export function destructionPlan(
  input: Pick<EnvPlanInput, 'resolved' | 'org' | 'state' | 'previews' | 'warnings' | 'maskStores'>,
): EnvPlan {
  const names = removalOrder(
    input.state,
    liveResources(input.state).map(([name]) => name),
  );
  const actions: EnvAction[] = names.map((name) => {
    const kept = input.state?.resources[name];
    // Never unmasked: its store goes, and its records stay as they are.
    if (kept?.kind === 'mask') {
      return {
        resource: name,
        kind: 'mask',
        action: 'delete',
        why: maskDeleteWhy('destroy', name, kept, maskPlaceOf(input, name)),
        objects: maskKeptObjects(kept),
      };
    }
    const held = heldOf(input.previews?.[name] ?? []);
    const refusal =
      held.refusals.length > 0
        ? `a removal of its runs would be refused now: ${held.refusals.join(' ')}`
        : held.failed.length > 0
          ? `what the org holds of it could not be read (${held.failed.join('; ')}): run destroy again`
          : undefined;
    return {
      resource: name,
      kind: kept?.kind ?? 'seed',
      action: refusal !== undefined ? 'blocked' : 'delete',
      why: 'taken back by destroy, into the recycle bin',
      objects: heldObjects(held),
      ...(refusal !== undefined ? { refusal } : {}),
    };
  });
  const blocked = actions.filter((action) => action.action === 'blocked');
  const removals = actions
    .filter((action) => action.kind !== 'mask')
    .map((action) => `the removal of the runs of ${action.resource}`);
  const state = input.state;
  return {
    env: input.resolved.checked.file.name,
    org: input.org,
    state: state !== undefined ? { found: true, serial: state.serial } : { found: false },
    actions,
    totals: {
      create: 0,
      keep: 0,
      replace: 0,
      delete: actions.length - blocked.length,
      drifted: 0,
      blocked: blocked.length,
    },
    gates: {
      apiRequests: {
        estimate: 0,
        partial: removals.length > 0,
        ...(removals.length > 0 ? { notCounted: removals } : {}),
      },
      storage: { bytes: 0 },
      emails: [],
    },
    ...(blocked.length > 0
      ? {
          refusal:
            `${blocked.map((action) => `${action.resource}: ${action.refusal ?? ''}`).join(' ')} ` +
            'Nothing was deleted.',
        }
      : {}),
    ...(input.previews === undefined ? { quick: true as const } : {}),
    ...(input.warnings !== undefined && input.warnings.length > 0
      ? { warnings: [...input.warnings] }
      : {}),
  };
}

/** Whether the plan would write or delete anything: what `--fail-on-change` exits 3 on. */
export function planChanges(plan: Pick<EnvPlan, 'actions'>): boolean {
  return plan.actions.some((action) => action.action !== 'keep' && action.action !== 'drifted');
}

/**
 * Whether the org no longer holds the environment as applied: what
 * `--fail-on-drift` exits 3 on. With a checkpoint taken after the last apply,
 * the whole org is held to it, and one that could not be compared with it is
 * not taken for one that holds it; records a reset gave back their values
 * are kept, as their resource is.
 */
export function planDrifts(plan: Pick<EnvPlan, 'actions' | 'drift'>): boolean {
  const drift = plan.drift;
  if (drift !== undefined && (drift.differs || drift.unread !== undefined)) return true;
  // The whole org holds what the checkpoint after the apply holds: so does what it keeps.
  const asApplied = drift !== undefined;
  return plan.actions.some(
    (action) =>
      action.action === 'drifted' ||
      (!(asApplied && action.action === 'keep') &&
        action.objects.some((object) => (object.gone ?? 0) > 0 || (object.changed ?? 0) > 0)),
  );
}

/** The plan as a terminal shows it. */
export function planLines(plan: EnvPlan): string[] {
  const lines = [
    `plan of ${plan.env} on ${plan.org.alias ?? plan.org.organizationId} ` +
      `(${plan.org.kind}, ${plan.org.organizationId})`,
    plan.state.found
      ? `state: kept on this machine, serial ${plan.state.serial ?? 0}`
      : 'state: none on this machine',
  ];
  for (const action of plan.actions) {
    // A masking writes over records the org holds: what it masks, and holds masked.
    const masks = action.kind === 'mask';
    const counts = action.objects
      .map((object) => {
        const parts = [
          object.wouldCreate !== undefined
            ? `${object.atMost === true ? 'at most ' : ''}${object.wouldCreate} ` +
              (masks ? 'to mask' : 'to write')
            : '',
          object.present !== undefined && object.present > 0
            ? `${object.present} ${masks ? 'masked' : 'in the org'}`
            : '',
          (object.gone ?? 0) > 0 ? `${object.gone} gone` : '',
          (object.changed ?? 0) > 0 ? `${object.changed} changed` : '',
        ].filter(Boolean);
        return parts.length > 0 ? `${object.object} ${parts.join(', ')}` : '';
      })
      .filter(Boolean)
      .join('; ');
    lines.push(`  ${action.action.padEnd(8)} ${action.resource}${counts ? `  ${counts}` : ''}`);
    lines.push(`           ${action.why}`);
    for (const draw of action.draws ?? []) {
      lines.push(
        `           ${draw.lookup} draws its parents from ` +
          (draw.parents !== undefined
            ? `the ${draw.parents} ${draw.object} record(s) ${draw.from} created`
            : `the ${draw.object} records ${draw.from} creates first`),
      );
    }
    for (const note of action.notes ?? []) lines.push(`           ${note}`);
    if (action.refusal !== undefined) lines.push(`           refused: ${action.refusal}`);
  }
  const { totals } = plan;
  lines.push(
    `totals: ${totals.create} to create, ${totals.replace} to replace, ${totals.delete} to ` +
      `delete, ${totals.keep} kept, ${totals.drifted} drifted, ${totals.blocked} blocked`,
  );
  const { apiRequests, storage, emails } = plan.gates;
  const left = (value: string | undefined, unread: string | undefined): string =>
    value !== undefined ? `, ${value} left` : unread !== undefined ? ` (left: ${unread})` : '';
  lines.push(
    `API requests: about ${apiRequests.estimate}` +
      left(apiRequests.leftToday?.toString(), apiRequests.unread) +
      (apiRequests.partial ? `; not counted: ${(apiRequests.notCounted ?? []).join(', ')}` : ''),
  );
  lines.push(
    `data storage: about ${formatMB(storage.bytes / BYTES_PER_MB)} MB` +
      left(
        storage.left !== undefined ? `${formatMB(storage.left / BYTES_PER_MB)} MB` : undefined,
        storage.unread,
      ),
  );
  for (const limit of emails) {
    lines.push(
      `emails (${limit.limit}): ${limit.emails}` +
        (limit.left !== undefined ? `, ${limit.left} left today` : ''),
    );
  }
  lines.push(...checkpointPlanLines(plan));
  for (const warning of plan.warnings ?? []) lines.push(`warning: ${warning}`);
  if (plan.refusal !== undefined) lines.push(`an apply now would be refused: ${plan.refusal}`);
  return lines;
}
