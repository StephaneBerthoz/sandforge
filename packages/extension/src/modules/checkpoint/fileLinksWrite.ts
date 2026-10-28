/**
 * What a rewind, and its undo, write to the links between files and records
 * (`ContentDocumentLink`): a link removed, a link inserted again, a link
 * given its sharing back — each call of 200 links at most, each link
 * answered, what the org refused named in its words.
 *
 * A file itself is a record of the checkpoint (`ContentDocument`), deleted,
 * brought back and given its fields back as any other; its links come and go
 * with it, and with the record they tie it to, under the same Ids, in
 * whichever order the two were deleted and brought back (P-A1, P-A2, P-A5).
 * A link is written on its own only where neither does it:
 *
 * - a link added since between a file and a record that both stay is
 *   removed. Never a link to a user: the link of a file's owner is one, and
 *   the org refuses to remove it (`FIELD_INTEGRITY_EXCEPTION`, P-A3);
 * - a link of the checkpoint removed since is inserted again, under a new
 *   Id: the org brings no link back from the recycle bin on its own (`Entity
 *   type is not undeletable`, P-A3). One the file and the record tie already
 *   is there: the org refuses it as a duplicate, and it counts as linked;
 * - a link whose sharing changed since gets the checkpoint's back. Not the
 *   sharing type of a link to an account, which the org refuses to change
 *   (P-A3): it is named, never sent.
 *
 * The journal is told of each call before it goes and once it answered
 * (`LinkWriteHooks`), so the undo takes back what went: it inserts again
 * what was removed, removes what was inserted, and gives the sharing it wrote
 * over back, through the same three writes.
 */

import * as z from 'zod';
import { RECORDS_PER_CALL } from '../dataops/RecordRemoval.js';
import type { FileLinkLine } from './checkpointFiles.js';
import { FILE_LINK_OBJECT } from './checkpointScope.js';

// ─── Figures ─────────────────────────────────────────────────────────────────

/** Reasons an outcome keeps, each once: a few. */
const REASONS_KEPT = 5;

/** The first three characters of the ids of a user: the owner a file's first link names. */
const USER_PREFIX = '005';

/**
 * The first three characters of the ids of the records the org refuses to
 * change a link's sharing type for: an account's, seen on a scratch org
 * (P-A3). A link to a record of another object has its sharing type sent,
 * and a refusal is named in the org's words.
 */
const SHARE_TYPE_FIXED: ReadonlySet<string> = new Set(['001']);

/** Why a link to a user is never removed. */
export const USER_LINK_WORDS =
  "Kept: a file's link to a user is never removed, and Salesforce refuses to remove its " +
  "owner's ('FIELD_INTEGRITY_EXCEPTION').";

/** Why the sharing type of a link to an account is never sent. */
export const SHARE_TYPE_WORDS =
  "Its sharing type stays as it is: Salesforce doesn't change the sharing type of a file's " +
  "link to an account ('The sharing type cannot be updated because updates are not currently " +
  "supported for the linked Entity type').";

// ─── What a write is given, and answers ──────────────────────────────────────

/** What the links are written through: the org's collection calls. */
export interface FileLinksOrg {
  create(objectApiName: string, records: Array<Record<string, unknown>>): Promise<unknown>;
  update(objectApiName: string, records: Array<Record<string, unknown>>): Promise<unknown>;
  destroy(objectApiName: string, ids: string[]): Promise<unknown>;
}

/** A link and the sharing a write gives it: the checkpoint's, or for an undo the one from before. */
export type LinkSharing = Pick<FileLinkLine, 'Id' | 'LinkedEntityId' | 'ShareType' | 'Visibility'>;

/** What one call wrote, once it answered. */
export interface LinkCallAnswered<T> {
  /** The links of the call the org wrote as asked. */
  done: T[];
  /** Of an insert, the Id each link got, beside the Id it stands for. */
  made: Array<{ from: string; id: string }>;
  /** The links of the call it did not write, by the Id the call named them by. */
  left: string[];
}

/**
 * What a write tells as it goes: before each call, the links it holds —
 * on disk before it goes, a throw keeping it from going — and once the call
 * answered, what it wrote.
 */
export interface LinkWriteHooks<T> {
  before?(links: readonly T[]): Promise<void>;
  after?(answered: LinkCallAnswered<T>): Promise<void>;
  /** Whether to stop before the next call. */
  stopped?(): boolean;
}

