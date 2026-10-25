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
 *   changed since by someone, or could not be read: left alone unless
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
 * Each script gates its own run against what the org has left, and sees no
 * other: three seeds that each fit can together overrun a Developer Edition's
 * day. So the plan adds up, across what it writes, each dry run's API
 * requests, data storage and emails, and blocks every writing action when a
 * sum goes past what the target has left. An environment half applied is
 * worse than none in a pipeline, and fifteen emails spent are gone for the
 * day.
 */

import {
  BYTES_PER_MB,
  type EnvAction,
  type EnvActionGates,
  type EnvActionKind,
  type EnvEmailLimit,
  type EnvFile,
  type EnvPlan,
  type EnvPlanObject,
  type EnvResourceState,
  type EnvState,
} from '@sandforge/shared';
import { formatMB } from '../../src/modules/forge/ForgeRunGate.js';
import type { EnvFileResolved } from './envFile.js';
import type { SeedDryRunAnswer, SeedPreviewAnswer } from './envSteps.js';

/** What a removal preview of one run of a resource said, or why it said nothing. */
export type EnvRunPreview =
  | { n: number; preview: SeedPreviewAnswer }
  /** The run left nothing to take back from: no summary, no run file, so it wrote nothing. */
  | { n: number; nothing: true }
  | { n: number; failed: string };

/** A resource's dry run, through its own script, or why it did not answer. */
export type EnvDryRun = { answer: SeedDryRunAnswer } | { failed: string };

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
  /** Resources the line asks to replace (`--replace`). */
  replace?: readonly string[];
  /** Replace every drifted resource (`--replace-drifted`). */
  replaceDrifted?: boolean;
  /** What a real apply would meet now, a guard's: no state without `--accept-no-state`. */
  refusal?: string;
  warnings?: readonly string[];
}

