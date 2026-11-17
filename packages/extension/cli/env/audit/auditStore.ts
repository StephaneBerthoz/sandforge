/**
 * The inventories of scheduled jobs `env audit --save` keeps on this
 * machine, to compare an org's jobs with what they were before its refresh.
 *
 * ```
 * <journal>/audits/                       0700
 *   <host>/                               0700  the host the org answered on
 *     <instant>-<organizationId>.json     0600  written beside, then renamed over
 * ```
 *
 * They are filed by the org's host, not its Organization Id: a refresh
 * changes the Id and keeps the host (`acme--uat.sandbox.my.salesforce.com`),
 * so the inventory taken the eve of a refresh is found the morning after.
 * The Organization Id is kept inside, and the comparison takes the newest
 * inventory of the same host under **another** Id — the sandbox before its
 * refresh — first; one of the same Id, taken since, says no refresh. An
 * inventory of another host is never compared.
 *
 * An inventory keeps, of each job, its name, its type, its expression, its
 * state, its dates and the username of the user it runs as: no address, no
 * record of the org's data. A file that does not read is set aside in what
 * the read answers, never taken for an inventory.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as z from 'zod';
import { checkpointOrganizationIdSchema } from '@sandforge/shared';
import { organizationKey } from '../../../src/modules/checkpoint/OrgCheckpointStore.js';

/** What a folder of the inventories is made with: its owner alone lists them. */
export const AUDIT_DIR_MODE = 0o700;

/** What an inventory is written with: its owner alone reads it. */
export const AUDIT_FILE_MODE = 0o600;

/** The most jobs an inventory keeps, as the audit's answer names them at most. */
export const AUDIT_MAX_JOBS = 10_000;

/** A host name, as a folder of the inventories is named: no path, no traversal. */
const HOST_NAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** An inventory's file, in its host's folder. */
const INVENTORY_FILE = /^\d{8}T\d{9}Z-00D[A-Za-z0-9]{15}\.json$/;

const instantSchema = z.iso.datetime({ offset: true });

/** A job as an inventory keeps it: never its owner's address. */
const inventoryJobSchema = z.strictObject({
  /** `CronJobDetail.Name`. */
  name: z.string().min(1).max(255),
  /** As Setup names it: Scheduled Apex, Batch Job… */
  type: z.string().min(1).max(80),
  cronExpression: z.string().min(1).max(255).optional(),
  /** `CronTrigger.State`: WAITING, PAUSED, COMPLETE… */
  state: z.string().min(1).max(40),
  nextFireTime: instantSchema.optional(),
  previousFireTime: instantSchema.optional(),
  /** The username of the user it runs as. */
  owner: z.string().min(1).max(255).optional(),
});

/** An inventory of an org's scheduled jobs, as `--save` keeps it. */
export const auditInventorySchema = z.strictObject({
  version: z.literal(1),
  savedAt: instantSchema,
  organizationId: checkpointOrganizationIdSchema,
  host: z.string().regex(HOST_NAME),
  jobs: z.array(inventoryJobSchema).max(AUDIT_MAX_JOBS),
});

export type AuditInventory = z.infer<typeof auditInventorySchema>;
export type AuditInventoryJob = z.infer<typeof inventoryJobSchema>;

/** An inventory kept, and where. */
export interface AuditInventoryKept {
  inventory: AuditInventory;
  path: string;
}

/** The inventories of a host, and the files of its folder that do not read as one. */
export interface AuditInventoriesRead {
  kept: AuditInventoryKept[];
  /** Each file set aside, with why. */
  setAside: Array<{ path: string; why: string }>;
  /** Why the folder itself could not be read. */
  unread?: string;
}

/** The inventory a comparison is made against, and whether it is of the org before its refresh. */
export interface AuditAgainst {
  kept: AuditInventoryKept;
  /** Of another Organization Id under the same host: the sandbox before its refresh. */
  refreshed: boolean;
}

/** The folder of the inventories, in the journal directory. */
export function auditStoreOf(journalDir: string): string {
  return join(resolve(journalDir), 'audits');
}

