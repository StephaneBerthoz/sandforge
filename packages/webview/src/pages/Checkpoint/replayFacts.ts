import type {
  CheckpointListEntry,
  CheckpointOrg,
  CheckpointReplayAnnexPart,
  CheckpointReplayChoices,
  CheckpointReplayListed,
  FrozenLoadPlanInfo,
  FrozenReplayInfo,
  OrgCheckpoint,
  SalesforceOrg,
} from '@sandforge/shared';
import { guardTierOf } from '@sandforge/shared';
import { formatNumber } from '../../utils/formatters';
import { frozenErrorWords, megabytes, type FrozenErrorPayload } from '../Frozen/frozenErrorWords';

/** Translates a key in the interface language. */
type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * A Developer Pro sandbox's data storage, in MB: past it, a sandbox is a
 * Partial Copy or a Full one, which may hold production's records. The
 * extension's own bound (`DEVELOPER_PRO_DATA_STORAGE_MB`), which its replay
 * guard refuses by: the page says before a simulation what the guard will.
 */
export const DEVELOPER_PRO_DATA_STORAGE_MB = 1024;

/**
 * Objects whose records hold a file's content, which no checkpoint keeps: a
 * replay never sets one up. The extension's own list (`FILE_CONTENT_OBJECTS`).
 */
const FILE_CONTENT_OBJECTS: ReadonlySet<string> = new Set([
  'contentdocument',
  'contentversion',
  'attachment',
  'document',
]);

/** Whether `objectApiName`'s records hold a file's content, which a checkpoint does not keep. */
export function holdsFileContent(objectApiName: string): boolean {
  return FILE_CONTENT_OBJECTS.has(objectApiName.toLowerCase());
}

/**
 * What a checkpoint's org says of the data it holds, as the take kept it:
 * none of production's (a scratch org, a Developer Edition org, a Developer
 * or Developer Pro sandbox), perhaps production's (a sandbox marked Staging,
 * a Partial Copy or a Full one, told by its data storage), or a sandbox's
 * that does not say — taken before SandForge 1.81.
 */
export type ReplaySourceData =
  | { kind: 'free' }
  | { kind: 'real'; why: 'staging' }
  | { kind: 'real'; why: 'storage'; mb: number }
  | { kind: 'unknown' };

/** See {@link ReplaySourceData}: the extension's replay guard reads the same. */
export function replaySourceDataOf(
  org: Pick<CheckpointOrg, 'tier' | 'dataStorageMaxMB' | 'staging'>,
): ReplaySourceData {
  if (org.staging === true) return { kind: 'real', why: 'staging' };
  if (org.tier !== 'sandbox') return { kind: 'free' };
  if (org.dataStorageMaxMB === undefined) return { kind: 'unknown' };
  return org.dataStorageMaxMB > DEVELOPER_PRO_DATA_STORAGE_MB
    ? { kind: 'real', why: 'storage', mb: org.dataStorageMaxMB }
    : { kind: 'free' };
}

/**
 * What a replay is asked before anything is picked: every object, owners
 * kept where the other org has them, no custom setting, emails and phone
 * numbers made unreachable — and masked when the data may be real, or does
 * not say: the guard refuses real data unmasked, and the person who knows a
 * sandbox's checkpoint holds none unticks it and says so.
 */
export function defaultReplayChoices(
  checkpoint: Pick<OrgCheckpoint, 'org'>,
): CheckpointReplayChoices {
  return {
    owners: 'same',
    customSettings: false,
    mask: replaySourceDataOf(checkpoint.org).kind !== 'free',
    contactPoints: 'neutralized',
    objects: [],
    excluded: [],
    link: [],
  };
}

/**
 * The choices as they are sent: the declaration that the checkpoint holds
 * no real data only where it lifts something — unmasked, of a sandbox that
 * does not say — so the audit trail never keeps one nobody needed to make.
 */
export function replayChoicesSent(
  checkpoint: Pick<OrgCheckpoint, 'org'>,
  choices: CheckpointReplayChoices,
): CheckpointReplayChoices {
  const { noRealData, ...rest } = choices;
  const declared =
    noRealData === true && !choices.mask && replaySourceDataOf(checkpoint.org).kind === 'unknown';
  return declared ? { ...rest, noRealData: true } : rest;
}

/**
 * What a simulation was asked, as one string: the org, the choices and
 * whether it replaces the last replay. A replay goes only after a simulation
 * of the same, and any change makes it ask for another.
 */