/** What a write did to the links it was given. */
export interface FileLinksWritten {
  /** Links written as asked. */
  done: number;
  /** Links already as asked: gone before their delete, tied already before their insert. */
  already: number;
  /** Links the org refused. */
  refused: number;
  /** Links never sent: what Salesforce refuses whatever is sent. */
  notSent: number;
  /** Links not reached: the write was stopped first. */
  notReached: number;
  /** Why links were left, a few, each once: the org's words, or why one was never sent. */
  reasons: string[];
  /** Each link left, by the Id it was given by, with why: what the verify names. */
  left: Array<{ id: string; reason: string }>;
  /** Of an insert, the Id each link got, beside the Id it stands for. */
  made: Array<{ from: string; id: string }>;
  /** Whether it was stopped before it was through. */
  cancelled: boolean;
}

/** A write that wrote nothing yet. */
export function nothingWritten(): FileLinksWritten {
  return {
    done: 0,
    already: 0,
    refused: 0,
    notSent: 0,
    notReached: 0,
    reasons: [],
    left: [],
    made: [],
    cancelled: false,
  };
}

/** Add one write's tally to another's. */
export function addWritten(into: FileLinksWritten, from: FileLinksWritten): void {
  into.done += from.done;
  into.already += from.already;
  into.refused += from.refused;
  into.notSent += from.notSent;
  into.notReached += from.notReached;
  for (const reason of from.reasons) keepReason(into.reasons, reason);
  into.left.push(...from.left);
  into.made.push(...from.made);
  into.cancelled ||= from.cancelled;
}

function keepReason(reasons: string[], reason: string): void {
  if (reasons.length < REASONS_KEPT && !reasons.includes(reason)) reasons.push(reason);
}

/** One link's answer in a collection call. */
interface LinkAnswer {
  success: boolean;
  id?: string;
  /** The org's code, for a link it refused. */
  code?: string;
  /** The org's words, `CODE: message`, for a link it refused. */
  words?: string;
}

const answerSchema = z
  .object({
    success: z.boolean(),
    id: z.string().nullish(),
    errors: z
      .array(
        z.union([
          z.string(),
          z.object({ statusCode: z.string().optional(), message: z.string().optional() }).loose(),
        ]),
      )
      .optional(),
  })
  .loose();

