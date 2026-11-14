import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import i18n from 'i18next';
import '../../i18n';
import type { CheckpointReplaySummary, FrozenReplayInfo } from '@sandforge/shared';
import {
  defaultReplayChoices,
  holdsFileContent,
  plannedRecords,
  replayAskKey,
  replayChoicesSent,
  replayInto,
  replayLines,
  replayObjectsOf,
  replaySourceDataOf,
  replayTargetsOf,
} from './replayFacts';
import {
  developerOrg,
  listEntry,
  productionOrg,
  readyCheckpoint,
} from './testing/checkpointFixtures';

const t = (key: string, options?: Record<string, unknown>): string => i18n.t(key, options);

/** A sandbox's checkpoint, with the data storage its take read, or none before 1.81. */
function sandboxCheckpoint(dataStorageMaxMB?: number, staging = false) {
  const base = readyCheckpoint();
  return readyCheckpoint({
    org: {
      ...base.org,
      isSandbox: true,
      organizationType: 'Enterprise Edition',
      tier: 'sandbox',
      ...(dataStorageMaxMB !== undefined ? { dataStorageMaxMB } : {}),
      ...(staging ? { staging: true as const } : {}),
    },
  });
}

/** What a replay says when nothing is out of the ordinary but its records and owners. */
function plainSummary(over: Partial<CheckpointReplaySummary> = {}): CheckpointReplaySummary {
  return {
    records: { toCreate: 2412, linkedById: 0, linkedByKey: 0, refusedBeforeWrite: 0 },
    owners: {
      kept: 0,
      toRunningUser: 2412,
      reasons: { notInTarget: 2412, inactive: 0, queueMissing: 0 },
    },
    recordTypes: [],
    notReplayed: [],
    lookupsEmptied: [],
    refused: [],
    fieldsNotInTarget: [],
    currencies: { refused: [] },
    masked: { fields: [] },
    contactPoints: 'neutralized',
    degraded: [],
    auditDates: 'new',
    ...over,
  };
}

/** A replay's info around `summary`. */
function infoOf(
  summary: CheckpointReplaySummary,
  more: Partial<FrozenReplayInfo> = {},
): FrozenReplayInfo {
  return {
    checkpoint: {
      checkpointId: 'ck-20261020-140512-a1b2',
      name: 'Before UAT',
      organizationId: '00Dxx0000001234AAA',
      takenAt: '2026-10-20T14:06:03.000Z',
      tier: 'sandbox',
      annex: true,
    },
    target: { organizationId: '00D000000000022EAA', name: 'QA' },
    choices: defaultReplayChoices(readyCheckpoint()),
    summary,
    filesLeft: [],
    requests: 4,
    ...more,
  };
}

describe('what a checkpoint says of the data it holds', () => {
  it('tells a Staging sandbox and a Partial Copy or Full one by their mark and data storage, past a Developer Pro’s', () => {
    expect(replaySourceDataOf(sandboxCheckpoint(200, true).org)).toEqual({
      kind: 'real',
      why: 'staging',
    });
    expect(replaySourceDataOf(sandboxCheckpoint(5120).org)).toEqual({
      kind: 'real',
      why: 'storage',
      mb: 5120,
    });
    expect(replaySourceDataOf(sandboxCheckpoint(1024).org)).toEqual({ kind: 'free' });
    expect(replaySourceDataOf(sandboxCheckpoint(200).org)).toEqual({ kind: 'free' });
  });

  it('says a sandbox’s checkpoint taken before 1.81 does not say, and a scratch or Developer Edition org’s holds none', () => {
    expect(replaySourceDataOf(sandboxCheckpoint().org)).toEqual({ kind: 'unknown' });
    expect(replaySourceDataOf(readyCheckpoint().org)).toEqual({ kind: 'free' });
    expect(replaySourceDataOf({ ...readyCheckpoint().org, tier: 'scratch' })).toEqual({
      kind: 'free',
    });
  });
});

