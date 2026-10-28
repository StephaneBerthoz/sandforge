import * as z from 'zod';

/**
 * Zod schemas of a checkpoint's file and of the ids and names the
 * `checkpoint:*` messages carry.
 *
 * `checkpoint.json` is parsed with {@link orgCheckpointSchema} on every read,
 * and a file it refuses is listed as damaged, never used: the rewind plans its
 * deletions from what the file says the snapshot holds. Its inferred type is
 * `OrgCheckpoint` (`types/checkpoint.types.ts`), pinned by the types' test.
 *
 * The three ids name folders on this machine — `<checkpointId>/`,
 * `previews/<previewId>/`, `rewinds/<rewindId>/` — so each is one fixed shape
 * of lowercase letters, digits and dashes: a separator, a dot or a drive
 * letter in an id from a message or a file never reaches a path.
 */

/** `<prefix>-YYYYMMDD-HHMMSS-xxxx`: the shape of every id a checkpoint's folders are named by. */
function folderIdSchema(prefix: 'ck' | 'pv' | 'rw') {
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}-\\d{8}-\\d{6}-[a-z0-9]{4}$`),
      `Expected an id shaped ${prefix}-YYYYMMDD-HHMMSS-xxxx`,
    );
}

/** A checkpoint's id: `ck-20261022-140512-a1b2`. */
export const checkpointIdSchema = folderIdSchema('ck');

/** A preview's id: `pv-20261022-141030-c3d4`. */
export const previewIdSchema = folderIdSchema('pv');

/** A rewind's id, which its journal's folder is named by: `rw-20261022-141102-e5f6`. */
export const rewindIdSchema = folderIdSchema('rw');

/** An Organization Id, 15 or 18 characters: the folder an org's checkpoints are filed in. */
export const checkpointOrganizationIdSchema = z
  .string()
  .regex(/^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/, 'Not an Organization Id');

/** A User Id, 15 or 18 characters. */
const userIdSchema = z.string().regex(/^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/, 'Not a User Id');

/** An object's or a field's API name, namespaced ones included. */
const apiNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Not a Salesforce API name')
  .max(80);

/**
 * A field named with its object, `Case.Last_Touched__c`: how the fields a
 * checkpoint does not compare are named, by its file and by the messages that
 * change them.
 */
export const checkpointFieldKeySchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/, 'Expected an Object.Field name')
  .max(161);

/**
 * The fields a checkpoint does not compare, each named once: the list its file
 * holds, and the one a message replaces it with.
 */
export const checkpointIgnoredFieldsSchema = z
  .array(checkpointFieldKeySchema)
  .max(1000)
  .refine((fields) => new Set(fields).size === fields.length, 'A field is listed twice');

/**
 * What a checkpoint is called. A line of text: a control character — a line
 * break among them — would split the line the command line lists it on.
 */
export const checkpointNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((name) => !/\p{Cc}/u.test(name), 'A checkpoint name is one line of text');

/** An instant, ISO 8601 with its zone: what `getServerTimestamp` answers, and `toISOString()`. */
const instantSchema = z.iso.datetime({ offset: true });

const countSchema = z.number().int().nonnegative();

/** A sha256, hex. */
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a sha256, hex');

/** A SandForge version as its package names it: `1.70.0`, a pre-release tag allowed. */
const sandforgeVersionSchema = z
  .string()
  .regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/, 'Not a SandForge version');

export const checkpointOrgTierSchema = z.enum(['sandbox', 'scratch', 'developer']);
export const checkpointScopeModeSchema = z.enum(['everything', 'picked']);
export const checkpointReadModeSchema = z.enum(['query', 'scanAllLive']);
export const checkpointLeftOutFieldReasonSchema = z.enum([
  'fls',
  'encrypted',
  'base64',
  'compound',
]);
export const checkpointStatusSchema = z.enum(['taking', 'ready', 'failed']);
export const checkpointCustomSettingKindSchema = z.enum(['hierarchy', 'list']);

const checkpointObjectSchema = z.object({
  objectApiName: apiNameSchema,
  records: countSchema,
  inBin: countSchema,
  readOrder: countSchema,
  readMode: checkpointReadModeSchema,
  undeletable: z.boolean(),
  cascadeParents: z.array(apiNameSchema).max(1000),
  // Absent from a checkpoint taken before they were kept.
  restrictParents: z.array(apiNameSchema).max(1000).optional(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a sha256, hex'),
  fields: z.array(apiNameSchema).max(5000),
  leftOutFields: z
    .array(z.object({ field: apiNameSchema, reason: checkpointLeftOutFieldReasonSchema }))
    .max(5000),
  // Absent for any object but a custom setting held by name, and from a
  // checkpoint taken before custom settings could be held.
  customSetting: checkpointCustomSettingKindSchema.optional(),
});

/**
 * What a checkpoint holds of the org's files beside its objects, in its
 * folder's `files/`: how many files and links, and the objects whose links
 * were read by lists of ids. A file held is one a link ties to a record of
 * the checkpoint, or one its snapshot holds: never more anchored than held.
 */
const checkpointFilesSchema = z
  .object({
    documents: countSchema,
    links: countSchema,
    anchored: countSchema,
    readByIds: z.array(apiNameSchema).min(1).max(10_000).optional(),
  })
  .refine((files) => files.anchored <= files.documents, {
    path: ['anchored'],
    message: 'More files anchored than held',
  });

/** `checkpoint.json`, version 1. */
export const orgCheckpointSchema = z
  .object({
    version: z.literal(1),
    checkpointId: checkpointIdSchema,
    name: checkpointNameSchema,
    org: z.object({
      organizationId: checkpointOrganizationIdSchema,
      alias: z.string().min(1).max(255).optional(),
      username: z.string().min(1).max(255),
      instanceUrl: z.url(),
      isSandbox: z.boolean(),
      organizationType: z.string().min(1).max(120),
      tier: checkpointOrgTierSchema,
      scratchExpiresAt: z.union([z.iso.date(), instantSchema]).optional(),
    }),
    takenBy: z.object({
      userId: userIdSchema,
      automatedProcessUserId: userIdSchema.optional(),
      viewAllData: z.literal(true),
      modifyAllData: z.literal(true),
      // Absent from a checkpoint taken before files were held.
      queryAllFiles: z.boolean().optional(),
    }),
    readFrom: instantSchema,
    takenAt: instantSchema,
    scope: z.object({
      mode: checkpointScopeModeSchema,
      leftOut: z
        .array(z.object({ objectApiName: apiNameSchema, reason: z.string().min(1).max(500) }))
        .max(10_000),
    }),
    objects: z
      .array(checkpointObjectSchema)
      .max(10_000)
      .refine(
        (objects) => new Set(objects.map((object) => object.objectApiName)).size === objects.length,
        'An object is in the checkpoint twice',
      ),
    ignoredFields: checkpointIgnoredFieldsSchema,
    snapshotId: z.string().min(1).max(200),
    movedWhileTaken: z.object({ changed: countSchema, deleted: countSchema, created: countSchema }),
    bytes: countSchema,
    expiresAt: instantSchema.nullable(),
    status: checkpointStatusSchema,
    takenOn: z.object({ host: z.string().min(1).max(255), pid: countSchema }),
    lastRewind: z
      .object({
        rewindId: rewindIdSchema,
        endedAt: instantSchema.optional(),
        undoUntil: instantSchema.optional(),
        undoneAt: instantSchema.optional(),
      })
      .optional(),
    // Absent from a checkpoint taken before files were held, or whose scope
    // left them out: its rewind leaves files added since where they are.
    files: checkpointFilesSchema.optional(),
    // Set on a checkpoint imported from another machine's export alone.
    importedFrom: z
      .object({
        at: instantSchema,
        sandforgeVersion: sandforgeVersionSchema,
        sha256: sha256Schema,
      })
      .optional(),
  })
  // T1 follows every read of the take, and the rewind's deletions keep every
  // record created before it: a T1 before T0 would move that boundary back
  // past records the snapshot holds.
  .refine((checkpoint) => Date.parse(checkpoint.readFrom) <= Date.parse(checkpoint.takenAt), {
    path: ['takenAt'],
    message: 'A checkpoint ends after it begins',
  });

// ─── A checkpoint as a file that leaves the machine (.sfcheckpoint) ──────────

/**
 * What a `.sfcheckpoint` file's first line says of the SandForge and the
 * formats that made it, read before the rest of the line: a file a newer
 * SandForge made is told as such, whatever else its line holds.
 */
export const checkpointArchiveVersionsSchema = z
  .object({
    format: z.literal('sandforge-checkpoint'),
    formatVersion: z.number().int().positive().max(1_000_000),
    checkpointFormat: z.number().int().positive().max(1_000_000),
    sandforgeVersion: sandforgeVersionSchema,
  })
  .loose();

/**
 * The first line of a `.sfcheckpoint` file, in the formats this SandForge
 * reads: `CheckpointArchiveHeader` (`types/checkpoint.types.ts`), pinned by
 * the types' test.
 */
export const checkpointArchiveHeaderSchema = z.object({
  format: z.literal('sandforge-checkpoint'),
  formatVersion: z.literal(1),
  checkpointFormat: z.literal(1),
  sandforgeVersion: sandforgeVersionSchema,
  organizationId: checkpointOrganizationIdSchema,
  orgTier: checkpointOrgTierSchema,
  checkpointId: checkpointIdSchema,
  takenAt: instantSchema,
  records: countSchema,
  objects: countSchema,
  files: countSchema,
  bytes: countSchema,
  cipher: z.literal('aes-256-gcm'),
  kdf: z.literal('hkdf-sha256'),
  salt: z.string().regex(/^[0-9a-f]{64}$/, 'Expected 32 bytes, hex'),
  noncePrefix: z.string().regex(/^[0-9a-f]{16}$/, 'Expected 8 bytes, hex'),
  keyCheck: z.string().regex(/^[0-9a-f]{32}$/, 'Expected 16 bytes, hex'),
  chunkBytes: z
    .number()
    .int()
    .min(4096)
    .max(16 * 1024 * 1024),
});