/** A resource's action before its dry run and the gates are read. */
export interface EnvActionDraft {
  resource: string;
  kind: 'seed';
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

/** What a resource's record counts come to across its runs' previews. */
interface Held {
  objects: Map<string, { present: number; gone: number; changed: number; unread: number }>;
  changedBy: Map<string, number>;
  refusals: string[];
  failed: string[];
}

function heldOf(previews: readonly EnvRunPreview[]): Held {
  const held: Held = { objects: new Map(), changedBy: new Map(), refusals: [], failed: [] };
  for (const run of previews) {
    if ('failed' in run) {
      held.failed.push(`run ${run.n}: ${run.failed}`);
      continue;
    }
    if ('nothing' in run) continue;
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
 * Each resource's action before its dry run is read: the file against the
 * state and what the org holds of it. In the order the plan lists them:
 * what is taken back first, the last applied first; then the file's
 * resources in the order apply runs them.
 */
export function classifyResources(
  input: Pick<EnvPlanInput, 'resolved' | 'state' | 'previews' | 'replace' | 'replaceDrifted'>,
): EnvActionDraft[] {
  const { resolved, state, previews } = input;
  const quick = previews === undefined;
  const asked = new Set(input.replace ?? []);
  const live = new Map(liveResources(state));
  const inFile = new Set(resolved.resources.map((resource) => resource.name));
  const actions = new Map<string, EnvActionDraft>();

  for (const resource of resolved.resources) {
    const kept = live.get(resource.name);
    if (kept === undefined) {
      actions.set(resource.name, {
        resource: resource.name,
        kind: 'seed',
        action: 'create',
        why:
          state?.resources[resource.name]?.status === 'destroyed'
            ? 'taken back by an earlier destroy: applied again'
            : 'not applied to this org yet',
        objects: [],
      });
      continue;
    }
    const held = heldOf(previews?.[resource.name] ?? []);
    const reasons: string[] = [];
    if (kept.fingerprint !== resource.fingerprint) {
      reasons.push('what it writes changed in the file since it was applied');
    }
    const statusWhy = STATUS_WHY[kept.status];
    if (statusWhy !== undefined) reasons.push(statusWhy);
    const changedDeps = resource.dependsOn.filter((dep) => {
      const action = actions.get(dep)?.action;
      return action !== undefined && RUNS.has(action);
    });
    if (changedDeps.length > 0) {
      reasons.push(
        `the resources it depends on run again, with new records: ${changedDeps.join(', ')}`,
      );
    }
    if (asked.has(resource.name)) reasons.push('--replace asks it');
    const drift = quick ? undefined : driftOf(held);
    if (reasons.length === 0 && drift !== undefined && input.replaceDrifted === true) {
      reasons.push(`its records drifted (${drift}), and --replace-drifted asks it`);
    }
    const objects = heldObjects(held);
    const refusal =
      held.refusals.length > 0
        ? `a removal of its runs would be refused now: ${held.refusals.join(' ')}`
        : held.failed.length > 0
          ? `what the org holds of it could not be read (${held.failed.join('; ')}): plan again`
          : undefined;
    if (reasons.length > 0) {
      actions.set(resource.name, {
        resource: resource.name,
        kind: 'seed',
        action: 'replace',
        why: `replaced: ${reasons.join('; ')}`,
        objects,
        ...(refusal !== undefined ? { refusal } : {}),
      });
    } else if (quick) {
      actions.set(resource.name, {
        resource: resource.name,
        kind: 'seed',
        action: 'keep',
        why: 'applied from the same file; what the org holds of it was not read (--quick)',
        objects,
      });
    } else if (held.failed.length > 0) {
      actions.set(resource.name, {
        resource: resource.name,
        kind: 'seed',
        action: 'keep',
        why: 'applied from the same file',
        objects,
        refusal: `what the org holds of it could not be read (${held.failed.join('; ')}): plan again`,
      });
    } else if (drift !== undefined) {
      actions.set(resource.name, {
        resource: resource.name,
        kind: 'seed',
        action: 'drifted',
        why:
          `its records changed since it was applied: ${drift}. Left as they are: ` +
          `--replace ${resource.name} or --replace-drifted replaces it`,
        objects,
      });
    } else {
      const records = objects.reduce((sum, object) => sum + (object.present ?? 0), 0);
      actions.set(resource.name, {
        resource: resource.name,
        kind: 'seed',
        action: 'keep',
        why: `applied, and the org holds its ${records} record(s) as written`,
        objects,
      });
    }
  }

  const deletes = removalOrder(
    state,
    [...live.keys()].filter((name) => !inFile.has(name)),
  ).map((name): EnvActionDraft => {
    const held = heldOf(previews?.[name] ?? []);
    const refusal =
      held.refusals.length > 0
        ? `a removal of its runs would be refused now: ${held.refusals.join(' ')}`
        : held.failed.length > 0
          ? `what the org holds of it could not be read (${held.failed.join('; ')}): plan again`
          : undefined;
    return {
      resource: name,
      kind: 'seed',
      action: 'delete',
      why: 'in the state, gone from the file: its records are taken back',
      objects: heldObjects(held),
      ...(refusal !== undefined ? { refusal } : {}),
    };
  });
  return [...deletes, ...resolved.resources.flatMap((r) => actions.get(r.name) ?? [])];
}

/**
 * The resources each resource depends on that run in the same apply before
 * it: its dry run read the org before they wrote, so what it draws from
 * their records — the existing parents of a relation — it could not count.
 */
export function readBefore(
  resolved: EnvFileResolved,
  drafts: ReadonlyArray<Pick<EnvActionDraft, 'resource' | 'action'>>,
): Map<string, string[]> {
  const running = new Set(drafts.filter((d) => RUNS.has(d.action)).map((d) => d.resource));
  const out = new Map<string, string[]>();
  for (const resource of resolved.resources) {
    if (!running.has(resource.name)) continue;
    const before = resource.dependsOn.filter((dep) => running.has(dep));
    if (before.length > 0) out.set(resource.name, before);
  }
  return out;
}

/** The emails of a dry run, per limit. */
function emailsOf(answer: SeedDryRunAnswer): Array<{ limit: EnvEmailLimit; emails: number }> {
  return answer.emails.checks.map((check) => ({ limit: check.limit, emails: check.emails }));
}

/** What a dry run's own gates would refuse a real run for. */
function dryRunRefusal(answer: SeedDryRunAnswer): string | undefined {
  return answer.storage.refusal ?? answer.apiRequests.refusal ?? answer.emails.refusal;
}

/** Add `counts` of a dry run to an action's objects, by object. */
function withWouldCreate(objects: EnvPlanObject[], answer: SeedDryRunAnswer): EnvPlanObject[] {
  const merged = objects.map((object) => ({ ...object }));
  for (const result of answer.result.objectResults) {
    const at = merged.find((object) => object.object === result.objectApiName);
    if (at) at.wouldCreate = result.recordsCreated;
    else merged.push({ object: result.objectApiName, wouldCreate: result.recordsCreated });
  }
  return merged;
}

/**
 * What the file's checkpoint settings ask that this SandForge does not do,
 * or nothing: a checkpoint before the first write, or once applied, comes
 * with a later SandForge. Applied without them, a file that asks for one
 * would read as protected by a checkpoint nobody took.
 */
export function checkpointSettingsRefusal(file: Pick<EnvFile, 'checkpoint'>): string | undefined {
  const settings = file.checkpoint;
  const asked = [
    settings?.before === true ? 'checkpoint.before' : '',
    typeof settings?.after === 'string' ? 'checkpoint.after' : '',
  ].filter(Boolean);
  if (asked.length === 0) return undefined;
  return (
    `The file asks ${asked.join(' and ')}, which a later SandForge takes: this one applies ` +
    'seed resources and takes no checkpoint. Take it out of the file, or take one with ' +
    'sandforge-checkpoint take before the apply. Nothing was written.'
  );
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
): EnvPlan['gates'] {
  let estimate = 0;
  let bytes = 0;
  const emails = new Map<EnvEmailLimit, number>();
  const notCounted: string[] = [];
  for (const draft of drafts) {
    if (draft.action === 'delete' || draft.action === 'replace') {
      notCounted.push(`the removal of ${draft.resource}'s runs`);
    }
    if (!RUNS.has(draft.action)) continue;
    const dry = dryRuns?.[draft.resource];
    if (dry === undefined || 'failed' in dry) {
      notCounted.push(`the run of ${draft.resource}, not dry-run`);
      continue;
    }
    const deps = before.get(draft.resource);
    if (deps !== undefined) {
      notCounted.push(
        `what ${draft.resource} draws from the records ${deps.join(', ')} writes first`,
      );
    }
    estimate += dry.answer.apiRequests.estimate;
    bytes += dry.answer.storage.bytes;
    for (const { limit, emails: n } of emailsOf(dry.answer)) {
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
    if (dry !== undefined && 'failed' in dry) {
      refusal ??= `its dry run did not answer: ${dry.failed}`;
    } else if (dry !== undefined) {
      objects = withWouldCreate(objects, dry.answer);
      gates = {
        apiRequests: dry.answer.apiRequests.estimate,
        storageBytes: dry.answer.storage.bytes,
        emails: emailsOf(dry.answer),
      };
      const own = dryRunRefusal(dry.answer);
      if (own !== undefined) refusal ??= `its own dry run says a real run would be refused: ${own}`;
    } else if (RUNS.has(draft.action) && !quick) {
      refusal ??= 'it was not dry-run: plan again';
    }
    // A relation of it may draw existing parents from what they write: its
    // dry run read the org before they did, and counted none of those.
    const deps = before.get(draft.resource);
    const why =
      deps !== undefined && dry !== undefined
        ? `${draft.why}; its dry run read the org before ${deps.join(', ')} writes, so what it ` +
          'draws from those records is not counted'
        : draft.why;
    return {
      resource: draft.resource,
      kind: draft.kind,
      action: refusal !== undefined ? 'blocked' : draft.action,
      why,
      objects,
      ...(gates !== undefined ? { gates } : {}),
      ...(refusal !== undefined ? { refusal } : {}),
    };
  });

  const gates = sumGates(drafts, input.dryRuns, input.budget, before);
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
    checkpointSettingsRefusal(input.resolved.checked.file) ??
    (summed.length > 0
      ? `${summed.join(' ')} Nothing was written.`
      : blocked.length > 0
        ? `${blocked.length === 1 ? 'A resource is' : `${blocked.length} resources are`} ` +
          `blocked, and the apply refuses before its first write: ` +
          `${blocked.map((action) => `${action.resource} (${action.refusal ?? action.why})`).join('; ')}`
        : undefined);

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
    ...(refusal !== undefined ? { refusal } : {}),
    ...(quick ? { quick: true as const } : {}),
    ...(input.warnings !== undefined && input.warnings.length > 0
      ? { warnings: [...input.warnings] }
      : {}),
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
  input: Pick<EnvPlanInput, 'resolved' | 'org' | 'state' | 'previews' | 'warnings'>,
): EnvPlan {
  const names = removalOrder(
    input.state,
    liveResources(input.state).map(([name]) => name),
  );
  const actions: EnvAction[] = names.map((name) => {
    const held = heldOf(input.previews?.[name] ?? []);
    const refusal =
      held.refusals.length > 0
        ? `a removal of its runs would be refused now: ${held.refusals.join(' ')}`
        : held.failed.length > 0
          ? `what the org holds of it could not be read (${held.failed.join('; ')}): run destroy again`
          : undefined;
    return {
      resource: name,
      kind: 'seed',
      action: refusal !== undefined ? 'blocked' : 'delete',
      why: 'taken back by destroy, into the recycle bin',
      objects: heldObjects(held),
      ...(refusal !== undefined ? { refusal } : {}),
    };
  });
  const blocked = actions.filter((action) => action.action === 'blocked');
  const removals = actions.map((action) => `the removal of ${action.resource}'s runs`);
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

/** Whether the org no longer holds the environment as applied: what `--fail-on-drift` exits 3 on. */
export function planDrifts(plan: Pick<EnvPlan, 'actions'>): boolean {
  return plan.actions.some(
    (action) =>
      action.action === 'drifted' ||
      action.objects.some((object) => (object.gone ?? 0) > 0 || (object.changed ?? 0) > 0),
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
    const counts = action.objects
      .map((object) => {
        const parts = [
          object.wouldCreate !== undefined ? `${object.wouldCreate} to write` : '',
          object.present !== undefined && object.present > 0 ? `${object.present} in the org` : '',
          (object.gone ?? 0) > 0 ? `${object.gone} gone` : '',
          (object.changed ?? 0) > 0 ? `${object.changed} changed` : '',
        ].filter(Boolean);
        return parts.length > 0 ? `${object.object} ${parts.join(', ')}` : '';
      })
      .filter(Boolean)
      .join('; ');
    lines.push(`  ${action.action.padEnd(8)} ${action.resource}${counts ? `  ${counts}` : ''}`);
    lines.push(`           ${action.why}`);
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
  for (const warning of plan.warnings ?? []) lines.push(`warning: ${warning}`);
  if (plan.refusal !== undefined) lines.push(`an apply now would be refused: ${plan.refusal}`);
  return lines;
}