describe('the choices a replay starts with and sends', () => {
  it('masks by default the data that may be real or does not say, and nothing else', () => {
    expect(defaultReplayChoices(sandboxCheckpoint(5120)).mask).toBe(true);
    expect(defaultReplayChoices(sandboxCheckpoint(200, true)).mask).toBe(true);
    expect(defaultReplayChoices(sandboxCheckpoint()).mask).toBe(true);
    expect(defaultReplayChoices(readyCheckpoint())).toEqual({
      owners: 'same',
      customSettings: false,
      mask: false,
      contactPoints: 'neutralized',
      objects: [],
      excluded: [],
      link: [],
    });
  });

  it('sends the declaration of no real data only where it lifts the refusal: unmasked, of a sandbox that does not say', () => {
    const unknown = sandboxCheckpoint();
    const declared = { ...defaultReplayChoices(unknown), mask: false, noRealData: true as const };
    expect(replayChoicesSent(unknown, declared).noRealData).toBe(true);
    expect(replayChoicesSent(unknown, { ...declared, mask: true })).not.toHaveProperty(
      'noRealData',
    );
    expect(replayChoicesSent(sandboxCheckpoint(5120), declared)).not.toHaveProperty('noRealData');
    expect(replayChoicesSent(readyCheckpoint(), declared)).not.toHaveProperty('noRealData');
  });

  it('asks for another simulation when the org, a choice or Replace changes, never for the order objects were ticked in', () => {
    const choices = { ...defaultReplayChoices(readyCheckpoint()), excluded: ['Case', 'Account'] };
    const key = replayAskKey('org-qa', choices, false);
    expect(replayAskKey('org-qa', { ...choices, excluded: ['Account', 'Case'] }, false)).toBe(key);
    expect(replayAskKey('org-uat', choices, false)).not.toBe(key);
    expect(replayAskKey('org-qa', { ...choices, owners: 'me' }, false)).not.toBe(key);
    expect(replayAskKey('org-qa', { ...choices, mask: true }, false)).not.toBe(key);
    expect(replayAskKey('org-qa', choices, true)).not.toBe(key);
  });

  it('holds a replay to the records its simulation counts to create', () => {
    expect(
      plannedRecords({
        perObject: [{ toInsert: 400 } as never, { toInsert: 2012 } as never],
      }),
    ).toBe(2412);
  });
});

describe('the objects a replay offers', () => {
  it('offers the objects that hold records, a file’s content set apart, a custom setting marked', () => {
    const base = readyCheckpoint();
    const files = { ...base.objects[0], objectApiName: 'ContentDocument', records: 2 };
    const setting = {
      ...base.objects[0],
      objectApiName: 'Feature__c',
      records: 1,
      customSetting: 'list' as const,
    };
    const offered = replayObjectsOf(
      readyCheckpoint({ objects: [...base.objects, files, setting] }),
    );
    expect(offered).toEqual([
      { objectApiName: 'Account', records: 400, fileContent: false, customSetting: false },
      { objectApiName: 'Contact', records: 2012, fileContent: false, customSetting: false },
      { objectApiName: 'ContentDocument', records: 2, fileContent: true, customSetting: false },
      { objectApiName: 'Feature__c', records: 1, fileContent: false, customSetting: true },
    ]);
    expect(['contentversion', 'Attachment', 'Document'].every(holdsFileContent)).toBe(true);
  });
});

describe('the orgs a replay goes into', () => {
  const page = developerOrg({ id: 'org-dev', alias: 'DEV-SB', orgType: 'Sandbox' });
  const qa = developerOrg({ id: 'org-qa', alias: 'QA', orgType: 'Scratch' });
  const staging = developerOrg({ id: 'org-uat', alias: 'UAT', orgType: 'Sandbox', staging: true });
  const gone = developerOrg({ id: 'org-gone', alias: 'GONE', status: 'expired' });
  const orgs = [qa, page, staging, productionOrg(), gone];

  it('offers the sandbox a checkpoint was of, refreshed since, first, and never a production org, a Staging one or a disconnected one', () => {
    const targets = replayTargetsOf(orgs, page, { valid: false, why: 'refreshed' });
    expect(targets.offered.map((org) => org.id)).toEqual(['org-dev', 'org-qa']);
    expect(targets.refreshed?.id).toBe('org-dev');
    expect(targets.own).toBeUndefined();
    expect(targets.staging).toBe(1);
  });

  it('sets apart the org a checkpoint still rewinds: Rewind brings it back instead', () => {
    const targets = replayTargetsOf(orgs, page, { valid: true });
    expect(targets.offered.map((org) => org.id)).toEqual(['org-qa']);
    expect(targets.own?.id).toBe('org-dev');
    expect(targets.refreshed).toBeUndefined();
  });

  it('finds a checkpoint’s replay into a registered org', () => {
    const entry = listEntry(readyCheckpoint(), {
      replays: [{ target: { organizationId: '00D000000000022EAA', orgId: 'org-qa' }, inPlace: 3 }],
    });
    expect(replayInto(entry, 'org-qa')?.inPlace).toBe(3);
    expect(replayInto(entry, 'org-dev')).toBeUndefined();
  });
});

