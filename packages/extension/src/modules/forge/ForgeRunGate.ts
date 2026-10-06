/**
 * What a Forge run is held to before it writes into an org: what the target
 * runs as the run inserts its records, how many records it writes, and the
 * data storage they take there.
 *
 * Run for real, a clone whose dry run said 37 records wrote 34 216 into a
 * client sandbox — a parent added to its graph widened what was read of its
 * children — and stopped only when the sandbox's data storage ran out.
 * Nothing had looked at either figure before the first write, and the flows
 * the target ran on every record it created were said and never asked about.
 * The executor now hands its caller every row it is about to write before the
 * first one goes (`ExecuteOptions.beforeWrite`), and the extension and the
 * command line hold them here to the same measures: the extension asks past
 * a volume, the command refuses past `--max-total`, and both refuse rows the
 * target has no storage left for.
 *
 * Kept apart from the executor, so the bridge reads it without loading it.
 */

import { z } from 'zod';
import { BYTES_PER_MB, automationByWrite, orgTypeToGuardTier } from '@sandforge/shared';
import type { ForgeRunGateCode, ForgeRunGateStop, ForgeTargetAutomation } from '@sandforge/shared';
import {
  ACCOUNT,
  CONTACT,
  EMAIL_MESSAGE,
  isPersonAccountRow,
} from '../../core/common/platformRecords.js';
import type {
  AutomationConfirmation,
  FiredOnInsert,
  SafetyTier,
  WriteConfirmationStorage,
} from '../../core/precheck/ProductionGuard.js';
import type { ForgeWriteBoundary } from './ForgeExecutor.js';

/**
 * Whether an org's edition, as `Organization.OrganizationType` gives it, is a
 * Developer Edition org's — a Trailhead playground is one.
 *
 * Such an org says `IsSandbox` false, and is registered as a production org,
 * while it holds nobody's business: refused as one, it left those who try
 * SandForge with no sandbox of their own nowhere to clone into.
 */
export function isDeveloperEdition(edition: unknown): boolean {
  return typeof edition === 'string' && edition.trim().toLowerCase() === 'developer edition';
}

/**
 * The tier a Forge run takes its target for: the guard's tier of the org's
 * type, except a Developer Edition org, which the guard reads as production,
 * taken for the development org it is. An org whose edition is not known
 * stays production, as an org of unknown type does to the guard.
 *
 * @param orgType - The type the org was registered with.
 * @param edition - Its edition, as kept when it was connected.
 */
export function forgeTargetTier(orgType: string, edition: unknown): SafetyTier {
  const tier = orgTypeToGuardTier(orgType);
  return tier === 'production' && isDeveloperEdition(edition) ? 'development' : tier;
}

/** The volume past which the extension asks before a run writes (`sandforge.safety.confirmAboveRecords`). */
export const DEFAULT_CONFIRM_ABOVE_RECORDS = 2_000;

/** The most records a command-line clone writes unless `--max-total` says otherwise. */
export const DEFAULT_MAX_TOTAL = 10_000;

/**
 * Share of the data storage the target has left past which a run is said to
 * come near it. Salesforce counts storage a while after a load, so what an
 * org says it has left right after one is more than it has: the margin is
 * kept for that.
 */
export const STORAGE_NEAR_SHARE = 0.8;

const KB = 1024;

/*
 * The data storage a record takes, as Salesforce documents it
 * (help.salesforce.com, knowledge article 000383664, "Data and file storage
 * allocations"): most records take 2 KB whatever their fields hold; a person
 * account 4 KB, being an account and a contact; a campaign 8 KB; a campaign
 * member 1 KB; an article 4 KB, and more with rich text; an email message its
 * actual size.
 */
const RECORD_BYTES = 2 * KB;
const PERSON_ACCOUNT_BYTES = 4 * KB;
const CAMPAIGN_BYTES = 8 * KB;
const CAMPAIGN_MEMBER_BYTES = 1 * KB;
const ARTICLE_BYTES = 4 * KB;

/** A text field holds 255 characters at most: a longer value is a long or rich text area's. */
const TEXT_FIELD_MAX = 255;