/** A host as the inventories file it: lower case, without the dot a host may end with. */
export function auditHostKey(host: string): string | undefined {
  const key = host.trim().toLowerCase().replace(/\.$/, '');
  return HOST_NAME.test(key) ? key : undefined;
}

/** The folder of a host's inventories. */
export function auditHostFolderOf(journalDir: string, host: string): string {
  const key = auditHostKey(host);
  if (key === undefined) throw new Error(`Not a host name: "${host}"`);
  return join(auditStoreOf(journalDir), key);
}

/** The file an inventory is kept in: when it was saved, and of which org, without a colon. */
export function inventoryFileOf(
  inventory: Pick<AuditInventory, 'savedAt' | 'organizationId'>,
): string {
  const stamp = new Date(inventory.savedAt).toISOString().replace(/[-:.]/g, '');
  return `${stamp}-${organizationKey(inventory.organizationId)}.json`;
}

/**
 * Keep an inventory in its host's folder: written whole into a file of its
 * own beside it, made for this write alone and its owner's, flushed to the
 * disk, then renamed into place.
 *
 * @returns Where it is kept.
 */
export async function saveInventory(
  journalDir: string,
  inventory: AuditInventory,
): Promise<string> {
  const checked = auditInventorySchema.parse(inventory);
  const folder = auditHostFolderOf(journalDir, checked.host);
  await mkdir(folder, { recursive: true, mode: AUDIT_DIR_MODE });
  const file = join(folder, inventoryFileOf(checked));
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', AUDIT_FILE_MODE);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(checked, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (err: unknown) {
    await rm(temp, { force: true });
    throw err;
  }
  return file;
}

/**
 * The inventories kept of a host, newest first. A file that does not read,
 * or that names another host than its folder, is set aside with why; a
 * folder not there is no inventory, and one that cannot be read says why.
 */
export async function readInventories(
  journalDir: string,
  host: string,
): Promise<AuditInventoriesRead> {
  const key = auditHostKey(host);
  if (key === undefined) return { kept: [], setAside: [], unread: `${host} is not a host name` };
  const folder = join(auditStoreOf(journalDir), key);
  let names: string[];
  try {
    names = (await readdir(folder, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kept: [], setAside: [] };
    return {
      kept: [],
      setAside: [],
      unread: `${folder} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const kept: AuditInventoryKept[] = [];
  const setAside: AuditInventoriesRead['setAside'] = [];
  for (const name of names) {
    const path = join(folder, name);
    if (!INVENTORY_FILE.test(name)) {
      setAside.push({ path, why: 'its name is not one --save gives' });
      continue;
    }
    let content: unknown;
    try {
      content = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      setAside.push({ path, why: 'it does not read as JSON' });
      continue;
    }
    const parsed = auditInventorySchema.safeParse(content);
    if (!parsed.success) {
      setAside.push({ path, why: 'it does not read as an inventory of this SandForge' });
      continue;
    }
    if (parsed.data.host !== key) {
      setAside.push({
        path,
        why: `it is of ${parsed.data.host}, not of the host its folder names`,
      });
      continue;
    }
    kept.push({ inventory: parsed.data, path });
  }
  kept.sort((a, b) => Date.parse(b.inventory.savedAt) - Date.parse(a.inventory.savedAt));
  return { kept, setAside };
}

/**
 * The inventory the org's jobs are compared against: the newest of the same
 * host under another Organization Id — the sandbox before its refresh —, or
 * else the newest of the same org, which says no refresh. None when neither
 * is kept.
 *
 * @param kept - A host's inventories, newest first ({@link readInventories}).
 */
export function inventoryAgainst(
  kept: readonly AuditInventoryKept[],
  organizationId: string,
): AuditAgainst | undefined {
  const org = organizationKey(organizationId);
  const before = kept.find((one) => organizationKey(one.inventory.organizationId) !== org);
  if (before !== undefined) return { kept: before, refreshed: true };
  const same = kept[0];
  return same !== undefined ? { kept: same, refreshed: false } : undefined;
}