describe('what a replay says beside its plan', () => {
  it('says the records it creates, whom it gives them to and why, the contact points and the dates, every time', () => {
    const lines = replayLines(infoOf(plainSummary()), 'QA', t);
    expect(lines.map((line) => line.text)).toEqual([
      'Creates copies of 2,412 of its records in QA, parents first, with new Ids; nothing QA holds is changed or deleted.',
      'Owners: kept on 0 (the same user in QA); you on 2,412.',
      '2,412 of them: their user is not in QA.',
      'Emails and phone numbers are made unreachable.',
      'Created and modified dates and users are the replay’s own: the platform sets them.',
    ]);
  });

  it('says every record that does not go across as it was, and flags it', () => {
    const lines = replayLines(
      infoOf(
        plainSummary({
          records: { toCreate: 10, linkedById: 1, linkedByKey: 2, refusedBeforeWrite: 70 },
          recordTypes: [
            { object: 'Account', recordType: 'ns__Retail', outcome: 'byName', records: 4 },
            { object: 'Case', recordType: 'Support', outcome: 'default', records: 6 },
          ],
          notReplayed: [{ object: 'ContentDocument', records: 2, reason: 'fileContentNotKept' }],
          lookupsEmptied: [
            { field: 'Opportunity.Pricebook2Id', records: 3, reason: 'objectNotReplayed' },
          ],
          refused: [
            {
              object: 'Account',
              records: 70,
              reason: 'personAccountsUnsupported',
            },
          ],
          fieldsNotInTarget: [{ object: 'Account', fields: ['Tier__c'] }],
          customSettings: { inserted: 1, alreadyThere: 2 },
          currencies: { refused: [{ code: 'GBP', records: 5 }], singleCurrencyTarget: true },
          standardPricebook: 'ambiguous',
          masked: { fields: ['Contact.Email'], unmaskedFreeText: ['Case.Description'] },
          contactPoints: 'kept',
          archivedActivities: 8,
          degraded: ['recordTypes', 'users'],
        }),
        {
          filesLeft: [
            { objectApiName: 'ContentDocument', name: 'Quote.pdf' },
            { objectApiName: 'Attachment' },
          ],
          storage: { estimateMB: 4.2, remainingMB: 180, maxMB: 200 },
        },
      ),
      'QA',
      t,
    );
    const said = Object.fromEntries(lines.map((line) => [line.id, line]));
    expect(said['linked-by-id'].text).toBe(
      '1 record is in QA under the same Id: linked, not changed.',
    );
    expect(said['linked-by-key'].text).toBe(
      '2 records are in QA with the same values of the fields a link names: linked, not created.',
    );
    expect(said['record-type-Account-ns__Retail']).toEqual({
      id: 'record-type-Account-ns__Retail',
      text: 'Account (4): record type ns__Retail, found in QA by its name.',
    });
    expect(said['record-type-Case-Support'].warn).toBe(true);
    expect(said['not-replayed-ContentDocument'].text).toBe(
      'ContentDocument (2): not replayed, a checkpoint keeps no file’s content.',
    );
    expect(said['emptied-Opportunity.Pricebook2Id'].text).toContain('Tick it to keep the link');
    expect(said['refused-Account-personAccountsUnsupported'].text).toBe(
      'Account (70): refused before anything is written, person accounts are not turned on in QA. Turn them on, or leave Account out.',
    );
    expect(said['fields-Account'].text).toBe('Account: fields QA lacks, left out: Tier__c.');
    expect(said['custom-settings'].text).toContain('1 rows set up; 2 already in QA');
    expect(said['currency-GBP'].warn).toBe(true);
    expect(said['single-currency']).toBeDefined();
    expect(said['standard-pricebook'].warn).toBe(true);
    expect(said['masked'].text).toBe('Masked: Contact.Email.');
    expect(said['unmasked-free-text'].text).toContain('Case.Description');
    expect(said['contact-points'].text).toBe('Emails and phone numbers go as they are.');
    expect(said['archived'].text).toContain('8 archived tasks and events');
    expect(said['degraded'].text).toBe(
      'Taken before SandForge 1.81, this checkpoint keeps no record types, users: their records take what QA gives by default.',
    );
    expect(said['files-left'].text).toBe(
      '2 files are not replayed, a checkpoint keeping no file’s content: Quote.pdf (ContentDocument), Attachment.',
    );
    expect(said['storage'].text).toBe(
      'Data storage: about 4.2 MB, with 180 MB left in QA of 200 MB.',
    );
  });

  it('says nothing of the standard price book when the annex told it', () => {
    const lines = replayLines(infoOf(plainSummary({ standardPricebook: 'annex' })), 'QA', t);
    expect(lines.some((line) => line.id === 'standard-pricebook')).toBe(false);
  });
});

describe('the words of a replay', () => {
  /** How a Frozen Dataset is named in each language, which a replay never says. */
  const DATASET_WORDS: Readonly<Record<string, RegExp>> = {
    en: /dataset/i,
    fr: /jeu de données/i,
    de: /dataset/i,
    es: /conjunto de datos|dataset/i,
    'pt-BR': /conjunto de dados|dataset/i,
    ja: /データセット/,
  };

  it.each(Object.keys(DATASET_WORDS))('never says “dataset” in %s', (locale) => {
    const catalogue = JSON.parse(
      readFileSync(join(__dirname, '../../i18n/locales', `${locale}.json`), 'utf8'),
    ) as {
      checkpoint: { replay: unknown; list: Record<string, unknown> };
      frozen: { replay: unknown };
      home: { checkpoint: Record<string, unknown> };
    };
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(catalogue.checkpoint.replay);
    walk(catalogue.checkpoint.list.why);
    walk(catalogue.checkpoint.list.scratchExpiresSoon);
    walk(catalogue.frozen.replay);
    walk(catalogue.home.checkpoint.replayRefreshed);
    expect(strings.length).toBeGreaterThan(100);
    expect(strings.filter((text) => DATASET_WORDS[locale].test(text))).toEqual([]);
  });
});
