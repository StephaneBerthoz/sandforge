import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import ja from '../../i18n/locales/ja.json';
import { wholeOrgGraph } from './testing/wholeOrg';
import {
  anonymizationRowSaid,
  automationRowSaid,
  complianceRowSaid,
  controlsSet,
  forgeRunBuckets,
  gapsRowSaid,
  leftToDecide,
  metadataRowSaid,
  runSentence,
} from './reviewSummaries';

function node(objectApiName: string, overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 4,
    fieldCount: 20,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 1,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 15,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
    ...overrides,
  };
}

function graphOf(...nodes: ForgeGraphNode[]): ForgeGraph {
  return { nodes, edges: [], totalRecords: 0, estimatedSizeMB: 0, estimatedDurationSeconds: 1 };
}

const ORGS = { source: 'DevSandbox', target: 'QASandbox' };

/** The sentence of a graph under a config, in the language i18n is set to. */
function sentence(
  graph: ForgeGraph,
  config: Parameters<typeof runSentence>[1]['config'] = null,
  oneRecord = false,
): string {
  return runSentence(i18n.t as TFunction, {
    graph,
    buckets: forgeRunBuckets(graph),
    config,
    oneRecord,
    ...ORGS,
  });
}

const t = (...args: Parameters<TFunction>): string => (i18n.t as TFunction)(...args);