/** The article versions of Salesforce Knowledge, `Knowledge__kav` and its kind. */
const ARTICLE_OBJECT = /__kav$/i;

/** The bytes the text values of a row take. */
function textBytes(row: Record<string, unknown>, longerThan = 0): number {
  let bytes = 0;
  for (const value of Object.values(row)) {
    if (typeof value === 'string' && value.length > longerThan) {
      bytes += Buffer.byteLength(value, 'utf8');
    }
  }
  return bytes;
}

/**
 * The data storage one row of `objectApiName` takes once written, by the
 * documented sizes. The contact of a person account takes none of its own:
 * the 4 KB of its account count both, and the platform writes it with the
 * account.
 */
export function rowStorageBytes(objectApiName: string, row: Record<string, unknown>): number {
  if (objectApiName === EMAIL_MESSAGE) return textBytes(row);
  if (objectApiName === ACCOUNT) {
    return isPersonAccountRow(row) ? PERSON_ACCOUNT_BYTES : RECORD_BYTES;
  }
  if (objectApiName === CONTACT && isPersonAccountRow(row)) return 0;
  if (objectApiName === 'Campaign') return CAMPAIGN_BYTES;
  if (objectApiName === 'CampaignMember') return CAMPAIGN_MEMBER_BYTES;
  // The rich text an article holds is counted as the long values it has: a
  // long text area counted with it says a little too much, never too little.
  if (ARTICLE_OBJECT.test(objectApiName)) return ARTICLE_BYTES + textBytes(row, TEXT_FIELD_MAX);
  return RECORD_BYTES;
}

/** What a run is about to write of one object. */
export interface WritePlanObject {
  objectApiName: string;
  rows: number;
  storageBytes: number;
}

/** What a run is about to write: per object, the most first, and in all. */
export interface WritePlan {
  objects: WritePlanObject[];
  totalRows: number;
  storageBytes: number;
}

/** The rows a run is about to write, counted and measured. An object with none is left out. */
export function writePlanOf(objects: ForgeWriteBoundary['objects']): WritePlan {
  const measured = objects
    .filter(({ rows }) => rows.length > 0)
    .map(({ objectApiName, rows }) => ({
      objectApiName,
      rows: rows.length,
      storageBytes: rows.reduce((sum, row) => sum + rowStorageBytes(objectApiName, row), 0),
    }))
    .sort((a, b) => b.rows - a.rows || a.objectApiName.localeCompare(b.objectApiName));
  return {
    objects: measured,
    totalRows: measured.reduce((sum, object) => sum + object.rows, 0),
    storageBytes: measured.reduce((sum, object) => sum + object.storageBytes, 0),
  };
}

/** What an org says of its data storage, in MB. */
export interface DataStorage {
  maxMB: number;
  remainingMB: number;
}

/** The part of a connection reading an org's limits needs. */
export interface LimitsTransport {
  request(request: { method: 'GET'; url: string }): Promise<unknown>;
}

/** What `/limits` says of an org's data storage. */
const dataStorageSchema = z
  .object({
    DataStorageMB: z.object({ Max: z.number(), Remaining: z.number() }).loose(),
  })
  .loose();

/**
 * The data storage an org has, as its `/limits` say. The org may refuse it to
 * the user the run writes as; the caller says so, and never takes it for
 * enough.
 */
export async function readDataStorage(transport: LimitsTransport): Promise<DataStorage> {
  const limits = dataStorageSchema.parse(
    await transport.request({ method: 'GET', url: '/limits' }),
  );
  return {
    maxMB: limits.DataStorageMB.Max,
    remainingMB: limits.DataStorageMB.Remaining,
  };
}

/** What the rows take against what the target has left, or why that could not be told. */
export type StorageCheck =
  | {
      verdict: 'fits' | 'near' | 'exceeds';
      estimateMB: number;
      maxMB: number;
      remainingMB: number;
    }
  | { verdict: 'unread'; estimateMB: number; unread: string };

/**
 * The rows' storage against the target's: `exceeds` past what it has left,
 * `near` past {@link STORAGE_NEAR_SHARE} of it, `unread` when the target did
 * not say.
 */