export function replayAskKey(
  targetOrgId: string,
  choices: CheckpointReplayChoices,
  replace: boolean,
): string {
  return JSON.stringify({
    targetOrgId,
    choices: {
      ...choices,
      objects: [...choices.objects].sort(),
      excluded: [...choices.excluded].sort(),
    },
    replace,
  });
}

/**
 * What else a simulation found a replay would be refused for, beside the
 * fields the other org requires and nothing fills (`LOAD_CONFIG`), each in the
 * page's words as that refusal alone is said — from what it names beside its
 * code — or in the host's when the page has none. The page said the fields
 * alone, and the storage the replay would then meet came a simulation later;
 * the command line said them all at once. Nothing beside any other refusal.
 *
 * @param aliasOf - The name the panel gives an org, by its registered id.
 */
export function refusedBesideWords(
  payload: FrozenErrorPayload | null,
  t: Translate,
  aliasOf: (orgId: string) => string,
): string[] {
  if (payload?.code !== 'LOAD_CONFIG' || !Array.isArray(payload.refusedBeside)) return [];
  return (payload.refusedBeside as unknown[]).flatMap((refused) => {
    if (typeof refused !== 'object' || refused === null) return [];
    const said = refused as FrozenErrorPayload;
    const words =
      frozenErrorWords(said, t, aliasOf, 'replay') ??
      (typeof said.message === 'string' ? said.message : undefined);
    return words !== undefined ? [words] : [];
  });
}

/** Records a replay would create, as its simulation counts them: what the replay is then held to. */
export function plannedRecords(plan: Pick<FrozenLoadPlanInfo, 'perObject'>): number {
  return plan.perObject.reduce((sum, object) => sum + object.toInsert, 0);
}

/** The objects of a checkpoint as the replay offers them: each with its records, and whether it can go. */
export interface ReplayObjectOffered {
  objectApiName: string;
  records: number;
  /** A file's content, which no checkpoint keeps: never replayed, said why. */
  fileContent: boolean;
  /** A custom setting the take held by name: set up only when asked. */
  customSetting: boolean;
}

/** See {@link ReplayObjectOffered}: in the checkpoint's order, those that hold records. */
export function replayObjectsOf(checkpoint: Pick<OrgCheckpoint, 'objects'>): ReplayObjectOffered[] {
  return checkpoint.objects
    .filter((object) => object.records > 0)
    .map((object) => ({
      objectApiName: object.objectApiName,
      records: object.records,
      fileContent: holdsFileContent(object.objectApiName),
      customSetting: object.customSetting !== undefined,
    }));
}

/** The orgs a replay may go into, as the page offers them. */
export interface ReplayTargets {
  /**
   * Sandboxes, scratch orgs and Developer Edition orgs that are connected,
   * those marked Staging among them: the refreshed one first.
   */
  offered: SalesforceOrg[];
  /** The checkpoint's own org, listed and not offered: Rewind brings it back instead. */
  own?: SalesforceOrg;
  /** The org the checkpoint's sandbox became once refreshed, when it is offered. */
  refreshed?: SalesforceOrg;
  /**
   * The ids of the offered sandboxes marked Staging, which may hold real
   * data: a replay goes into one once its name is typed to confirm it.
   */
  staging: string[];
}

/**
 * Where a checkpoint listed under `pageOrg` replays: every connected org a
 * load goes into, and the sandboxes marked Staging, set apart by their ids —
 * never a production org —, the page's org first when the checkpoint is of it
 * before a refresh, and set apart when the checkpoint still rewinds it.
 */
export function replayTargetsOf(
  orgs: readonly SalesforceOrg[],
  pageOrg: SalesforceOrg,
  entry: Pick<CheckpointListEntry, 'valid' | 'why'>,
): ReplayTargets {
  const connected = orgs.filter((org) => org.status === 'connected');
  const writable = connected.filter((org) => {
    const tier = guardTierOf(org);
    return tier === 'development' || tier === 'scratch' || tier === 'staging';
  });
  const ownStill = entry.valid;
  const refreshed =
    entry.why === 'refreshed' ? writable.find((org) => org.id === pageOrg.id) : undefined;
  const offered = writable.filter((org) => !(ownStill && org.id === pageOrg.id));
  if (refreshed)
    offered.sort((a, b) => (a.id === refreshed.id ? -1 : b.id === refreshed.id ? 1 : 0));
  const own = ownStill ? writable.find((org) => org.id === pageOrg.id) : undefined;
  const staging = offered.filter((org) => guardTierOf(org) === 'staging').map((org) => org.id);
  return { offered, ...(own ? { own } : {}), ...(refreshed ? { refreshed } : {}), staging };
}

