/**
 * The loads another sas wrote into an org, as the sweep of a load's removal
 * or reload is told of them: runs of the window, which refuse
 * `--sweep-untied`, as any other run of this machine does.
 *
 * A sas knows only its own loads, from its mapping, and the sweep of one of
 * them read no other: a load from a second sas into the same org, writing in
 * the window of the first, was no other run of it, and what that load's flows
 * created tied to nothing was the first sweep's to take. Its user is the same,
 * its records are no one's the first knows: only the window tells.
 *
 * Told by the mark a load leaves where every load of this machine is
 * recorded — the audit trail in the editor, an index of the command line's
 * loads in its journal folder — the mark of the sas it wrote to. An entry
 * recorded before loads left one is told by when it ended: within the span of
 * a load the sas recorded, it is that load's.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { AuditLogEntry } from '@sandforge/shared';
import type { LocalRun } from '../../bridge/handlers/removalSweep.js';

/** How far after a load recorded in the sas an entry left without a mark is still taken for it. */
export const UNMARKED_ENTRY_MARGIN_MS = 15 * 60_000;

/**
 * What names a sas in the records of its loads: `sha256:` and the first
 * sixteen hex characters of the SHA-256 of its resolved folder. Never the
 * folder, which often carries a user's name.
 */
export function sasMarkOf(sasDir: string): string {
  return `sha256:${createHash('sha256').update(path.resolve(sasDir)).digest('hex').slice(0, 16)}`;
}

/** A load as the sas keeps it: when it began, on this machine's clock, and when it wrote its last record. */
export interface OwnLoad {
  startedAt?: string;
  endedAt: string;
}

/** A load of this machine into an org, wherever it is recorded: its sas's mark, when it began and ended. */
export interface MarkedLoad {
  /** Absent from an entry recorded before loads left one. */
  sas?: string;
  startedAt?: string;
  endedAt: string;
}

/** Whether a load with no mark is one the sas recorded: it ended within one of their spans. */
function isOwnUnmarked(endedAt: number, own: readonly OwnLoad[]): boolean {
  return own.some((load) => {
    const end = Date.parse(load.endedAt);
    const start = Date.parse(load.startedAt ?? load.endedAt);
    return (
      Number.isFinite(end) &&
      endedAt >= (Number.isFinite(start) ? start : end) - 60_000 &&
      endedAt <= end + UNMARKED_ENTRY_MARGIN_MS
    );
  });
}

/**
 * The loads of `loads` another sas than `sasMark` wrote, each a run of its
 * span whose records are not named here. One the sas recorded itself is
 * left out: its mapping names it.
 */
export function otherSasRunsOf(
  loads: readonly MarkedLoad[],
  input: { sasMark: string | undefined; own: readonly OwnLoad[] },
): LocalRun[] {
  const runs: LocalRun[] = [];
  for (const load of loads) {
    const to = Date.parse(load.endedAt);
    if (!Number.isFinite(to)) continue;
    if (load.sas !== undefined ? load.sas === input.sasMark : isOwnUnmarked(to, input.own)) {
      continue;
    }
    const from = Date.parse(load.startedAt ?? load.endedAt);
    runs.push({ ids: [], idsUntold: true, from: Number.isFinite(from) ? from : to, to });
  }
  return runs;
}

/**
 * The file of the journal folder the command line keeps its loads in, one
 * line each, whichever sas they wrote to: its store is the sas's own
 * (`cli-store.json`), and no other sas reads it.
 */
export const LOADS_INDEX_FILE = 'frozen-loads.ndjson';

/** A line of the index: a load, and the org it wrote to by its Organization id. */
interface IndexedLoad extends MarkedLoad {
  organizationId: string;
}

/** Add a load the command line ran to the index of `journalDir`. */
export function indexLoad(journalDir: string, load: IndexedLoad): void {
  mkdirSync(journalDir, { recursive: true });
  appendFileSync(path.join(journalDir, LOADS_INDEX_FILE), `${JSON.stringify(load)}\n`);
}

/** Two ids of one org: the 15 characters both forms of an id begin with. */
function sameOrg(a: string, b: string): boolean {
  return a.slice(0, 15) === b.slice(0, 15);
}

/**
 * The loads the index of `journalDir` holds into an org, a line that does not
 * read passed over; none when there is no index.
 */
export function indexedLoadsOf(journalDir: string, organizationId: string): MarkedLoad[] {
  let text: string;
  try {
    text = readFileSync(path.join(journalDir, LOADS_INDEX_FILE), 'utf8');
  } catch {
    return [];
  }
  const loads: MarkedLoad[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const {
      organizationId: org,
      sas,
      startedAt,
      endedAt,
    } = (parsed ?? {}) as Record<string, unknown>;
    if (typeof org !== 'string' || typeof endedAt !== 'string') continue;
    if (!sameOrg(org, organizationId)) continue;
    loads.push({
      endedAt,
      ...(typeof sas === 'string' ? { sas } : {}),
      ...(typeof startedAt === 'string' ? { startedAt } : {}),
    });
  }
  return loads;
}

/**
 * The loads the audit trail records into an org that wrote: Frozen loads
 * whose run went on past their checks, with the mark and the start they
 * left. A load stopped before it wrote is no run of any window.
 */
export function auditedLoadsOf(
  entries: ReadonlyArray<Pick<AuditLogEntry, 'action' | 'outcome' | 'timestamp' | 'details'>>,
): MarkedLoad[] {
  return entries
    .filter((entry) => entry.action === 'frozen_load' && entry.outcome !== 'stopped')
    .map((entry) => {
      const sas = entry.details?.sas;
      const startedAt = entry.details?.startedAt;
      return {
        endedAt: entry.timestamp,
        ...(typeof sas === 'string' ? { sas } : {}),
        ...(typeof startedAt === 'string' ? { startedAt } : {}),
      };
    });
}
