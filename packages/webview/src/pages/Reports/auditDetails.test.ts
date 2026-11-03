import { describe, it, expect, afterEach } from 'vitest';
import type { TFunction } from 'i18next';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { auditDetailLines } from './auditDetails';

const t = i18n.t.bind(i18n) as TFunction;

/** The text of each line, in the order the entry holds its details. */
const said = (details: Record<string, unknown>): string[] =>
  auditDetailLines(t, details).map((line) => line.text);

describe('auditDetailLines', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it("says a verification's counts in words, where the trail printed the host's keys", () => {
    expect(said({ linksChecked: 12, linksBroken: 1, notVisible: 2 })).toEqual([
      'Lookups checked: 12',
      'Lookups broken: 1',
      'Not visible: 2',
    ]);
  });

  it('names a set flag alone: "sweep: true" had nothing more to say than its key', () => {
    expect(said({ sweep: true, found: 4 })).toEqual(['Sweep', 'Found: 4']);
  });

  it('words what the host records as a word, and leaves a name as it is', () => {
    expect(
      said({ decision: 'timedOut', via: 'page', pipeline: 'Nightly.Refresh', step: 'decision' }),
    ).toEqual([
      'Decision: timed out',
      'Answered from: the Automation page',
      'Pipeline: Nightly.Refresh',
      'Step: decision',
    ]);
  });

  it('keeps a word of a later host, rather than print a key path', () => {
    expect(said({ deliverability: 'partly' })).toEqual(['Email deliverability: partly']);
  });

  it("writes a size and a date as a reader does, and a number in the page's grouping", () => {
    expect(said({ bytes: 2048, loadedAt: '2026-09-12T10:00:30.000Z', records: 12345 })).toEqual([
      'Size: 2 KB',
      'Loaded at: 2026-09-12 10:00:30',
      'Records: 12,345',
    ]);
  });

  it('spells out a key no catalogue names, so a newer host stays readable', () => {
    expect(said({ recordsTakenBack: 3, some_other_key: 'x' })).toEqual([
      'Records taken back: 3',
      'Some other key: x',
    ]);
  });

  it('prints what a list or an object holds, and leaves out a detail with no value', () => {
    expect(said({ objects: ['Account', 'Case'], later: { a: 1 }, nothing: null })).toEqual([
      'Objects: ["Account","Case"]',
      'Later: {"a":1}',
    ]);
  });

  it('keeps an unset flag readable, since a set one says its name alone', () => {
    expect(said({ sweep: false })).toEqual(['Sweep: false']);
  });

  it("says each line in the reader's language", async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    expect(said({ recordsLeft: 3, contactPoints: 'neutralized' })).toEqual([
      "Enregistrements restés dans l'org : 3",
      'E-mails et téléphones : neutralisés',
    ]);
  });
});