export function storageCheckOf(
  plan: Pick<WritePlan, 'storageBytes'>,
  storage: DataStorage | { unread: string },
): StorageCheck {
  const estimateMB = plan.storageBytes / BYTES_PER_MB;
  if ('unread' in storage) return { verdict: 'unread', estimateMB, unread: storage.unread };
  const { maxMB, remainingMB } = storage;
  const verdict =
    plan.storageBytes > remainingMB * BYTES_PER_MB
      ? 'exceeds'
      : plan.storageBytes > STORAGE_NEAR_SHARE * remainingMB * BYTES_PER_MB
        ? 'near'
        : 'fits';
  return { verdict, estimateMB, maxMB, remainingMB };
}

/** The storage of a check, as the confirmation says it. */
export function confirmationStorageOf(check: StorageCheck): WriteConfirmationStorage {
  return check.verdict === 'unread'
    ? { estimateMB: check.estimateMB, unread: check.unread }
    : {
        estimateMB: check.estimateMB,
        maxMB: check.maxMB,
        remainingMB: check.remainingMB,
        near: check.verdict === 'near',
      };
}

/**
 * Megabytes as the gate says them: rounded up, as an estimate that errs says
 * too much rather than too little, to two decimals under 10 MB.
 */
export function formatMB(megabytes: number): string {
  if (megabytes <= 0) return '0';
  const factor = megabytes < 10 ? 100 : 10;
  // The epsilon keeps a value the float holds a hair above its decimal —
  // 4.69 × 100 is 469.00000000000006 — from rounding up a step.
  return (Math.ceil(megabytes * factor - 1e-9) / factor).toString();
}

/** What fires in the target as a run inserts its records, per object. */
export function firedOnInsertOf(
  automation: Pick<ForgeTargetAutomation, 'objects'>,
): FiredOnInsert[] {
  return automation.objects.flatMap((object) =>
    (automationByWrite(object).find((entry) => entry.write === 'insert')?.fired ?? []).map(
      (fired) => ({ objectApiName: object.objectApiName, kind: fired.kind, name: fired.name }),
    ),
  );
}

/**
 * The custom permissions that keep a flow firing on insert from starting for
 * the user who holds them, each once.
 */
