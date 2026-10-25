/**
 * What every kind of resource shares: the refusals of the file, said where
 * the file wrote what they refuse; the canonical text a fingerprint is of;
 * the values a script's line may take; the reading of a script's `--json`
 * answer with zod; and the shapes of the removal brick's answers, which
 * every script that takes a run back gives alike.
 *
 * A kind of resource is one module beside this one (`seed.ts`, `forge.ts`):
 * what its resource converts into and is checked by, what it writes for its
 * fingerprint, the lines of its script, and the readers of what that script
 * answers. The environment's plan, apply and destroy reach a kind through
 * `envKinds.ts` alone.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EnvDocumentPath, EnvEmailLimit } from '@sandforge/shared';
import type { RunnableScript } from '../../scriptRunner.js';

// ─── The file ────────────────────────────────────────────────────────────────

/** What the file is refused for, and where. */
export interface EnvFileRefusal {
  /** Where in the file: its keys and list positions from the top. */
  path: EnvDocumentPath;
  /** The resource it is of, when it is one's. */
  resource?: string;
  message: string;
}

/** A place in the file as a line names it: `resources.accounts.objects[0].count`. */
export function pathText(path: EnvDocumentPath): string {
  if (path.length === 0) return 'the file';
  return path
    .map((part, i) =>
      typeof part === 'number'
        ? `[${part}]`
        : /^[A-Za-z_][A-Za-z0-9_-]*$/.test(part)
          ? `${i === 0 ? '' : '.'}${part}`
          : `[${JSON.stringify(part)}]`,
    )
    .join('');
}

/** A refusal at `path`, of the resource the path is in when it is in one. */
export function refusalAt(path: EnvDocumentPath, message: string): EnvFileRefusal {
  const resource = path[0] === 'resources' && typeof path[1] === 'string' ? path[1] : undefined;
  return { path, ...(resource !== undefined ? { resource } : {}), message };
}

/**
 * JSON with every object's keys in one order, and no key whose value is
 * undefined: two documents that say the same thing in another order, or
 * with a key left out rather than empty, give the same text. Lists keep
 * their order, which is the order objects are written and values drawn in.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedKeys(value));
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => [key, sortedKeys(object[key])]),
  );
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ─── The lines ───────────────────────────────────────────────────────────────

/** The characters of an answer an error quotes, the first of it. */
export const ANSWER_EXCERPT_CHARS = 200;

/**
 * A value of a line: never one a script would take for a flag, the rule the
 * MCP server keeps for every value it puts on a line.
 */
export function valueOf(flag: string, value: string): string {
  if (value === '' || value.startsWith('-')) {
    throw new Error(`${flag} cannot be "${value}": a value that starts with "-" reads as a flag.`);
  }
  return value;
}

// ─── The answers ─────────────────────────────────────────────────────────────

/** A Salesforce id, as every id an answer names is: a run's records, an org, a user. */
export const idSchema = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/);

export const countSchema = z.number().int().nonnegative();

/** One object of a removal, as the removal brick answers it: `ForgeUndoObjectResult`. */
export const removalObjectSchema = z.object({
  objectApiName: z.string().min(1),
  planned: countSchema,
  deleted: countSchema,
  alreadyGone: countSchema,
  keptChanged: countSchema,
  keptDependents: countSchema,
  refused: countSchema,
  notVisible: countSchema.optional(),
  notReached: countSchema.optional(),
  heldBy: z.array(z.string()),
  reasons: z.array(z.string()),
});

/** One object of a removal preview: `RemovalPreviewObject`. */
export const previewObjectSchema = z.object({
  objectApiName: z.string().min(1),
  planned: countSchema,
  toDelete: countSchema,
  alreadyGone: countSchema,
  changedSince: countSchema,
  keptChanged: countSchema,
  changedBy: z.record(idSchema, countSchema),
  undeletable: countSchema,
  notVisible: countSchema,
  unread: countSchema,
  reasons: z.array(z.string()),
});

/** What a removal preview says, whichever script gave it: the brick's reading before its first write. */
export const removalPreviewSchema = z.object({
  planned: countSchema,
  objects: z.array(previewObjectSchema),
  undeletable: z
    .array(z.object({ objectApiName: z.string().min(1), records: countSchema }))
    .optional(),
  userNames: z.record(idSchema, z.string()),
});

/** The removal preview of a run, as a plan reads it, whichever kind's script answered. */
export interface EnvPreviewRead {
  preview: z.infer<typeof removalPreviewSchema>;
  /** What a removal run now would be refused for, each in its own words. */
  refusals: string[];
}

/** One object of a removal's answer, whichever kind's script answered. */
export type EnvRemovalObject = z.infer<typeof removalObjectSchema>;

/** What a dry run counted, read the same way for every kind. */
export interface EnvDryRunCount {
  /** Per object, the records a run would write. */
  objects: Array<{ object: string; wouldCreate: number; atMost?: true }>;
  /** In all: what a run of the resource is held to. */
  total: number;
  /** What a run that writes whole creates: fewer is a partial run. */
  created: number;
  /** The API requests its writes would take; absent when the script gives no estimate. */
  apiRequests?: number;
  storageBytes: number;
  emails: Array<{ limit: EnvEmailLimit; emails: number }>;
  /** What the script says a real run would be refused for now. */
  refusal?: string;
}

/** What a run wrote, per object, read the same way for every kind. */
export interface EnvRunCount {
  objects: Array<{ object: string; created: number; refused: number; errors: string[] }>;
  /** The records it created, in all. */
  created: number;
}

/** An answer a step's script printed that does not read as the one asked for. */
export class StepAnswerError extends Error {
  constructor(
    /** The script that answered. */
    readonly script: RunnableScript,
    /** What its answer was read as. */
    readonly expected: string,
    /** Why it does not read as that. */
    readonly reason: string,
    /** The first {@link ANSWER_EXCERPT_CHARS} characters of what it printed. */
    readonly excerpt: string,
  ) {
    super(
      `${script} did not answer ${expected} (${reason}): ` +
        (excerpt === '' ? 'it printed nothing on stdout' : `it printed ${JSON.stringify(excerpt)}`),
    );
    this.name = 'StepAnswerError';
  }
}

/** `stdout` read with `schema`, or a {@link StepAnswerError} that names the script and quotes it. */
export function readAnswer<T>(
  script: RunnableScript,
  expected: string,
  schema: z.ZodType<T>,
  stdout: string,
): T {
  const excerpt = stdout.trim().slice(0, ANSWER_EXCERPT_CHARS);
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new StepAnswerError(script, expected, 'not JSON', excerpt);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || 'the answer';
    throw new StepAnswerError(
      script,
      expected,
      `${where}: ${issue?.message ?? 'refused'}`,
      excerpt,
    );
  }
  return parsed.data;
}