beforeAll(() => {
  i18n.addResourceBundle('fr', 'translation', fr, true, true);
  i18n.addResourceBundle('ja', 'translation', ja, true, true);
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('the run of the whole org in a sentence', () => {
  it('names the whole source, the records counted and the objects they are in', () => {
    const graph = wholeOrgGraph();
    expect(
      runSentence(i18n.t as TFunction, {
        graph,
        buckets: forgeRunBuckets(graph),
        config: null,
        oneRecord: false,
        wholeOrg: true,
        ...ORGS,
      }),
    ).toBe('Copy the whole of DevSandbox into QASandbox: 9,400 records counted in 4 objects.');
  });
});

describe('the run in a sentence', () => {
  it('says the count and the two orgs, in the singular for one record', () => {
    expect(sentence(graphOf(node('Account', { recordCount: 1 })))).toBe(
      'Copy 1 record from DevSandbox into QASandbox.',
    );
    expect(sentence(graphOf(node('Account'), node('Contact')))).toBe(
      'Copy 8 records from DevSandbox into QASandbox.',
    );
  });

  it('writes the count in the language of the panel', async () => {
    await i18n.changeLanguage('fr');
    expect(sentence(graphOf(node('Account', { recordCount: 1 })))).toBe(
      'Copier 1 enregistrement de DevSandbox vers QASandbox.',
    );
    expect(sentence(graphOf(node('Account', { recordCount: 1234 })))).toBe(
      `Copier ${(1234).toLocaleString('fr')} enregistrements de DevSandbox vers QASandbox.`,
    );
    await i18n.changeLanguage('ja');
    expect(sentence(graphOf(node('Account', { recordCount: 1 })))).toBe(
      'DevSandbox から QASandbox へ 1 件のレコードをコピーします。',
    );
    expect(sentence(graphOf(node('Account'), node('Contact')))).toBe(
      'DevSandbox から QASandbox へ 8 件のレコードをコピーします。',
    );
  });

  it('counts only what the run clones: no empty table, no object left out, no reference data', () => {
    const graph = graphOf(
      node('Account'),
      node('Quote', { recordCount: 0 }),
      node('Case', { included: false, leftOutByUser: true }),
      node('BusinessHours'),
    );
    expect(sentence(graph)).toBe('Copy 4 records from DevSandbox into QASandbox.');
  });

  it('says a cap set after the count as a ceiling, and only when it cuts anything', () => {
    const graph = graphOf(
      node('Account', { recordCount: 10 }),
      node('Contact', { recordCount: 2 }),
    );
    expect(sentence(graph, { maxRecordsPerObject: 5 })).toBe(
      'Copy at most 7 records from DevSandbox into QASandbox.',
    );
    expect(sentence(graph, { maxRecordsPerObject: 100 })).toBe(
      'Copy 12 records from DevSandbox into QASandbox.',
    );
  });

  it('says a filter set after the count as a ceiling, but not the filter of the query it counted', () => {
    const graph = graphOf(node('Account'), node('Contact'));
    expect(sentence(graph, { objectSoqlFilters: { Contact: "LastName = 'A'" } })).toBe(
      'Copy at most 8 records from DevSandbox into QASandbox.',
    );
    expect(
      sentence(graph, {
        soqlQuery: "SELECT Id FROM Account WHERE Name = 'A'",
        objectSoqlFilters: { Account: "Name = 'A'" },
      }),
    ).toBe('Copy 8 records from DevSandbox into QASandbox.');
  });

  it('names no count for a clone of one record, whose counts are the source tables’', () => {
    expect(sentence(graphOf(node('Case', { recordCount: 200_000 })), null, true)).toBe(
      'Copy one record and what it reaches in 1 object, from DevSandbox into QASandbox.',
    );
  });

  it('names no count where nobody took one, whatever the mode', () => {
    expect(sentence(graphOf(node('Account', { recordCountUnknown: true })), null, true)).toBe(
      'Copy the records of 1 object from DevSandbox into QASandbox.',
    );
  });
});

describe('what is left to decide', () => {
  const nothingLeft = { undecided: 0, filesBlocked: false, reading: false, readFailed: false };

  it('counts the gaps left, with the singular and the plural of the language', async () => {
    expect(leftToDecide(i18n.t as TFunction, { ...nothingLeft, undecided: 1 })).toBe(
      '1 decision is left.',
    );
    expect(leftToDecide(i18n.t as TFunction, { ...nothingLeft, undecided: 3 })).toBe(
      '3 decisions are left.',
    );
    await i18n.changeLanguage('fr');
    expect(leftToDecide(i18n.t as TFunction, { ...nothingLeft, undecided: 1 })).toBe(
      'Il reste 1 décision.',
    );
    expect(leftToDecide(i18n.t as TFunction, { ...nothingLeft, undecided: 3 })).toBe(
      'Il reste 3 décisions.',
    );
    await i18n.changeLanguage('ja');
    expect(leftToDecide(i18n.t as TFunction, { ...nothingLeft, undecided: 1 })).toBe(
      '決定が 1 件残っています。',
    );
  });

  it('counts the files waiting to be accepted as a decision', () => {
    expect(leftToDecide(i18n.t as TFunction, { ...nothingLeft, filesBlocked: true })).toBe(
      '1 decision is left.',
    );
  });

  it('says nothing is left only once the target was read', () => {
    expect(leftToDecide(i18n.t as TFunction, nothingLeft)).toBe('Nothing is left to decide.');
    expect(leftToDecide(i18n.t as TFunction, { ...nothingLeft, reading: true })).toBe(
      'Reading what the target org holds against the rows…',
    );
    expect(leftToDecide(i18n.t as TFunction, { ...nothingLeft, readFailed: true })).toBe(
      'What the target org holds against the rows could not be read.',
    );
  });
});

describe('the line of each row', () => {
  const read = { undecided: 0, reading: false, readFailed: false, shown: 0, unread: 0 };

  it('Gaps: asks for a decision first, whatever a read is doing', () => {
    const said = gapsRowSaid(i18n.t as TFunction, { ...read, undecided: 2, reading: true });
    expect(said).toEqual({
      summary: '2 gaps will refuse rows until each is decided.',
      state: 'decide',
    });
  });

  it('Gaps: tells a read that found nothing from one that could not look', () => {
    expect(gapsRowSaid(i18n.t as TFunction, read)).toEqual({
      summary: 'What was read holds nothing against these rows.',
      state: 'ready',
    });
    expect(gapsRowSaid(i18n.t as TFunction, { ...read, unread: 1 }).state).toBe('toRead');
    expect(gapsRowSaid(i18n.t as TFunction, { ...read, readFailed: true }).state).toBe('failed');
    expect(gapsRowSaid(i18n.t as TFunction, { ...read, reading: true }).state).toBe('working');
  });

  it('Gaps: counts in French and in Japanese', async () => {
    await i18n.changeLanguage('fr');
    expect(gapsRowSaid(i18n.t as TFunction, { ...read, undecided: 1 }).summary).toBe(
      "1 écart refusera des lignes tant qu'il n'est pas tranché.",
    );
    expect(gapsRowSaid(i18n.t as TFunction, { ...read, shown: 2 }).summary).toBe(
      '2 écarts trouvés ; aucun ne refusera de lignes sans décision.',
    );
    await i18n.changeLanguage('ja');
    expect(gapsRowSaid(i18n.t as TFunction, { ...read, undecided: 1 }).summary).toBe(
      '1 件の差異が、決定されるまで行を拒否します。',
    );
  });

  it('Anonymization: says the fields found and what becomes of them', async () => {
    expect(
      anonymizationRowSaid(i18n.t as TFunction, { personalFields: 0, anonymizes: false }),
    ).toEqual({ summary: 'Discovery found no personal field.', state: 'ready' });
    expect(
      anonymizationRowSaid(i18n.t as TFunction, { personalFields: 1, anonymizes: true }),
    ).toEqual({
      summary: '1 personal field found, anonymized as the run writes it.',
      state: 'ready',
    });
    await i18n.changeLanguage('fr');
    expect(
      anonymizationRowSaid(i18n.t as TFunction, { personalFields: 2, anonymizes: false }).summary,
    ).toBe('2 champs personnels trouvés, écrits tels que la source les détient.');
    await i18n.changeLanguage('ja');
    expect(
      anonymizationRowSaid(i18n.t as TFunction, { personalFields: 1, anonymizes: true }).summary,
    ).toBe('個人情報の項目が 1 件見つかり、書き込み時に匿名化されます。');
  });

  it('Compliance: says the verdict of the framework chosen', () => {
    expect(complianceRowSaid(i18n.t as TFunction, { step: 'none' }).state).toBe('ready');
    expect(
      complianceRowSaid(i18n.t as TFunction, {
        step: 'report',
        framework: 'GDPR',
        verdict: 'Partial',
        passed: false,
      }),
    ).toEqual({ summary: 'GDPR: Partial', state: 'toRead' });
    expect(
      complianceRowSaid(i18n.t as TFunction, { step: 'failed', framework: 'GDPR' }).state,
    ).toBe('failed');
    expect(
      complianceRowSaid(i18n.t as TFunction, {
        step: 'report',
        framework: 'GDPR',
        verdict: 'Pass',
        passed: true,
      }).state,
    ).toBe('ready');
  });

  it('Metadata: never says "no difference" before the comparison answered', async () => {
    const asked = { pending: false, failed: false, differences: 0 };
    expect(metadataRowSaid(i18n.t as TFunction, { ...asked, pending: true }).state).toBe('working');
    expect(metadataRowSaid(i18n.t as TFunction, { ...asked, failed: true }).state).toBe('failed');
    expect(metadataRowSaid(i18n.t as TFunction, asked).summary).toBe(
      'No metadata differences detected.',
    );
    await i18n.changeLanguage('fr');
    expect(metadataRowSaid(i18n.t as TFunction, { ...asked, differences: 1 }).state).toBe('toRead');
  });

  it('Automation: counts what fires at insert, says whether emails may go, and what it could not see', async () => {
    const asked = {
      failed: false,
      read: true,
      blind: false,
      firedAtInsert: 0,
      objectsWithAutomation: 0,
      sendsEmails: false,
    };
    expect(automationRowSaid(i18n.t as TFunction, { ...asked, read: false }).state).toBe('working');
    expect(automationRowSaid(i18n.t as TFunction, { ...asked, failed: true }).state).toBe('failed');
    expect(automationRowSaid(i18n.t as TFunction, asked)).toEqual({
      summary: 'Nothing the target org automates runs on these objects.',
      state: 'ready',
    });
    // Nothing listed is not nothing running, when a part could not be read.
    expect(automationRowSaid(i18n.t as TFunction, { ...asked, blind: true }).state).toBe('toRead');
    expect(
      automationRowSaid(i18n.t as TFunction, { ...asked, objectsWithAutomation: 1 }).summary,
    ).toBe('Nothing fires as the run inserts its records; read what runs on its updates.');
    expect(
      automationRowSaid(i18n.t as TFunction, {
        ...asked,
        firedAtInsert: 1,
        objectsWithAutomation: 1,
        sendsEmails: true,
      }),
    ).toEqual({
      summary: '1 automation fires as the run inserts its records. Emails may go out.',
      state: 'toRead',
    });
    await i18n.changeLanguage('fr');
    expect(
      automationRowSaid(i18n.t as TFunction, {
        ...asked,
        firedAtInsert: 2,
        objectsWithAutomation: 1,
      }).summary,
    ).toBe("2 automatisations se déclenchent quand l'exécution insère ses enregistrements.");
    await i18n.changeLanguage('ja');
    expect(
      automationRowSaid(i18n.t as TFunction, {
        ...asked,
        firedAtInsert: 1,
        objectsWithAutomation: 1,
      }).summary,
    ).toBe('レコードの挿入時に 1 件の自動化が起動します。');
  });

  it('counts the settings Controls holds, the cap among them', () => {
    expect(controlsSet(null)).toBe(0);
    expect(controlsSet({})).toBe(0);
    expect(
      controlsSet({
        maxRecordsPerObject: 100,
        fieldExclusions: { Account: ['Phone'] },
        objectSoqlFilters: { Contact: "LastName = 'A'" },
        fieldMappings: { Case: { Subject: 'Title__c' } },
        ownerMappings: { '005AAA': '005BBB' },
      }),
    ).toBe(5);
    expect(t('forgeRun.review.row.controls.set', { count: 1 })).toBe('1 setting on this run.');
  });
});
