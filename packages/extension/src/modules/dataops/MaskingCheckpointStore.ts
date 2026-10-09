import { createHash } from 'node:crypto';

import { z } from 'zod';
import type { AnonymizationTemplateRule } from '@sandforge/shared';
import type { ConfigStore } from '../../core/storage/ConfigStore.js';

/** Key prefix for masking checkpoints in the config store. */
const CHECKPOINT_PREFIX = 'anonymization:checkpoint:';

/** Config store category for masking checkpoints. */
const CHECKPOINT_CATEGORY = 'anonymizationCheckpoints';

/**
 * The most record ids the org refused that a checkpoint keeps, over all its
 * objects. A run that leaves more cannot be resumed: past this, its ids would
 * weigh on every save of the window's state, and a resume that retried only
 * some of them would leave the rest holding their real values without a word.
 */
export const MAX_CHECKPOINT_REFUSED = 2_000;

/** A record id, 15 or 18 letters and digits: what goes into a statement as it is. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** A field's API name, as an update sends it. */
const FIELD_NAME = z.string().min(1).max(255);

/**
 * A row of an update whose answer never came back: the org may hold what the
 * call sent, or the row's original values. What was sent is kept as a digest
 * ({@link sentValuesDigest}) of the masked values, never the values themselves
 * nor the originals.
 */
const unconfirmedSchema = z.object({
  id: z.string().regex(RECORD_ID),
  /** The fields the call sent, by API name. */
  fields: z.array(FIELD_NAME).min(1).max(800),
  /** {@link sentValuesDigest} of what the call sent for them. */
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});

/** How far a masking run got through one object. */
const progressSchema = z.object({
  objectApiName: z.string().min(1).max(255),
  /** Whether the run read the object to its last row. */
  done: z.boolean(),
  /** The last row handled, in Id order: a resume reads after it. Absent before the first. */
  afterId: z.string().regex(RECORD_ID).optional(),
  /** The rows the org refused: they hold their original values, and a resume tries them first. */
  refused: z.array(z.string().regex(RECORD_ID)).max(MAX_CHECKPOINT_REFUSED),
  /**
   * The rows of the update the run ended on, whose answer never came back:
   * they lie behind `afterId`, and a resume reads them back before anything
   * else, so that a row the call masked is not masked a second time, another
   * way. Absent when there are none.
   */
  unconfirmed: z.array(unconfirmedSchema).max(MAX_CHECKPOINT_REFUSED).optional(),
});

/**
 * Where a masking run that stopped short left off, read back through this
 * schema: an entry edited by hand or written by another version is no
 * checkpoint, and a resume from it is refused rather than guessed.
 */
const checkpointSchema = z.object({
  /** The run that stopped: the page names it when it asks to resume. */
  id: z.string().min(1).max(200),
  orgId: z.string().min(1).max(200),
  templateId: z.string().min(1).max(200),
  /** {@link maskingFingerprint} of the run's rules and objects. */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  savedAt: z.string(),
  objects: z.array(progressSchema),
});

/** How far a masking run got through one object, as a checkpoint keeps it. */
export type MaskingProgress = z.infer<typeof progressSchema>;

/** A row of an update whose answer never came back, as a checkpoint keeps it. */
export type UnconfirmedRow = z.infer<typeof unconfirmedSchema>;

/** Where a masking run that stopped short left off. */
export type MaskingCheckpoint = z.infer<typeof checkpointSchema>;

/**
 * What a checkpoint is good for: the rules a run applied and the objects it
 * addressed, in that order. A template edited since, a rule's setting changed,
 * an object added, and the rows the first run masked are no longer masked the
 * way the rest would be: such a checkpoint matches nothing. A rule's
 * description is left out, as it masks nothing.
 */
export function maskingFingerprint(
  rules: readonly AnonymizationTemplateRule[],
  objects: readonly string[],
): string {
  const masked = rules.map((r) => [r.fieldPattern, r.ruleType, r.config ?? null]);
  return createHash('sha256')
    .update(JSON.stringify({ rules: masked, objects }))
    .digest('hex');
}

/** A value as a row read back compares with the value an update sent: text without its edge spaces. */
function comparable(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * A digest of a row's values for some fields: of what an update sent, kept,
 * and of the same row read back, compared with it. Equal, the row holds what
 * the update sent. The fields in name order, so either side may list them in
 * any; text without its edge spaces, which the org may trim; a number or a
 * flag as text.
 *
 * @param row - The values, by field API name.
 * @param fields - The fields the digest covers.
 */
export function sentValuesDigest(
  row: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): string {
  const values = [...fields].sort().map((field) => [field, comparable(row[field])]);
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

/** Rows the org refused that a set of objects' progress holds. */
export function refusedCount(objects: readonly MaskingProgress[]): number {
  return objects.reduce((sum, o) => sum + o.refused.length, 0);
}

/**
 * Persists, per org and template, where the last masking run that stopped
 * short left off, so that a resume masks only what it left: a run masks every
 * row it reads, and an address it already hashed is still an address, which a
 * second run hashes again.
 *
 * Thin facade over ConfigStore with a dedicated key prefix and category, the
 * pattern AnonymizationTemplateStore follows. One checkpoint per org and
 * template: the next run of the same template on the same org replaces it.
 */
export class MaskingCheckpointStore {
  /** @param configStore - The configuration store backend. */
  constructor(private readonly configStore: ConfigStore) {}

  /**
   * The checkpoint of a run of this template on this org, when its rules and
   * objects are still those of the run about to start.
   *
   * @param orgId - The org the run writes to.
   * @param templateId - The template it applies.
   * @param fingerprint - {@link maskingFingerprint} of the run about to start.
   */
  load(orgId: string, templateId: string, fingerprint: string): MaskingCheckpoint | undefined {
    const parsed = checkpointSchema.safeParse(this.configStore.get(this.key(orgId, templateId)));
    if (!parsed.success) return undefined;
    const checkpoint = parsed.data;
    if (
      checkpoint.orgId !== orgId ||
      checkpoint.templateId !== templateId ||
      checkpoint.fingerprint !== fingerprint
    ) {
      return undefined;
    }
    return checkpoint;
  }

  /**
   * Keep where a run left off, in place of the one kept before.
   *
   * @param checkpoint - Where the run left off; at most
   *   {@link MAX_CHECKPOINT_REFUSED} refused ids over all its objects.
   * @throws When it holds more refused ids than that: such a run is not resumed.
   */
  save(checkpoint: MaskingCheckpoint): void {
    if (refusedCount(checkpoint.objects) > MAX_CHECKPOINT_REFUSED) {
      throw new Error(
        `A checkpoint keeps at most ${MAX_CHECKPOINT_REFUSED} refused records; this run left ` +
          `${refusedCount(checkpoint.objects)}.`,
      );
    }
    this.configStore.set(
      this.key(checkpoint.orgId, checkpoint.templateId),
      checkpoint,
      CHECKPOINT_CATEGORY,
    );
  }

  /**
   * Forget where the last run of a template on an org left off: it finished,
   * or what it left cannot be resumed.
   */
  clear(orgId: string, templateId: string): void {
    this.configStore.delete(this.key(orgId, templateId));
  }

  private key(orgId: string, templateId: string): string {
    return `${CHECKPOINT_PREFIX}${orgId}:${templateId}`;
  }
}