/** The answers of a collection call, one per link in their order; one missing reads as a refusal without words. */
function answersOf(answer: unknown, count: number): LinkAnswer[] {
  const list: unknown[] = Array.isArray(answer) ? answer : [answer];
  return Array.from({ length: count }, (_, place): LinkAnswer => {
    const parsed = answerSchema.safeParse(list[place]);
    if (!parsed.success) return { success: false, words: 'The org gave no answer for it.' };
    const { success, id, errors } = parsed.data;
    const first = (errors ?? [])[0];
    const code = typeof first === 'object' ? first.statusCode : undefined;
    const words = (errors ?? [])
      .map((error) =>
        typeof error === 'string'
          ? error
          : [error.statusCode, error.message].filter((part) => part).join(': '),
      )
      .filter((word) => word !== '')
      .join('; ');
    return {
      success,
      ...(typeof id === 'string' ? { id } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(words !== '' ? { words } : {}),
    };
  });
}

/** `items` in calls of {@link RECORDS_PER_CALL}. */
function callsOf<T>(items: readonly T[]): T[][] {
  const calls: T[][] = [];
  for (let at = 0; at < items.length; at += RECORDS_PER_CALL) {
    calls.push(items.slice(at, at + RECORDS_PER_CALL));
  }
  return calls;
}

/**
 * Send `links` in calls of 200, each told to the hooks before and after,
 * each link's answer sorted by `settle`.
 */
async function written<T extends { Id: string }>(
  links: readonly T[],
  hooks: LinkWriteHooks<T>,
  send: (call: readonly T[]) => Promise<unknown>,
  settle: (answer: LinkAnswer) => 'done' | 'already' | 'refused',
): Promise<FileLinksWritten> {
  const outcome = nothingWritten();
  for (const call of callsOf(links)) {
    if (outcome.cancelled || hooks.stopped?.() === true) {
      outcome.cancelled = true;
      outcome.notReached += call.length;
      for (const link of call) outcome.left.push({ id: link.Id, reason: 'Not reached: stopped.' });
      continue;
    }
    await hooks.before?.(call);
    const answers = answersOf(await send(call), call.length);
    const answered: LinkCallAnswered<T> = { done: [], made: [], left: [] };
    call.forEach((link, place) => {
      const answer = answers[place];
      const verdict = settle(answer);
      if (verdict === 'done') {
        outcome.done++;
        answered.done.push(link);
        if (answer.id !== undefined) answered.made.push({ from: link.Id, id: answer.id });
        return;
      }
      answered.left.push(link.Id);
      if (verdict === 'already') {
        outcome.already++;
        return;
      }
      const reason = answer.words ?? 'The org gave no reason.';
      outcome.refused++;
      keepReason(outcome.reasons, reason);
      outcome.left.push({ id: link.Id, reason });
    });
    outcome.made.push(...answered.made);
    await hooks.after?.(answered);
  }
  return outcome;
}

/** `links` less those never sent, each of those counted and named with `words`. */
function sentOnly<T extends { Id: string }>(
  links: readonly T[],
  never: (link: T) => boolean,
  words: string,
  outcome: FileLinksWritten,
): T[] {
  const sent: T[] = [];
  for (const link of links) {
    if (!never(link)) {
      sent.push(link);
      continue;
    }
    outcome.notSent++;
    keepReason(outcome.reasons, words);
    outcome.left.push({ id: link.Id, reason: words });
  }
  return sent;
}

// ─── The three writes ────────────────────────────────────────────────────────

/**
 * Remove `links`, 200 a call: never one to a user, where the link says
 * which record it ties. One gone already — with its file or its record, or
 * by someone — is counted so, and is not the write's doing.
 */
export async function removeFileLinks<T extends { Id: string; LinkedEntityId?: string }>(
  org: Pick<FileLinksOrg, 'destroy'>,
  links: readonly T[],
  hooks: LinkWriteHooks<T> = {},
): Promise<FileLinksWritten> {
  const skipped = nothingWritten();
  const sent = sentOnly(
    links,
    (link) => link.LinkedEntityId?.startsWith(USER_PREFIX) === true,
    USER_LINK_WORDS,
    skipped,
  );
  const outcome = await written(
    sent,
    hooks,
    (call) =>
      org.destroy(
        FILE_LINK_OBJECT,
        call.map((link) => link.Id),
      ),
    (answer) =>
      answer.success
        ? 'done'
        : answer.code === 'ENTITY_IS_DELETED' || answer.code === 'NOT_FOUND'
          ? 'already'
          : 'refused',
  );
  addWritten(outcome, skipped);
  return outcome;
}

/**
 * Insert `links` again, 200 a call, each under a new Id, with the sharing it
 * had: its file and its record named by the Ids they have now, `idNow` given
 * — a record made again since has a new one. One the file and the record tie
 * already is counted so.
 */
export async function insertFileLinks(
  org: Pick<FileLinksOrg, 'create'>,
  links: readonly FileLinkLine[],
  hooks: LinkWriteHooks<FileLinkLine> = {},
  idNow: (id: string) => string = (id) => id,
): Promise<FileLinksWritten> {
  return written(
    links,
    hooks,
    (call) =>
      org.create(
        FILE_LINK_OBJECT,
        call.map((link) => ({
          ContentDocumentId: idNow(link.ContentDocumentId),
          LinkedEntityId: idNow(link.LinkedEntityId),
          ShareType: link.ShareType,
          Visibility: link.Visibility,
        })),
      ),
    (answer) =>
      answer.success && answer.id !== undefined
        ? 'done'
        : answer.code === 'DUPLICATE_VALUE'
          ? 'already'
          : 'refused',
  );
}

/**
 * Give `links` the sharing they hold, 200 a call, each as it is now beside
 * it (`now`): only what differs is sent, and never the sharing type of a
 * link to an account, which the org refuses to change. A link of which
 * nothing is left to send is named, never sent.
 */
export async function shareFileLinks(
  org: Pick<FileLinksOrg, 'update'>,
  links: ReadonlyArray<LinkSharing & { now: Pick<FileLinkLine, 'ShareType' | 'Visibility'> }>,
  hooks: LinkWriteHooks<LinkSharing> = {},
): Promise<FileLinksWritten> {
  const fixed = (link: LinkSharing): boolean =>
    SHARE_TYPE_FIXED.has(link.LinkedEntityId.slice(0, 3));
  const outcome = nothingWritten();
  const changes = new Map<string, Record<string, unknown>>();
  const sent = sentOnly(
    links,
    (link) => link.Visibility === link.now.Visibility && fixed(link),
    SHARE_TYPE_WORDS,
    outcome,
  );
  for (const link of sent) {
    const typeSent = link.ShareType !== link.now.ShareType && !fixed(link);
    if (link.ShareType !== link.now.ShareType && fixed(link)) {
      keepReason(outcome.reasons, SHARE_TYPE_WORDS);
    }
    changes.set(link.Id, {
      Id: link.Id,
      ...(typeSent ? { ShareType: link.ShareType } : {}),
      ...(link.Visibility !== link.now.Visibility ? { Visibility: link.Visibility } : {}),
    });
  }
  const shared = await written<LinkSharing>(
    sent,
    hooks,
    (call) =>
      org.update(
        FILE_LINK_OBJECT,
        call.map((link) => changes.get(link.Id) ?? { Id: link.Id }),
      ),
    (answer) =>
      answer.success ? 'done' : answer.code === 'ENTITY_IS_DELETED' ? 'already' : 'refused',
  );
  addWritten(outcome, shared);
  return outcome;
}
