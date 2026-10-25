/**
 * References between the resources of an environment: a seed relation whose
 * parents are the records another resource of the file created
 * (`parents.from`).
 *
 * The ids are read back from what that resource's last run keeps, whatever
 * its kind: a seed's run file, written as the org took each record, or the
 * summary it printed; a clone's summary, the target ids its remap table gives
 * the source records it created, from its journal when the summary keeps
 * them there; a Frozen load's mapping in the sas, the records it created
 * rather than linked. Never by a query: the records another resource wrote
 * are the ones its run names, not whatever the org holds that looks like
 * them.
 *
 * The seed is handed them as parents named by id (`records`), at most 2,000,
 * the bound of the parents a relation reads of the org, and checks them
 * against the org before its first write. A resource that created more of the
 * object than that is drawn from with a `limit`, its first records first; or
 * refused, naming the count.
 *
 * The ids are known once the resource drawn from has run. A plan made while
 * it runs in the same apply knows none: the drawing resource's count stays the
 * most the file gives, and the plan says so. Once it has run, the plan hands
 * the dry run the ids, and the count is exact.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SEED_RELATION_LIMITS,
  forgeRunCreatedRecords,
  type EnvActionDraw,
  type EnvSeedDraw,
  type EnvState,
} from '@sandforge/shared';
import { nodeRunJournal } from '../../src/modules/forge/ForgeRunJournal.js';
import {
  mappedOrgIds,
  SasReferenceIdMappingStore,
} from '../../src/modules/frozendataset/SasReferenceIdMappingStore.js';
import { loadCreatedRecords } from '../../src/modules/frozendataset/loadRecords.js';
import { SasPathGuard } from '../../src/modules/frozendataset/SasPathGuard.js';
import { SEED_RUNS_DIR } from '../../src/modules/seed/SeedRunCreations.js';
import { readRunFile } from '../../src/modules/sync/SyncRunCreations.js';
import { runSummaryOfFile } from '../sandforge-clone.js';
import type { EnvFileResource } from './envFile.js';
import type { EnvStore } from './envState.js';
import { resourceOfSas } from './kinds/frozen.js';
import { readSeedRun } from './kinds/seed.js';

/** Where the runs of an environment's state are read from. */
export interface EnvReferenceDeps {
  store: EnvStore;
  /** The folder `SANDFORGE_JOURNAL_DIR` names, where the seed keeps its run files and the clone its journals. */
  journalDir: string;
}

/** The org and the environment whose state names the runs. */
export interface EnvReferenceWhere {
  organizationId: string;
  env: string;
  /** sf CLI alias of the org: what a clone's journal is read for. */
  target: string;
}

/** The records a resource's last run created, per object in the order it wrote them; or why not. */
export type EnvCreated = { created: Map<string, string[]> } | { refusal: string };

/** A record by its first fifteen characters: the same record, whichever length its id was written in. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** Per object, each id once, the order kept. */
function byObject(objects: ReadonlyArray<{ objectApiName: string; ids: readonly string[] }>) {
  const created = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const { objectApiName, ids } of objects) {
    const list = created.get(objectApiName) ?? [];
    for (const id of ids) {
      if (seen.has(recordKey(id))) continue;
      seen.add(recordKey(id));
      list.push(id);
    }
    created.set(objectApiName, list);
  }
  return created;
}

/**
 * What a seed run created: its run file, written as the org took each record
 * — whole, where the summary carries the first thousand ids of an object at
 * most — or, without one, its summary, when it names every id.
 */
function seedCreated(
  run: { runId?: string; summary?: string },
  where: EnvReferenceWhere,
  deps: EnvReferenceDeps,
): EnvCreated {
  const runFile =
    run.runId !== undefined
      ? join(deps.journalDir, SEED_RUNS_DIR, `${run.runId}.ndjson`)
      : undefined;
  if (runFile !== undefined && existsSync(runFile)) {
    const read = readRunFile(readFileSync(runFile, 'utf8'));
    if (read !== undefined) return { created: byObject(read.created) };
  }
  if (run.summary === undefined) return { refusal: 'its run keeps no record of what it created' };
  const file = deps.store.fileOf(where.organizationId, where.env, run.summary);
  if (!existsSync(file)) return { refusal: 'its run keeps no record of what it created' };
  const summary = readSeedRun(readFileSync(file, 'utf8'));
  if (summary.result.objectResults.some((object) => object.truncated === true)) {
    return {
      refusal:
        'its summary names the first of the records it created alone, and its run file is gone',
    };
  }
  return {
    created: byObject(
      summary.result.objectResults.map((object) => ({
        objectApiName: object.objectApiName,
        ids: object.createdIds,
      })),
    ),
  };
}

