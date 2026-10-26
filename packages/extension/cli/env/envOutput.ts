/**
 * What an apply created in an org, read back on this machine: per resource
 * the state holds, in the order apply runs them, the ids of the records its
 * last run created, by object, as that run's own files name them — a seed's
 * run file or its summary, a clone's summary, a Frozen load's mapping in its
 * sas (`envReferences.ts`, which hands a seed relation the same ids). It
 * reaches no org. A test suite reads with it, once the apply ended, the
 * records it tests against.
 *
 * - a resource applied whole names its records;
 * - a resource a destroy took back names none, and says so: none of the
 *   org's records is its;
 * - a mask resource names none: a masking creates no record, it writes over
 *   records the org holds. It says per object how many its last run went
 *   through, and the snapshot that run took first;
 * - a resource not applied whole — its last run partial, failed or stopped
 *   part way — names none, and says why: a suite run against part of an
 *   environment tests what nobody declared. Nor does one whose run keeps no
 *   record of what it created. The output is then partial, and exits 3.
 *
 * What it names is what the runs kept, not what the org holds now: a record
 * deleted since is still named; `plan` reads the org.
 *
 * The state is found by the org the line names, as `state` finds it: by the
 * alias an apply wrote it under, or by its Organization Id. Two states of the
 * environment under one alias — a CI alias reused for a new scratch org — are
 * refused, both named: only an Organization Id says which is meant.
 */

import type { EnvOutput, EnvOutputResource, EnvResourceStatus, EnvState } from '@sandforge/shared';
import type { EnvRefusal } from './envGuards.js';
import { dependencyOrder } from './envPlan.js';
import { createdByRun, type EnvReferenceDeps } from './envReferences.js';
import type { EnvStateListing } from './envState.js';

/** What a resource a destroy took back says. */
export const OUTPUT_DESTROYED_WHY = "taken back by a destroy: none of the org's records is its";

/** What a mask resource a destroy took back says. */
export const OUTPUT_MASK_DESTROYED_WHY =
  'taken back by a destroy, which deleted its store and left its records masked: a masking ' +
  'creates no record';

/** What a mask resource says, applied or not. */
export const OUTPUT_MASK_WHY =
  'a masking creates no record: it writes over those the org holds that its condition selects';

/** Why a resource not applied whole names no record, by its status. */
const NOT_WHOLE: Readonly<Partial<Record<EnvResourceStatus, string>>> = {
  applying: 'its last run was stopped part way',
  partial: 'its last run was partial',
  failed: 'its last run failed',
  destroying: 'a removal of it was stopped part way',
};

/** Why a resource not applied whole names no record, in words. */
function notWholeWhy(status: EnvResourceStatus): string {
  return `${NOT_WHOLE[status] ?? status}: it names no record until it is applied whole — apply again`;
}

/**
 * The state of `env` the line's `--org` names, among those this machine
 * keeps: by the alias an apply wrote it under, or by its Organization Id —
 * or why there is none to read, or two.
 */
export function outputStateOf(
  listings: readonly EnvStateListing[],
  env: string,
  org: string,
): { state: EnvState } | { refusal: EnvRefusal } {
  const named = listings.filter(
    (listing) =>
      listing.env === env &&
      (listing.state?.org.alias === org ||
        listing.organizationId.slice(0, 15) === org.slice(0, 15)),
  );
  if (named.length > 1) {
    const each = named
      .map((listing) => `${listing.organizationId}, written ${listing.state?.updatedAt ?? '?'}`)
      .join('; ');
    return {
      refusal: {
        code: 'TWO_STATES',
        message:
          `${named.length} states of ${env} on this machine are of ${org}: ${each} — an alias ` +
          'reused for another org. Give --org the Organization Id of the one meant.',
        exit: 1,
      },
    };
  }
  const [listing] = named;
  if (listing === undefined) {
    return {
      refusal: {
        code: 'NO_STATE',
        message:
          `This machine keeps no state of ${env} on ${org}: nothing was applied to it from ` +
          'here, or the journal directory of the apply was not restored. output reads the ' +
          'state alone, and reaches no org.',
        exit: 1,
      },
    };
  }
  if (listing.state === undefined) {
    return {
      refusal: {
        code: 'STATE_DAMAGED',
        message: `${listing.damaged ?? 'The state does not read.'} Nothing was read.`,
        exit: 1,
      },
    };
  }
  return { state: listing.state };
}

