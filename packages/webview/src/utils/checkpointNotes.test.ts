import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RunCheckpointObjectNote } from '@sandforge/shared';
import i18n from '../i18n';
import fr from '../i18n/locales/fr.json';
import { leftOutWords, runNoteWords } from './checkpointNotes';

const t = ((key: string, options?: Record<string, unknown>) =>
  i18n.t(key, options)) as unknown as Parameters<typeof runNoteWords>[0];

/** What the checkpoint a run takes first adds for the target's flows, as the extension notes it. */
const ADDED: RunCheckpointObjectNote = {
  objectApiName: 'Task',
  code: 'createdByAutomation',
  reason:
    "The target's flow 'Welcome task' creates Task records as Contact records go in; the " +
    "target's workflow rule 'Follow up' creates Task records as Contact records are updated; " +
    "the target's process 'Escalate' creates Task records as Contact records are deleted; and 2 more.",
  creators: [
    { kind: 'flow', name: 'Welcome task', objectApiName: 'Contact', write: 'insert' },
    { kind: 'workflowRule', name: 'Follow up', objectApiName: 'Contact', write: 'update' },
    { kind: 'process', name: 'Escalate', objectApiName: 'Contact', write: 'delete' },
  ],
  moreCreators: 2,
};

describe('runNoteWords', () => {
  beforeAll(() => {
    i18n.addResourceBundle('fr', 'translation', fr);
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('names each automation that creates the records added, the others counted, in the page’s language', async () => {
    expect(runNoteWords(t, ADDED, 'added')).toBe(
      "The target's flow 'Welcome task' creates Task records as Contact records go in. " +
        "The target's workflow rule 'Follow up' creates Task records as Contact records are " +
        "updated. The target's process 'Escalate' creates Task records as Contact records are " +
        'deleted. And 2 more automations create them.',
    );

    await i18n.changeLanguage('fr');
    // Forge's and Sync's panels said it in the extension's English.
    expect(runNoteWords(t, ADDED, 'added')).toBe(
      'Des enregistrements Task sont créés par le Flow « Welcome task » de la cible quand des ' +
        'enregistrements Contact sont insérés. Des enregistrements Task sont créés par la règle ' +
        'de workflow « Follow up » de la cible quand des enregistrements Contact sont mis à ' +
        'jour. Des enregistrements Task sont créés par le processus « Escalate » de la cible ' +
        'quand des enregistrements Contact sont supprimés. Et 2 autres automatisations en créent.',
    );
  });

  it('says the files every checkpoint holds, and what it holds unasked, as the extension says them in English', () => {
    expect(
      runNoteWords(t, { objectApiName: 'ContentDocument', code: 'files', reason: '' }, 'added'),
    ).toBe(
      'Files, which every checkpoint of picked objects holds: a rewind deletes the files added ' +
        'since to the records it holds.',
    );
    expect(
      runNoteWords(t, { objectApiName: 'Attachment', code: 'attachments', reason: '' }, 'added'),
    ).toBe(
      'Attachments, which every checkpoint of picked objects holds: a rewind deletes the ' +
        'attachments added since.',
    );
    expect(
      runNoteWords(t, { objectApiName: 'Note', code: 'heldUnasked', reason: '' }, 'added'),
    ).toBe('Held as every checkpoint of picked objects holds it.');
  });

  it('says an object left out by the reason the take gave it, with what the reason names', async () => {
    const note: RunCheckpointObjectNote = {
      objectApiName: 'Asset',
      code: 'pastTheLimit',
      reason: 'Asset has 900000 records. A rewind leaves its records as they are.',
      records: 900_000,
      limit: 500_000,
    };
    expect(runNoteWords(t, note, 'notHeld')).toBe(
      "Asset has 900,000 records, past the checkpoint's limit of 500,000 for one object: left " +
        'out of the checkpoint, as part of it would be taken for all of it.',
    );
    expect(
      runNoteWords(
        t,
        {
          objectApiName: 'FeedItem',
          code: 'unreadable',
          reason: 'Left out.',
          detail: 'QUERY_TIMEOUT',
        },
        'notHeld',
      ),
    ).toBe('Left out: the org refuses to read it whole. (QUERY_TIMEOUT)');

    await i18n.changeLanguage('fr');
    expect(
      runNoteWords(t, { objectApiName: 'Account', code: 'excludedByUser', reason: '' }, 'notHeld'),
    ).toBe('Laissé de côté à votre demande.');
  });

  it('says a Document of the Documents tab left out as left out, whose code names files among those added', () => {
    // Under Not held, it read "Files, which every checkpoint of picked
    // objects holds: a rewind deletes the files added since".
    const document: RunCheckpointObjectNote = {
      objectApiName: 'Document',
      code: 'files',
      reason:
        'Documents of the Documents tab are left out. A rewind leaves its records as they are.',
    };

    expect(runNoteWords(t, document, 'notHeld')).toBe(
      'Documents of the Documents tab are left out: they are shared content kept in folders, ' +
        'as setup is.',
    );
    expect(
      runNoteWords(t, { objectApiName: 'ContentDocument', code: 'files', reason: '' }, 'added'),
    ).toBe(
      'Files, which every checkpoint of picked objects holds: a rewind deletes the files added ' +
        'since to the records it holds.',
    );
    // A code no take leaves an object out with is said in the extension's words.
    expect(
      runNoteWords(
        t,
        { objectApiName: 'Note', code: 'heldUnasked', reason: 'As noted.' },
        'notHeld',
      ),
    ).toBe('As noted.');
  });

  it('says in the extension’s words a note kept before notes had codes, and one naming no automation', () => {
    expect(runNoteWords(t, { objectApiName: 'Task', reason: 'Held before codes.' }, 'added')).toBe(
      'Held before codes.',
    );
    expect(
      runNoteWords(
        t,
        { ...ADDED, creators: [], moreCreators: undefined, reason: 'As noted.' },
        'added',
      ),
    ).toBe('As noted.');
  });
});

describe('leftOutWords', () => {
  it('says a reason with no code in the words it came in', () => {
    expect(leftOutWords(t, { objectApiName: 'Asset', reason: 'Left out, as read.' })).toBe(
      'Left out, as read.',
    );
  });
});