/**
 * What a clone created: the target ids its remap table gives the source
 * records it created — never one it linked to — read from its journal where
 * the summary keeps them there, in the order it wrote them.
 */
async function forgeCreated(
  run: { summary?: string },
  where: EnvReferenceWhere,
  deps: EnvReferenceDeps,
): Promise<EnvCreated> {
  if (run.summary === undefined) return { refusal: 'its run keeps no summary' };
  const file = deps.store.fileOf(where.organizationId, where.env, run.summary);
  if (!existsSync(file)) return { refusal: 'its run keeps no summary' };
  const read = await runSummaryOfFile(
    file,
    readFileSync(file, 'utf8'),
    where.target,
    nodeRunJournal(deps.journalDir),
  );
  if ('refusal' in read) return { refusal: `its summary ${read.refusal}` };
  const { result } = read.summary;
  const objects = forgeRunCreatedRecords({
    idRemapTable: result.remapTable,
    idRemapExisting: [...result.existingSourceIds, ...result.updatedSourceIds],
    idRemapCreated: result.createdByObject,
  });
  // Read last written first, as a removal takes them: given back in the order written.
  return {
    created: byObject(
      [...objects].reverse().map((object) => ({
        objectApiName: object.objectApiName,
        ids: [...object.ids].reverse(),
      })),
    ),
  };
}

/**
 * What a Frozen load created: the records its mapping in the sas lists among
 * its creations — inserted, or a placeholder — never those it linked to or
 * reused, in the order it wrote them. The mapping of the loads into the org,
 * named after the id the script registered it under.
 */
async function frozenCreated(
  run: { sas?: string },
  where: EnvReferenceWhere,
  deps: EnvReferenceDeps,
): Promise<EnvCreated> {
  if (resourceOfSas(run.sas) === undefined || run.sas === undefined) {
    return { refusal: 'its run names no sas' };
  }
  const sasDir = deps.store.sasOf(where.organizationId, where.env, run.sas);
  const guard = new SasPathGuard();
  const orgId = (await mappedOrgIds(sasDir, guard)).find(
    (id) => recordKey(id) === recordKey(where.organizationId),
  );
  if (orgId === undefined) return { refusal: 'its sas holds no mapping of a load into this org' };
  const load = await new SasReferenceIdMappingStore(sasDir, { orgId, guard }).recorded();
  if (load?.created === undefined) {
    return { refusal: 'its sas holds no load that says which records it created' };
  }
  const objects = loadCreatedRecords(load);
  return {
    created: byObject(
      [...objects].reverse().map((object) => ({
        objectApiName: object.objectApiName,
        ids: [...object.ids].reverse(),
      })),
    ),
  };
}

/**
 * The records the last run of `name` created, per object in the order it
 * wrote them, read back from what that run keeps; or why they cannot be
 * told: the resource is not applied to the org whole, its run keeps no
 * record of them.
 */
export async function createdByResource(
  state: EnvState | undefined,
  name: string,
  where: EnvReferenceWhere,
  deps: EnvReferenceDeps,
): Promise<EnvCreated> {
  const kept = state?.resources[name];
  if (kept === undefined || kept.status === 'destroyed') {
    return { refusal: `${name} has not created its records in this org yet` };
  }
  if (kept.status !== 'applied') {
    return { refusal: `${name} is ${kept.status}, not applied whole: apply it again first` };
  }
  const run = kept.runs.at(-1);
  if (run === undefined || run.takenBack === true) {
    return { refusal: `${name} holds no run whose records are in the org` };
  }
  const read = await (async (): Promise<EnvCreated> => {
    switch (run.script) {
      case 'sandforge-seed':
        return seedCreated(run, where, deps);
      case 'sandforge-clone':
        return forgeCreated(run, where, deps);
      case 'sandforge-frozen':
        return frozenCreated(run, where, deps);
      default:
        return { refusal: `its records are kept by ${run.script}, which this SandForge reads not` };
    }
  })();
  return 'refusal' in read ? { refusal: `${name}: ${read.refusal}` } : read;
}

