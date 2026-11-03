import type { TFunction } from 'i18next';
import type {
  CheckpointLeftOutCode,
  RunCheckpointCreator,
  RunCheckpointObjectNote,
} from '@sandforge/shared';
import { formatNumber } from './formatters';

/**
 * Why a checkpoint holds an object or leaves it out, in the page's language:
 * the Checkpoints page's scope, and the notes of the checkpoint a run takes
 * first that Forge, Sync, Seed, Autopilot and a Frozen load say beside their
 * estimate. Those notes went to the page in the extension's English, the
 * left-out reasons of a scope in six languages: one catalogue for both, in a
 * namespace every page that shows either loads.
 */

/** What the page says of each reason a checkpoint leaves an object out. */
const LEFT_OUT_KEYS: Readonly<Record<CheckpointLeftOutCode, string>> = {
  excludedByUser: 'checkpointNotes.leftOut.excludedByUser',
  notFound: 'checkpointNotes.leftOut.notFound',
  chatter: 'checkpointNotes.leftOut.chatter',
  history: 'checkpointNotes.leftOut.history',
  sharing: 'checkpointNotes.leftOut.sharing',
  changeEvent: 'checkpointNotes.leftOut.changeEvent',
  unsupportedKind: 'checkpointNotes.leftOut.unsupportedKind',
  customSetting: 'checkpointNotes.leftOut.customSetting',
  notCustomSetting: 'checkpointNotes.leftOut.notCustomSetting',
  files: 'checkpointNotes.leftOut.files',
  heldWithFiles: 'checkpointNotes.leftOut.heldWithFiles',
  setup: 'checkpointNotes.leftOut.setup',
  metadata: 'checkpointNotes.leftOut.metadata',
  notWritable: 'checkpointNotes.leftOut.notWritable',
  notDescribed: 'checkpointNotes.leftOut.notDescribed',
  noSystemModstamp: 'checkpointNotes.leftOut.noSystemModstamp',
  noRecycleBin: 'checkpointNotes.leftOut.noRecycleBin',
  unreadable: 'checkpointNotes.leftOut.unreadable',
  pastTheLimit: 'checkpointNotes.leftOut.pastTheLimit',
  noViewAll: 'checkpointNotes.leftOut.noViewAll',
  noModifyAll: 'checkpointNotes.leftOut.noModifyAll',
  activities: 'checkpointNotes.leftOut.activities',
  catalog: 'checkpointNotes.leftOut.catalog',
  filesNotProven: 'checkpointNotes.leftOut.filesNotProven',
  settingNotProven: 'checkpointNotes.leftOut.settingNotProven',
  parentNotSeen: 'checkpointNotes.leftOut.parentNotSeen',
};

/** An object left out, as a scope or a run's note names it. */
interface LeftOutSaid {
  objectApiName: string;
  code?: CheckpointLeftOutCode;
  reason: string;
  detail?: string;
  records?: number;
  limit?: number;
}

/**
 * Why a checkpoint left an object out, in the page's language, what the
 * reason leaves to name after it in the words it came in. An entry with no
 * code — kept before reasons had codes — says it in the extension's words.
 */
export function leftOutWords(t: TFunction, object: LeftOutSaid): string {
  if (object.code === undefined) return object.reason;
  const why = t(LEFT_OUT_KEYS[object.code], {
    object: object.objectApiName,
    records: formatNumber(object.records ?? 0),
    limit: formatNumber(object.limit ?? 0),
  });
  return object.detail === undefined ? why : `${why} (${object.detail})`;
}

/** An automation of the target, by its kind, as the sentence that names it says it. */
const KIND_KEYS: Readonly<Record<RunCheckpointCreator['kind'], string>> = {
  flow: 'checkpointNotes.added.kind.flow',
  process: 'checkpointNotes.added.kind.process',
  workflowRule: 'checkpointNotes.added.kind.workflowRule',
  trigger: 'checkpointNotes.added.kind.trigger',
};

/** What creates the records of an object added, by the write that fires it. */
const CREATED_BY_KEYS: Readonly<Record<RunCheckpointCreator['write'], string>> = {
  insert: 'checkpointNotes.added.createdBy.insert',
  update: 'checkpointNotes.added.createdBy.update',
  delete: 'checkpointNotes.added.createdBy.delete',
  undelete: 'checkpointNotes.added.createdBy.undelete',
};

/**
 * Why the checkpoint a run takes first holds an object beside those the run
 * writes, or leaves one out, in the page's language: each automation that
 * creates its records named, the others counted; the files every checkpoint
 * holds; or the reason the take left it out. A note with no code, or one of
 * automations it does not name, says it in the extension's words.
 */
export function runNoteWords(t: TFunction, note: RunCheckpointObjectNote): string {
  switch (note.code) {
    case undefined:
      return note.reason;
    case 'createdByAutomation': {
      const creators = note.creators ?? [];
      if (creators.length === 0) return note.reason;
      const named = creators.map((creator) =>
        t(CREATED_BY_KEYS[creator.write], {
          kind: t(KIND_KEYS[creator.kind]),
          name: creator.name,
          created: note.objectApiName,
          object: creator.objectApiName,
        }),
      );
      const more = note.moreCreators ?? 0;
      return [
        ...named,
        ...(more > 0 ? [t('checkpointNotes.added.more', { count: more })] : []),
      ].join(' ');
    }
    case 'files':
      return t('checkpointNotes.added.files');
    case 'attachments':
      return t('checkpointNotes.added.attachments');
    case 'heldUnasked':
      return t('checkpointNotes.added.heldUnasked');
    default:
      return leftOutWords(t, { ...note, code: note.code });
  }
}