/**
 * What each resource of the state created, read back from its last run's
 * own files, in the order apply runs them; and whether every resource was
 * read whole — applied whole and its records named, or taken back.
 */
export async function outputOf(
  state: EnvState,
  deps: EnvReferenceDeps,
): Promise<{ output: EnvOutput; whole: boolean }> {
  const where = {
    organizationId: state.org.organizationId,
    env: state.env,
    target: state.org.alias ?? state.org.organizationId,
  };
  const names = dependencyOrder(
    Object.keys(state.resources),
    (name) => state.resources[name]?.dependsOn ?? [],
  );
  const resources: Record<string, EnvOutputResource> = {};
  let whole = true;
  for (const name of names) {
    const kept = state.resources[name];
    if (kept === undefined) continue;
    const last = kept.runs.at(-1);
    const base = {
      kind: kept.kind,
      status: kept.status,
      ...(last !== undefined ? { run: last.n } : {}),
      records: {},
    };
    if (kept.status === 'destroyed') {
      resources[name] = {
        ...base,
        why: kept.kind === 'mask' ? OUTPUT_MASK_DESTROYED_WHY : OUTPUT_DESTROYED_WHY,
      };
      continue;
    }
    if (kept.status !== 'applied') whole = false;
    if (kept.kind === 'mask') {
      resources[name] = {
        ...base,
        masked: Object.fromEntries(
          (last?.objects ?? []).map((object) => [object.objectApiName, object.masked ?? 0]),
        ),
        ...(last?.snapshotId !== undefined ? { snapshotId: last.snapshotId } : {}),
        why:
          kept.status === 'applied'
            ? OUTPUT_MASK_WHY
            : `${notWholeWhy(kept.status)}; ${OUTPUT_MASK_WHY}`,
      };
      continue;
    }
    if (kept.status !== 'applied') {
      resources[name] = { ...base, why: notWholeWhy(kept.status) };
      continue;
    }
    if (last === undefined || last.takenBack === true) {
      whole = false;
      resources[name] = { ...base, why: 'it holds no run whose records are in the org' };
      continue;
    }
    const created = await createdByRun(last, where, deps);
    if ('refusal' in created) {
      whole = false;
      resources[name] = { ...base, why: created.refusal };
      continue;
    }
    resources[name] = { ...base, records: Object.fromEntries(created.created) };
  }
  return {
    output: {
      env: state.env,
      org: {
        organizationId: state.org.organizationId,
        kind: state.org.kind,
        ...(state.org.alias !== undefined ? { alias: state.org.alias } : {}),
      },
      state: { serial: state.serial, updatedAt: state.updatedAt },
      resources,
    },
    whole,
  };
}

/** What `output` says on a terminal: per resource, its records by object, or why it names none. */
export function outputLines(output: EnvOutput): string[] {
  const { org } = output;
  const lines = [
    `${output.env} on ${org.alias ?? org.organizationId} (${org.kind}, ${org.organizationId}): ` +
      `state serial ${output.state.serial}, written ${output.state.updatedAt}`,
  ];
  for (const [name, resource] of Object.entries(output.resources)) {
    lines.push(
      `  ${name}  ${resource.kind}, ${resource.status}` +
        (resource.run !== undefined ? `, run ${resource.run}` : ''),
    );
    for (const [object, ids] of Object.entries(resource.records)) {
      lines.push(`    ${object}  ${ids.length > 0 ? ids.join(' ') : 'none'}`);
    }
    for (const [object, n] of Object.entries(resource.masked ?? {})) {
      lines.push(`    ${object}  ${n} masked`);
    }
    if (resource.snapshotId !== undefined) {
      lines.push(`    snapshot ${resource.snapshotId}, taken first`);
    }
    if (resource.why !== undefined) lines.push(`    ${resource.why}`);
  }
  return lines;
}
