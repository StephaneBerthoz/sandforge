/**
 * What a run fitted to the target's storage may take, shared by the fit of a
 * Seed template and of an Autopilot plan: the budget, the room the target's
 * automation needs under the records kept, and the even spread by which a
 * table is thinned.
 *
 * A seed of a built-in template filled a Developer Edition's 5 MB part way
 * through its run, and an Autopilot plan of a client sandbox's accounts and
 * contacts took three times what the sandbox had left: both were refused,
 * with "leave objects out, lower the records per object" and nothing to do
 * it with. A fit proposes the counts, or the records, that do fit — never
 * unasked, never in silence, and the run's gate is met again by what it
 * proposes.
 *
 * The budget is the share of what `/limits` says is left past which the gate
 * asks ({@link STORAGE_NEAR_SHARE}), once a margin for its rounding is taken
 * off ({@link STORAGE_ROUNDING_MARGIN_MB}, measured), or the bound asked of
 * the fit when lower; less what the records the
 * target's flows still create under the kept ones take. Only what still runs
 * once the run's mute holds is counted (`stillRunningOf`): what the mute keeps
 * quiet creates nothing.
 */

import {
  BYTES_PER_MB,
  type StillRunning,
  type StorageFitBudget,
  type StorageRoomNotCounted,
} from '@sandforge/shared';
import {
  API_BUDGET_NEAR_SHARE,
  STORAGE_NEAR_SHARE,
  countedStorageBytes,
  type ApiBudget,
  type DataStorage,
  type RunRequestParts,
} from './ForgeRunGate.js';

/**
 * MB kept off what `/limits` says is left for its rounding. `DataStorageMB`
 * answers whole MB: its `Remaining` is the org's maximum less its usage
 * rounded to the nearest MB, so up to half a MB may be said that is not
 * there. Measured on a scratch org of 500 MB: 1,500 contacts, about 2.93 MB,
 * left 497; a trap org of 5 MB holding about 0.4 MB said 5 left.
 */
export const STORAGE_ROUNDING_MARGIN_MB = 0.5;

/**
 * Seconds within which `/limits` counts a write in what it says is left:
 * sixteen seconds after an insert of 1,500 contacts the scratch org still said
 * 500 of 500, seventy-six seconds after, 497. A second run right after a first
 * reads a storage left that may be late by about that much.
 */
export const STORAGE_RECOUNT_SECONDS = 60;

/** What {@link fitBudgetOf} is given: what the target says it has, and what is asked of the fit. */
export interface FitBudgetInput {
  storage: Pick<DataStorage, 'maxMB' | 'remainingMB'> | { unread: string };
  /** The most MB asked of the run (`--fit-within`), beside what the org has left. */
  withinMB?: number;
  /** The target's daily API requests, when read; the fit then bounds the run's own part. */
  api?: ApiBudget | { unread: string };
  /**
   * The parts of the run's requests the fit does not scale — the checkpoint
   * taken first, the read-backs, the deliverability read, the fit's own
   * reads — which the run's own part leaves room for.
   */
  otherRequests?: Omit<RunRequestParts, 'run'>;
}

/** The bytes and requests a fitted run may take, and what they are drawn from. */
export interface FitBudget {
  /** The bytes the fitted run and what the target's automation creates under it may take together. */
  bytes: number;
  terms: Pick<
    StorageFitBudget,
    'remainingMB' | 'maxMB' | 'share' | 'roundingMB' | 'withinMB' | 'limitedBy'
  >;
  /**
   * The most API requests the run's own part may take for the run to pass
   * its gate without the question "near": what leaves a tenth of the day,
   * less the other parts. Absent when the target's requests were not read.
   */
  runRequests?: number;
  /** Why the target's requests were not read, when it would not say. */
  requestsUnread?: string;
}