/** The replay of a checkpoint into a registered org, as the list says it, when one is listed. */
export function replayInto(
  entry: Pick<CheckpointListEntry, 'replays'>,
  orgId: string,
): CheckpointReplayListed | undefined {
  return entry.replays?.find((replay) => replay.target.orgId === orgId);
}

/** The words a part of the annex a checkpoint lacks is named by. */
const ANNEX_PART_KEYS: Readonly<Record<CheckpointReplayAnnexPart, string>> = {
  recordTypes: 'checkpoint.replay.plan.part.recordTypes',
  users: 'checkpoint.replay.plan.part.users',
  queues: 'checkpoint.replay.plan.part.queues',
  standardPricebook: 'checkpoint.replay.plan.part.standardPricebook',
};

/** One line of what a replay says beside its plan or its report. */
export interface ReplayLine {
  /** Stable, for a test id and a key. */
  id: string;
  text: string;
  /** Something that does not go across as it was, or is refused. */
  warn?: true;
}

/**
 * What a replay says beside its load's plan or report, a line each, only
 * those that apply: the records it creates and links, whom it gives them to,
 * the record types it finds and how, what it does not replay and why, the
 * lookups it empties, the records it refuses before writing with what lifts
 * it, the fields the other org lacks, the custom settings, the currencies, the
 * standard price book, what it masks and does not, the emails and phone
 * numbers, archived activities, what an older checkpoint lacks, the dates,
 * each file it leaves and the data storage. A success hides none of it.
 */