/**
 * The parents a draw is handed, of what the resource it draws from created:
 * the records of its parent object, the first created first, at most its
 * `limit`; or why it cannot draw — none of them, or more than a relation's
 * parents hold and no `limit`.
 */
export function drawnIdsOf(
  draw: EnvSeedDraw,
  created: ReadonlyMap<string, readonly string[]>,
): { ids: string[] } | { refusal: string } {
  const object = draw.relation.parentObject;
  const lookup = `${draw.relation.childObject}.${draw.relation.lookupField}`;
  const ids = [...(created.get(object) ?? [])];
  const most = SEED_RELATION_LIMITS.maxExistingParents;
  if (ids.length === 0) {
    const others = [...created.keys()].filter((name) => (created.get(name) ?? []).length > 0);
    return {
      refusal:
        `the relation on ${lookup} draws its parents from the ${object} records ${draw.from} ` +
        `created, and it created none: it created ${others.join(', ') || 'no record'}`,
    };
  }
  if (draw.limit !== undefined) return { ids: ids.slice(0, draw.limit) };
  if (ids.length > most) {
    return {
      refusal:
        `the relation on ${lookup} draws its parents from the ${ids.length} ${object} records ` +
        `${draw.from} created, more than the ${most} a relation's parents hold: give the ` +
        `relation a limit, and its parents are the first ${most} or fewer`,
    };
  }
  return { ids };
}

/** What a seed resource's draws are handed: the parents of each, by its place, or why one cannot be. */
export interface EnvDrawn {
  /** The ids of each draw's parents whose resource has run, by the draw's place. */
  ids: Map<number, string[]>;
  /** What the plan says of each draw. */
  draws: EnvActionDraw[];
  /** Why a draw cannot be handed its parents now: a refusal, in words. */
  refusals: string[];
}

/**
 * The parents each draw of a seed resource is handed, from the records the
 * resources it draws from created, read through their runs. A resource that
 * runs again in the same apply (`running`) has records nobody knows yet: its
 * draws are counted, not handed, and the plan says how many there will be
 * once it has run — none known now.
 */
export async function drawnOf(
  resource: EnvFileResource,
  state: EnvState | undefined,
  running: ReadonlySet<string>,
  where: EnvReferenceWhere,
  deps: EnvReferenceDeps,
): Promise<EnvDrawn> {
  const out: EnvDrawn = { ids: new Map(), draws: [], refusals: [] };
  if (resource.kind !== 'seed') return out;
  const read = new Map<string, EnvCreated>();
  for (const draw of resource.run.draws ?? []) {
    const said: EnvActionDraw = {
      lookup: `${draw.relation.childObject}.${draw.relation.lookupField}`,
      from: draw.from,
      object: draw.relation.parentObject,
    };
    if (running.has(draw.from)) {
      out.draws.push(said);
      continue;
    }
    let created = read.get(draw.from);
    if (created === undefined) {
      created = await createdByResource(state, draw.from, where, deps);
      read.set(draw.from, created);
    }
    if ('refusal' in created) {
      out.draws.push(said);
      out.refusals.push(
        `the relation on ${said.lookup} draws its parents from ${draw.from}, whose records ` +
          `cannot be read: ${created.refusal}`,
      );
      continue;
    }
    const ids = drawnIdsOf(draw, created.created);
    if ('refusal' in ids) {
      out.draws.push(said);
      out.refusals.push(ids.refusal);
      continue;
    }
    out.ids.set(draw.at, ids.ids);
    out.draws.push({ ...said, parents: ids.ids.length });
  }
  return out;
}