/**
 * The budget of a fit: `min(withinMB, 0.8 × (remaining − 0.5)) MB`, the
 * room of the target's automation to come off it as the records are chosen
 * ({@link roomBytesOf}), and the run's own API requests that leave a tenth of
 * the day once the other parts are counted. A target that would not say its
 * storage leaves nothing to fit to.
 */
export function fitBudgetOf(input: FitBudgetInput): FitBudget | { unread: string } {
  if ('unread' in input.storage) return { unread: input.storage.unread };
  const { remainingMB, maxMB } = input.storage;
  const storageBytes =
    STORAGE_NEAR_SHARE * Math.max(0, remainingMB - STORAGE_ROUNDING_MARGIN_MB) * BYTES_PER_MB;
  const withinBytes =
    input.withinMB !== undefined ? Math.max(0, input.withinMB) * BYTES_PER_MB : Infinity;
  const limitedBy = withinBytes < storageBytes ? 'within' : 'storage';
  const terms: FitBudget['terms'] = {
    remainingMB,
    maxMB,
    share: STORAGE_NEAR_SHARE,
    roundingMB: STORAGE_ROUNDING_MARGIN_MB,
    ...(input.withinMB !== undefined ? { withinMB: input.withinMB } : {}),
    limitedBy,
  };
  const bytes = Math.floor(Math.min(storageBytes, withinBytes));
  if (!input.api) return { bytes, terms };
  if ('unread' in input.api) return { bytes, terms, requestsUnread: input.api.unread };
  const others = Object.values(input.otherRequests ?? {}).reduce<number>(
    (sum, part) => sum + Math.max(0, part ?? 0),
    0,
  );
  const runRequests = Math.max(
    0,
    Math.floor(input.api.remaining - API_BUDGET_NEAR_SHARE * input.api.max - others),
  );
  return { bytes, terms, runRequests };
}

/** A write of a run whose records the target's automation may create others under. */
export type FitAct = 'insert' | 'update';

/** What the target's automation that still runs creates under one record of an object a run writes. */
export interface RoomPerRecord {
  objectApiName: string;
  act: FitAct;
  /** The bytes it creates under each record so written. */
  bytes: number;
  /** What it creates, one record each, and what creates it. */
  creates: Array<{ objectApiName: string; by: string }>;
}

/**
 * The room a run's records need for what the target's automation still
 * creates under them: per object and act, per record; and what of that
 * automation is not counted, named.
 */
export interface AutomationRoom {
  perRecord: RoomPerRecord[];
  notCounted: StorageRoomNotCounted[];
}

/** A platform event: published, never stored as a record. */
const PLATFORM_EVENT = /__e$/i;

/** A sharing object, whose rows may or may not take data storage. */
const SHARING_OBJECT = /Share$/;

/**
 * The room the target's automation needs under a run's records, from what
 * still runs once the run's mute holds ({@link StillRunning}): for each flow,
 * process or workflow rule that fires on an act the run makes of an object,
 * one record of each object its record-create elements create, at the size
 * the documented storage gives it — one each is the least a loop creates, and
 * more than a condition that is not met does. A platform event is published,
 * never kept, and is left out; a sharing row, an Apex trigger, whose code is
 * not read, and a flow whose definition was not read are named, not counted.
 *
 * No room is kept for the FeedItems the feed tracking of an object writes:
 * 600 posts on an account of the scratch org left it at 500 MB of 500 for
 * half an hour, a FeedItem taking no data storage. Nor for what a run's
 * removal sends to the recycle bin, which counts for nothing either, and
 * whose emptying frees nothing.
 *
 * @param running - What still runs ({@link stillRunningOf}), the run's writes given to it.
 * @param acts - The acts the run makes of each object: it inserts what it writes, and updates what it writes a second time.
 */