export function insertBypassesOf(automation: Pick<ForgeTargetAutomation, 'objects'>): string[] {
  const names = automation.objects.flatMap((object) =>
    (automationByWrite(object).find((entry) => entry.write === 'insert')?.fired ?? []).flatMap(
      (fired) => (fired.flow?.permissions ?? []).filter((p) => p.bypass).map((p) => p.name),
    ),
  );
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * What could not be read of what fires on insert. A start condition that
 * could not be read leaves its flow listed as firing, so it is not among them.
 */
export function automationUnreadOf(
  automation: Pick<ForgeTargetAutomation, 'unread'>,
): AutomationConfirmation['unread'] {
  return automation.unread.flatMap(({ part, reason }) =>
    part === 'conditions' ? [] : [{ part, reason }],
  );
}

/** The codes a run's gate stops it with: the extension's, and the command line's own. */
export type ForgeRunGateErrorCode =
  ForgeRunGateCode | 'MAX_TOTAL_EXCEEDED' | 'AUTOMATION_NOT_ACCEPTED';

/**
 * Raised when a run's gate stops it: before it reads anything, or once it has
 * read the rows it was about to write and before it writes the first. Nothing
 * was written.
 */
export class ForgeRunGateError extends Error {
  readonly code: ForgeRunGateErrorCode;
  /** For a refusal for storage: what the rows take, and what the target had left, in MB. */
  readonly storage?: { estimateMB: number; remainingMB: number };

  constructor(
    code: ForgeRunGateErrorCode,
    message: string,
    storage?: { estimateMB: number; remainingMB: number },
  ) {
    super(message);
    this.name = 'ForgeRunGateError';
    this.code = code;
    if (storage) this.storage = storage;
  }

  /** The stop as the page is told it; none for a code of the command line's own. */
  get stop(): ForgeRunGateStop | undefined {
    if (this.code === 'MAX_TOTAL_EXCEEDED' || this.code === 'AUTOMATION_NOT_ACCEPTED') {
      return undefined;
    }
    return this.storage ? { code: this.code, storage: this.storage } : { code: this.code };
  }
}

/**
 * Whether `error` is a run's gate stop. Read by its name as well as its class:
 * thrown from inside the executor, it reaches the bridge through the
 * orchestrator, and what is said of it must not hang on one module instance.
 */
export function isForgeRunGateError(error: unknown): error is ForgeRunGateError {
  return (
    error instanceof ForgeRunGateError ||
    (error instanceof Error &&
      error.name === 'ForgeRunGateError' &&
      typeof (error as { code?: unknown }).code === 'string')
  );
}

/** Why the rows cannot be written for the storage they take, or nothing when they can. */
export function storageRefusal(check: StorageCheck, target: string): string | undefined {
  if (check.verdict !== 'exceeds') return undefined;
  return (
    `The records to write take about ${formatMB(check.estimateMB)} MB of data storage, and ` +
    `${target} has ${check.remainingMB} MB left of ${check.maxMB} MB: leave objects out, ` +
    `lower the records per object, or free data storage in ${target}.`
  );
}

/** The objects a list names before it says how many more it leaves out. */
const LISTED_OBJECTS = 10;

/**
 * What the command line says of the rows it is about to write: how many per
 * object, the storage they take, and what the target has left.
 */
export function writePlanLines(plan: WritePlan, check: StorageCheck, target: string): string[] {
  const lines = [
    `write gate: ${plan.totalRows} record(s) to write to ${target}, about ` +
      `${formatMB(check.estimateMB)} MB of data storage`,
  ];
  for (const object of plan.objects.slice(0, LISTED_OBJECTS)) {
    lines.push(`  ${object.objectApiName.padEnd(42)}${String(object.rows).padStart(8)}`);
  }
  const rest = plan.objects.slice(LISTED_OBJECTS);
  if (rest.length > 0) {
    const rows = rest.reduce((sum, object) => sum + object.rows, 0);
    lines.push(`  and ${rest.length} more object(s), ${rows} record(s)`);
  }
  if (check.verdict === 'unread') {
    lines.push(
      `  the data storage ${target} has left could not be read (${check.unread}): ` +
        'whether the records fit is not known',
    );
    return lines;
  }
  lines.push(`  data storage of ${target}: ${check.remainingMB} MB left of ${check.maxMB} MB`);
  if (check.verdict === 'near') {
    lines.push(
      `  that is more than ${Math.round(STORAGE_NEAR_SHARE * 100)} % of what ${target} has left: ` +
        'Salesforce counts storage a while after a load, so less may be left than it says',
    );
  }
  return lines;
}

/** How the command line names a part of the automation it could not read. */
const UNREAD_WORDS: Record<AutomationConfirmation['unread'][number]['part'], string> = {
  flows: 'the flows',
  triggers: 'the Apex triggers',
  automation: 'the automation',
};

/**
 * Why the command line will not write without `--accept-automation`: what the
 * target runs as the clone inserts its records, named, or what of it could not
 * be read. Nothing when nothing fires and everything was read.
 */
export function automationRefusal(
  automation: Pick<ForgeTargetAutomation, 'objects' | 'unread'>,
  target: string,
): string | undefined {
  const fired = firedOnInsertOf(automation);
  const unread = automationUnreadOf(automation);
  if (fired.length === 0 && unread.length === 0) return undefined;
  const parts: string[] = [];
  if (fired.length > 0) {
    const named = fired.map(
      ({ objectApiName, kind, name }) =>
        `${objectApiName}: ${kind === 'flow' ? `flow "${name}"` : `Apex trigger ${name}`}`,
    );
    parts.push(`${target} runs automation on the records this clone inserts: ${named.join('; ')}.`);
  }
  for (const { part, reason } of unread) {
    parts.push(
      `${UNREAD_WORDS[part][0].toUpperCase()}${UNREAD_WORDS[part].slice(1)} of ${target} ` +
        `could not be read (${reason}), so what fires as the clone inserts is not known.`,
    );
  }
  parts.push(
    `Nothing was written. Add --accept-automation to clone all the same, or turn that ` +
      `automation off in ${target} first.`,
  );
  return parts.join(' ');
}