export function replayLines(info: FrozenReplayInfo, target: string, t: Translate): ReplayLine[] {
  const { summary } = info;
  const lines: ReplayLine[] = [];
  const n = (value: number): string => formatNumber(value);
  lines.push({
    id: 'records',
    text: t('checkpoint.replay.plan.records', {
      count: summary.records.toCreate,
      records: n(summary.records.toCreate),
      target,
    }),
  });
  if (summary.records.linkedById > 0) {
    lines.push({
      id: 'linked-by-id',
      text: t('checkpoint.replay.plan.linkedById', {
        count: summary.records.linkedById,
        records: n(summary.records.linkedById),
        target,
      }),
    });
  }
  if (summary.records.linkedByKey > 0) {
    lines.push({
      id: 'linked-by-key',
      text: t('checkpoint.replay.plan.linkedByKey', {
        count: summary.records.linkedByKey,
        records: n(summary.records.linkedByKey),
        target,
      }),
    });
  }
  const owners = summary.owners;
  if (owners.kept + owners.toRunningUser > 0) {
    lines.push({
      id: 'owners',
      text: t('checkpoint.replay.plan.owners', {
        kept: n(owners.kept),
        toYou: n(owners.toRunningUser),
        target,
      }),
    });
    const why = [
      owners.reasons.notInTarget > 0
        ? t('checkpoint.replay.plan.ownersNotInTarget', {
            records: n(owners.reasons.notInTarget),
            target,
          })
        : null,
      owners.reasons.inactive > 0
        ? t('checkpoint.replay.plan.ownersInactive', {
            records: n(owners.reasons.inactive),
            target,
          })
        : null,
      owners.reasons.queueMissing > 0
        ? t('checkpoint.replay.plan.ownersQueueMissing', {
            records: n(owners.reasons.queueMissing),
            target,
          })
        : null,
    ].filter((part): part is string => part !== null);
    if (why.length > 0) lines.push({ id: 'owners-why', text: why.join(' ') });
  }
  for (const type of summary.recordTypes) {
    lines.push({
      id: `record-type-${type.object}-${type.recordType}`,
      text: t(
        type.outcome === 'byName'
          ? 'checkpoint.replay.plan.recordTypeByName'
          : type.outcome === 'byId'
            ? 'checkpoint.replay.plan.recordTypeById'
            : 'checkpoint.replay.plan.recordTypeDefault',
        { object: type.object, recordType: type.recordType, records: n(type.records), target },
      ),
      ...(type.outcome === 'default' ? { warn: true as const } : {}),
    });
  }
  for (const left of summary.notReplayed) {
    lines.push({
      id: `not-replayed-${left.object}`,
      text: t(`checkpoint.replay.plan.notReplayed.${left.reason}`, {
        object: left.object,
        records: n(left.records),
        target,
      }),
      warn: true,
    });
  }
  for (const emptied of summary.lookupsEmptied) {
    lines.push({
      id: `emptied-${emptied.field}`,
      text: t(`checkpoint.replay.plan.lookupEmptied.${emptied.reason}`, {
        field: emptied.field,
        records: n(emptied.records),
        target,
      }),
      warn: true,
    });
  }
  for (const refused of summary.refused) {
    lines.push({
      id: `refused-${refused.object}-${refused.reason}`,
      text: [
        t(`checkpoint.replay.plan.refused.${refused.reason}`, {
          object: refused.object,
          records: n(refused.records),
          target,
        }),
        refused.path ?? '',
      ]
        .filter((part) => part !== '')
        .join(' '),
      warn: true,
    });
  }
  for (const missing of summary.fieldsNotInTarget) {
    lines.push({
      id: `fields-${missing.object}`,
      text: t('checkpoint.replay.plan.fieldsNotInTarget', {
        object: missing.object,
        fields: missing.fields.join(', '),
        target,
      }),
      warn: true,
    });
  }
  if (summary.customSettings) {
    lines.push({
      id: 'custom-settings',
      text: t('checkpoint.replay.plan.customSettings', {
        inserted: n(summary.customSettings.inserted),
        already: n(summary.customSettings.alreadyThere),
        target,
      }),
    });
  }
  for (const currency of summary.currencies.refused) {
    lines.push({
      id: `currency-${currency.code}`,
      text: t('checkpoint.replay.plan.currencyRefused', {
        code: currency.code,
        records: n(currency.records),
        target,
      }),
      warn: true,
    });
  }
  if (summary.currencies.singleCurrencyTarget) {
    lines.push({
      id: 'single-currency',
      text: t('checkpoint.replay.plan.singleCurrency', { target }),
    });
  }
  if (summary.standardPricebook !== undefined && summary.standardPricebook !== 'annex') {
    lines.push({
      id: 'standard-pricebook',
      text: t(`checkpoint.replay.plan.standardPricebook.${summary.standardPricebook}`, { target }),
      ...(summary.standardPricebook === 'ambiguous' ? { warn: true as const } : {}),
    });
  }
  if (summary.masked.fields.length > 0) {
    lines.push({
      id: 'masked',
      text: t('checkpoint.replay.plan.masked', { fields: summary.masked.fields.join(', ') }),
    });
  }
  if ((summary.masked.unmaskedFreeText ?? []).length > 0) {
    lines.push({
      id: 'unmasked-free-text',
      text: t('checkpoint.replay.plan.unmaskedFreeText', {
        fields: (summary.masked.unmaskedFreeText ?? []).join(', '),
      }),
      warn: true,
    });
  }
  lines.push({
    id: 'contact-points',
    text: t(
      summary.contactPoints === 'neutralized'
        ? 'checkpoint.replay.plan.contactPointsNeutralized'
        : 'checkpoint.replay.plan.contactPointsKept',
    ),
  });
  if ((summary.archivedActivities ?? 0) > 0) {
    lines.push({
      id: 'archived',
      text: t('checkpoint.replay.plan.archived', {
        records: n(summary.archivedActivities ?? 0),
        target,
      }),
    });
  }
  if (summary.degraded.length > 0) {
    lines.push({
      id: 'degraded',
      text: t('checkpoint.replay.plan.degraded', {
        parts: summary.degraded.map((part) => t(ANNEX_PART_KEYS[part])).join(', '),
        target,
      }),
      warn: true,
    });
  }
  lines.push({ id: 'audit-dates', text: t('checkpoint.replay.plan.auditDates') });
  if (info.filesLeft.length > 0) {
    lines.push({
      id: 'files-left',
      text: t('checkpoint.replay.plan.filesLeft', {
        count: info.filesLeft.length,
        files: n(info.filesLeft.length),
        names: info.filesLeft
          .map((file) =>
            file.name !== undefined ? `${file.name} (${file.objectApiName})` : file.objectApiName,
          )
          .join(', '),
      }),
      warn: true,
    });
  }
  // Past what the other org has left, the refusal a Replay would meet, said
  // as the command line's dry run says it: shown as figures alone, it was
  // met only once Replay was pressed.
  if (info.storage?.refusal) {
    lines.push({
      id: 'storage',
      text: t('checkpoint.replay.plan.storageRefused', {
        estimate: megabytes(info.storage.estimateMB),
        remaining: info.storage.remainingMB,
        max: info.storage.maxMB,
        target,
      }),
      warn: true,
    });
  } else if (info.storage) {
    lines.push({
      id: 'storage',
      text: t('checkpoint.replay.plan.storage', {
        estimate: info.storage.estimateMB,
        remaining: info.storage.remainingMB,
        max: info.storage.maxMB,
        target,
      }),
    });
  }
  return lines;
}
