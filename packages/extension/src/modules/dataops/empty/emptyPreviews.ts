/**
 * The dry runs of emptyings, kept on disk for the run that acts on one, as a
 * rewind keeps its previews (`previews/<previewId>/` beside its checkpoint).
 *
 * The page's Empty button sends the id of the preview it shows, and the run
 * reads the org again against what that preview said (`changedSince`). Kept
 * in the window's memory an hour at most, a preview was gone once the window
 * reloaded or the hour passed while the page still showed it, and the run
 * answered `PREVIEW_GONE` to a preview on the screen. Kept here, a day as a
 * rewind's (`PREVIEW_KEEP_MS`), it outlives both.
 *
 * One file per preview, `<root>/<previewId>.json`, its owner's alone to read:
 * what the preview said and of which registered org. A preview a run acted on
 * goes; one past its day goes the next time a preview is kept, and so do the
 * oldest past {@link KEPT_AT_MOST}.
 */

import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import {
  CHECKPOINT_FILE_MODE,
  PREVIEW_KEEP_MS,
  makePrivateDir,
} from '../../checkpoint/OrgCheckpointStore.js';
import type { EmptyKeptPreview } from './emptyAct.js';

/** A preview's id, as `emptyAct` makes them: `ep-20261112-140512-a1b2`. */
const PREVIEW_ID = /^ep-\d{8}-\d{6}-[a-z0-9]{4}$/;

/** Previews kept at most, the newest: a page asks one per change of its options. */
export const KEPT_AT_MOST = 50;

/** Whether `previewId` names a preview, and may name a file. */
export function isEmptyPreviewId(previewId: string): boolean {
  return PREVIEW_ID.test(previewId);
}

const countedSchema = z
  .object({ records: z.number().optional(), unread: z.string().optional() })
  .loose();

/**
 * What a run reads of a kept preview before it reads the org again: the
 * org it was of, what it asked, and what it said of each object. Checked as
 * it is read back: a file of the disk is not trusted to be one this store
 * wrote whole.
 */
const keptFileSchema = z.object({
  v: z.literal(1),
  orgId: z.string().min(1),
  kept: z
    .object({
      previewId: z.string().regex(PREVIEW_ID),
      readAt: z.string(),
      orgName: z.string(),
      organizationId: z.string().min(15).max(18),
      request: z.object({ mode: z.enum(['objects', 'org']) }).loose(),
      preview: z
        .object({
          mode: z.enum(['objects', 'org']),
          deleteMode: z.enum(['recycle', 'hard']),
          passes: z.array(z.object({ objectApiName: z.string(), records: countedSchema }).loose()),
          along: z.array(z.object({ objectApiName: z.string(), records: countedSchema }).loose()),
          undoLost: z.array(z.object({ objectApiName: z.string() }).loose()),
          total: z.object({ records: z.number() }).loose(),
        })
        .loose(),
      access: z.object({ kind: z.enum(['org', 'perObject']) }).loose(),
      peopleActive: z
        .object({
          people: z.number(),
          who: z.array(z.object({ userId: z.string() }).loose()).optional(),
        })
        .loose(),
    })
    .loose(),
});

/** A preview as it was kept: of which registered org, and what it said. */
export interface KeptEmptyPreview {
  orgId: string;
  kept: EmptyKeptPreview;
}

/** The previews of emptyings kept on this machine, under one folder. */
export class EmptyPreviewStore {
  constructor(
    readonly root: string,
    private readonly keepMs: number = PREVIEW_KEEP_MS,
  ) {}

  /** Keep `kept`, of the registered org `orgId`, for a run to act on; let the old ones go. */
  async keep(orgId: string, kept: EmptyKeptPreview, now: number = Date.now()): Promise<void> {
    if (!isEmptyPreviewId(kept.previewId)) {
      throw new Error(`Not a preview's id: ${kept.previewId}`);
    }
    await makePrivateDir(this.root);
    await writeFile(
      join(this.root, `${kept.previewId}.json`),
      JSON.stringify({ v: 1, orgId, kept }),
      { mode: CHECKPOINT_FILE_MODE },
    );
    await this.sweep(now);
  }

  /** The preview `previewId`, when it is kept and still within its day; undefined otherwise. */
  async read(previewId: string, now: number = Date.now()): Promise<KeptEmptyPreview | undefined> {
    if (!isEmptyPreviewId(previewId)) return undefined;
    const file = join(this.root, `${previewId}.json`);
    try {
      if ((await stat(file)).mtimeMs + this.keepMs <= now) return undefined;
      const parsed = keptFileSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
      if (!parsed.success || parsed.data.kept.previewId !== previewId) return undefined;
      return { orgId: parsed.data.orgId, kept: parsed.data.kept as unknown as EmptyKeptPreview };
    } catch {
      return undefined;
    }
  }

  /** Let the preview `previewId` go: a run acted on it. */
  async remove(previewId: string): Promise<void> {
    if (!isEmptyPreviewId(previewId)) return;
    await rm(join(this.root, `${previewId}.json`), { force: true });
  }

  /** The previews past their day, and the oldest past {@link KEPT_AT_MOST}, gone. */
  private async sweep(now: number): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return;
    }
    const kept = names
      .filter((name) => name.endsWith('.json') && isEmptyPreviewId(name.slice(0, -5)))
      .sort();
    const tooMany = Math.max(0, kept.length - KEPT_AT_MOST);
    for (const [index, name] of kept.entries()) {
      const file = join(this.root, name);
      try {
        if (index < tooMany || (await stat(file)).mtimeMs + this.keepMs <= now) {
          await rm(file, { force: true });
        }
      } catch {
        // Gone meanwhile, or not ours to remove: the next sweep sees it again.
      }
    }
  }
}