export function automationRoomOf(
  running: Pick<StillRunning<unknown>, 'firing'>,
  acts: (objectApiName: string, act: FitAct) => boolean,
): AutomationRoom {
  const perRecord = new Map<string, RoomPerRecord>();
  const notCounted = new Map<string, StorageRoomNotCounted>();
  const roomOf = (objectApiName: string, act: FitAct): RoomPerRecord => {
    const key = `${objectApiName}\n${act}`;
    let room = perRecord.get(key);
    if (!room) {
      room = { objectApiName, act, bytes: 0, creates: [] };
      perRecord.set(key, room);
    }
    return room;
  };
  const named = (entry: StorageRoomNotCounted): void => {
    notCounted.set(`${entry.objectApiName}\n${entry.kind}\n${entry.name}`, entry);
  };
  for (const entry of running.firing) {
    const act = entry.write;
    if (act !== 'insert' && act !== 'update') continue;
    if (!acts(entry.objectApiName, act)) continue;
    if (entry.kind === 'trigger' || !entry.flow) {
      named({ objectApiName: entry.objectApiName, kind: 'trigger', name: entry.name });
      continue;
    }
    if (entry.flow.condition !== 'read') {
      named({ objectApiName: entry.objectApiName, kind: 'notRead', name: entry.name });
      continue;
    }
    for (const created of entry.flow.creates ?? []) {
      if (PLATFORM_EVENT.test(created)) continue;
      if (SHARING_OBJECT.test(created)) {
        named({ objectApiName: entry.objectApiName, kind: 'share', name: created });
        continue;
      }
      const room = roomOf(entry.objectApiName, act);
      room.bytes += countedStorageBytes(created, { rows: 1 });
      room.creates.push({ objectApiName: created, by: entry.name });
    }
  }
  return {
    perRecord: [...perRecord.values()].filter((room) => room.bytes > 0),
    notCounted: [...notCounted.values()],
  };
}

/**
 * The bytes the room takes under the records a fitted run keeps: per object
 * and act, the room of one record times the records kept so written — those
 * inserted, and of them those written a second time for an update.
 */
export function roomBytesOf(
  room: Pick<AutomationRoom, 'perRecord'>,
  kept: (objectApiName: string, act: FitAct) => number,
): number {
  return room.perRecord.reduce(
    (sum, entry) => sum + entry.bytes * Math.max(0, kept(entry.objectApiName, entry.act)),
    0,
  );
}

/**
 * The budget of a fit as its report says it ({@link StorageFitBudget}): what
 * the run may write once the room its automation takes under the records
 * chosen is off, and that room.
 */
export function storageFitBudgetOf(
  budget: Pick<FitBudget, 'bytes' | 'terms'>,
  roomBytes: number,
  room: Pick<AutomationRoom, 'notCounted'>,
): StorageFitBudget {
  return {
    budgetMB: Math.max(0, budget.bytes - roomBytes) / BYTES_PER_MB,
    ...budget.terms,
    automationMB: roomBytes / BYTES_PER_MB,
    ...(room.notCounted.length > 0 ? { notCounted: room.notCounted.map((e) => ({ ...e })) } : {}),
  };
}

/**
 * The `k` of `n` positions a fit keeps, spread over all of them: position `i`
 * is kept when ⌊(i + 1)·k / n⌋ passes ⌊i·k / n⌋. Exactly `k` are kept, two
 * kept ones are never more than ⌈n / k⌉ apart, and the same `n` and `k` keep
 * the same positions: a plan and its run, made from the same source, keep the
 * same records. The first `k` would keep the oldest records alone — accounts
 * of years ago, cases long closed — and a child could not follow its parent
 * by a bound on ids.
 *
 * @returns The positions kept, ascending; every one when `k ≥ n`, none when `k ≤ 0`.
 */
export function evenlyKept(n: number, k: number): number[] {
  const total = Math.max(0, Math.floor(n));
  const keep = Math.min(total, Math.max(0, Math.floor(k)));
  const kept: number[] = [];
  if (keep === 0) return kept;
  for (let i = 0; i < total; i++) {
    if (Math.floor(((i + 1) * keep) / total) > Math.floor((i * keep) / total)) kept.push(i);
  }
  return kept;
}
