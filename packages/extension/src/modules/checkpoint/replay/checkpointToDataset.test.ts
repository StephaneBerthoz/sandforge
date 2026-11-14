import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CheckpointReplayChoices } from '@sandforge/shared';

import { getJsforceConnection } from '../../../core/connection/ConnectionHelper.js';
import { MEMORY_ORG_USER } from '../../../test/memoryRemovalOrg.js';
import {
  FIELDS,
  ORG_ID,
  RewindTestOrg,
  STAMP_FIELDS,
  account,
  contact,
  removeTaken,
  taken,
  writable,
} from '../../../test/rewindTestOrg.js';
import { assertLoadGuards } from '../../frozendataset/LoadGuards.js';
import type { FrozenDataset, FrozenRecord } from '../../frozendataset/types.js';
import { openCheckpointStore, type OrgCheckpointStore } from '../OrgCheckpointStore.js';
import { ARCHIVE_EXTENSION, importReceivedArchive, parseArchiveKey } from '../checkpointArchive.js';
import { readReplayAnnex } from './replayAnnex.js';
import {
  checkpointToDataset,
  convertCheckpoint,
  replayReferenceIdOf,
  surveyCheckpoint,
  type ReplayConversion,
} from './checkpointToDataset.js';
import {
  SOURCE_ORG_ID,
  TARGET_ORG_ID,
  ReplayTargetOrg,
  fabricateCheckpoint,
  idOf,
  settingFields,
  type CheckpointSpec,
  type Fabricated,
} from '../../../test/replayOrgs.js';

vi.mock('../../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** An org whose take keeps an annex: its user under a sandbox's username, as a real take reads it. */
function takenOrg(): RewindTestOrg {
  const org = new RewindTestOrg({
    fields: {
      ...FIELDS,
      Account: [
        ...STAMP_FIELDS,
        writable('Name'),
        writable('OwnerId', 'reference', { referenceTo: ['User'] }),
      ],
    },
  });
  org.missingFields.set('RecordType', new Set(['IsPersonType']));
  org.add('Organization', { Id: ORG_ID, IsSandbox: true, OrganizationType: 'Enterprise Edition' });
  org.add('User', {
    Id: MEMORY_ORG_USER,
    Username: 'ada@example.com.uat',
    Name: 'Ada Admin',
    IsActive: true,
    UserType: 'Standard',
  });
  return org;
}

/*
 * A checkpoint of a Developer sandbox turned into the dataset a replay loads
 * into another org: what each record becomes there, and what the summary
 * says of everything that does not go across as it was. The checkpoint is
 * made as a take leaves one (`replayOrgs.ts`); the other org answers as a
 * scratch org with person accounts and several currencies answered.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storeIn(): OrgCheckpointStore {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-replay-convert-'));
  dirs.push(dir);
  const opened = openCheckpointStore({ root: join(dir, 'store'), locksDir: join(dir, 'locks') });
  if ('refusal' in opened) throw new Error(opened.refusal.reason);
  return opened.store;
}

// Users of the checkpoint's org.
const KEPT = idOf('005', 1);
const GONE = idOf('005', 2);
const INACTIVE = idOf('005', 3);
const RENAMED = idOf('005', 4);
/** RENAMED's user in the other org, under the same username but for its sandbox's name. */
const RENAMED_THERE = idOf('005', 9);
const QUEUE = idOf('00G', 1);
const QUEUE_THERE = idOf('00G', 9);
// Record types of the checkpoint's org, and of the other.
const BUSINESS = idOf('012', 1);
const PERSON = idOf('012', 2);
const RETAIL = idOf('012', 3);
const SOURCE_ONLY = idOf('012', 4);
const PROFILE = idOf('00e', 1);
// Records.
const A1 = idOf('001', 1);
const A2 = idOf('001', 2);
const P1 = idOf('001', 3);
const P2 = idOf('001', 4);
const C1 = idOf('003', 1);
const C2 = idOf('003', 2);
const PC1 = idOf('003', 3);
const PC2 = idOf('003', 4);
const STD = idOf('01s', 1);
const CUS = idOf('01s', 2);
const PR1 = idOf('01t', 1);
const PR2 = idOf('01t', 2);
const E1 = idOf('01u', 1);
const E2 = idOf('01u', 2);
const E3 = idOf('01u', 3);
const O1 = idOf('006', 1);
const O2 = idOf('006', 2);
const L1 = idOf('00k', 1);
const T1 = idOf('00T', 1);
const T2 = idOf('00T', 2);
const K1 = idOf('500', 1);
const D1 = idOf('069', 1);
/** An account the checkpoint does not hold, and a lead. */
const ELSEWHERE = idOf('001', 77);
const LEAD = idOf('00Q', 1);

/** The checkpoint of a Developer sandbox, with its annex. */
function sandboxCheckpoint(overrides: Partial<CheckpointSpec> = {}): CheckpointSpec {
  return {
    objects: [
      {
        objectApiName: 'Account',
        rows: [
          {
            Id: A1,
            Name: 'Acme',
            Industry: 'Energy',
            Phone: '+33 1 23 45 67 89',
            OwnerId: KEPT,
            RecordTypeId: BUSINESS,
            CurrencyIsoCode: 'USD',
            IsPersonAccount: false,
            Legacy_Code__c: 'L-1',
          },
          {
            Id: A2,
            Name: 'Globex',
            OwnerId: GONE,
            RecordTypeId: BUSINESS,
            CurrencyIsoCode: 'GBP',
            IsPersonAccount: false,
          },
          {
            Id: P1,
            Name: 'Jane Doe',
            FirstName: 'Jane',
            LastName: 'Doe',
            PersonEmail: 'jane@example.org',
            OwnerId: INACTIVE,
            RecordTypeId: PERSON,
            CurrencyIsoCode: 'USD',
            IsPersonAccount: true,
          },
          {
            Id: P2,
            Name: 'Rhea Roe',
            LastName: 'Roe',
            OwnerId: RENAMED,
            RecordTypeId: PERSON,
            IsPersonAccount: true,
          },
        ],
      },
      {
        objectApiName: 'Contact',
        rows: [
          {
            Id: C1,
            LastName: 'One',
            Email: 'one@example.org',
            AccountId: A1,
            OwnerId: KEPT,
            IsPersonAccount: false,
          },
          { Id: C2, LastName: 'Two', AccountId: A2, OwnerId: KEPT, IsPersonAccount: false },
          { Id: PC1, LastName: 'Doe', AccountId: P1, OwnerId: INACTIVE, IsPersonAccount: true },
          { Id: PC2, LastName: 'Roe', AccountId: P2, OwnerId: RENAMED, IsPersonAccount: true },
        ],
      },
      {
        objectApiName: 'Product2',
        rows: [
          { Id: PR1, Name: 'Widget', IsActive: true },
          { Id: PR2, Name: 'Gizmo', IsActive: true },
        ],
      },
      {
        objectApiName: 'Pricebook2',
        rows: [
          { Id: STD, Name: 'Standard Price Book', IsActive: true },
          { Id: CUS, Name: 'Partners', IsActive: true },
        ],
      },
      {
        objectApiName: 'PricebookEntry',
        rows: [
          {
            Id: E1,
            Pricebook2Id: STD,
            Product2Id: PR1,
            UnitPrice: 10,
            IsActive: true,
            CurrencyIsoCode: 'USD',
          },
          {
            Id: E2,
            Pricebook2Id: CUS,
            Product2Id: PR1,
            UnitPrice: 8,
            IsActive: true,
            CurrencyIsoCode: 'USD',
          },
          // The custom book prices one of the two products alone, as most do.
          {
            Id: E3,
            Pricebook2Id: STD,
            Product2Id: PR2,
            UnitPrice: 5,
            IsActive: true,
            CurrencyIsoCode: 'USD',
          },
        ],
      },
      {
        objectApiName: 'Opportunity',
        rows: [
          {
            Id: O1,
            Name: 'Deal',
            StageName: 'Prospecting',
            CloseDate: '2026-12-01',
            AccountId: A1,
            Pricebook2Id: CUS,
            RecordTypeId: RETAIL,
            OwnerId: KEPT,
            Description: `Moved from ${A2} after the merger`,
          },
          {
            Id: O2,
            Name: 'Other deal',
            StageName: 'Prospecting',
            CloseDate: '2026-12-01',
            AccountId: ELSEWHERE,
            RecordTypeId: SOURCE_ONLY,
            OwnerId: KEPT,
          },
        ],
      },
      {
        objectApiName: 'OpportunityLineItem',
        rows: [{ Id: L1, OpportunityId: O1, PricebookEntryId: E2, Quantity: 2 }],
      },
      {
        objectApiName: 'Task',
        rows: [
          { Id: T1, Subject: 'Call', WhatId: O1, WhoId: C1, OwnerId: KEPT },
          { Id: T2, Subject: 'Follow up', WhatId: LEAD, OwnerId: KEPT },
        ],
      },
      {
        objectApiName: 'Case',
        rows: [
          {
            Id: K1,
            Subject: 'Broken',
            AccountId: A1,
            ContactId: C1,
            OwnerId: QUEUE,
            SuppliedEmail: 'k@example.org',
          },
        ],
      },
      { objectApiName: 'ContentDocument', rows: [{ Id: D1, Title: 'Contract' }] },
    ],
    annex: {
      recordTypes: [
        {
          id: BUSINESS,
          sobjectType: 'Account',
          developerName: 'Business_Account',
          name: 'Business',
          isActive: true,
          isPersonType: false,
        },
        {
          id: PERSON,
          sobjectType: 'Account',
          developerName: 'PersonAccount',
          name: 'Person Account',
          isActive: true,
          isPersonType: true,
        },
        {
          id: RETAIL,
          sobjectType: 'Opportunity',
          developerName: 'SFX_Retail',
          name: 'Retail',
          isActive: true,
        },
        {
          id: SOURCE_ONLY,
          sobjectType: 'Opportunity',
          developerName: 'SFX_Source_Only',
          name: 'Source only',
          isActive: true,
        },
      ],
      users: [
        {
          id: KEPT,
          username: 'kept@example.com.dev1',
          name: 'Kept',
          isActive: true,
          userType: 'Standard',
        },
        {
          id: GONE,
          username: 'gone@example.com.dev1',
          name: 'Gone',
          isActive: true,
          userType: 'Standard',
        },
        {
          id: INACTIVE,
          username: 'idle@example.com.dev1',
          name: 'Idle',
          isActive: true,
          userType: 'Standard',
        },
        {
          id: RENAMED,
          username: 'rhea@example.com.dev1',
          name: 'Rhea',
          isActive: true,
          userType: 'Standard',
        },
      ],
      queues: [
        { id: QUEUE, developerName: 'Escalations', name: 'Escalations', sobjectTypes: ['Case'] },
      ],
      standardPricebookId: STD,
    },
    ...overrides,
  };
}

/** The other org: a scratch org with person accounts, USD and EUR, no GBP. */
function scratchTarget(): ReplayTargetOrg {
  return new ReplayTargetOrg({ currencies: ['USD', 'EUR'] })
    .addUser({ id: KEPT, username: 'kept@example.com' })
    .addUser({ id: INACTIVE, username: 'idle@example.com', isActive: false })
    .addUser({ id: RENAMED_THERE, username: 'rhea@example.com.uat' })
    .addRecordType({
      id: idOf('012', 21),
      sobjectType: 'Account',
      developerName: 'Business_Account',
      name: 'Business',
      defaultRecordTypeMapping: true,
    })
    .addRecordType({
      id: idOf('012', 22),
      sobjectType: 'Account',
      developerName: 'PersonAccount',
      name: 'Person Account',
      isPersonType: true,
    })
    .addRecordType({
      id: idOf('012', 23),
      sobjectType: 'Opportunity',
      developerName: 'SFX_Retail',
      name: 'Retail',
    })
    .addQueue(QUEUE_THERE, 'Escalations', ['Case'])
    .hold('Pricebook2', { Id: idOf('01s', 99), Name: 'Standard', IsStandard: true });
}

const CHOICES: CheckpointReplayChoices = {
  owners: 'same',
  customSettings: false,
  mask: false,
  contactPoints: 'neutralized',
  objects: [],
  excluded: [],
  link: [],
};

/** A checkpoint made of `spec`, converted for `target`. */
async function converted(
  spec: CheckpointSpec = sandboxCheckpoint(),
  target: ReplayTargetOrg = scratchTarget(),
  choices: Partial<CheckpointReplayChoices> = {},
): Promise<{ conversion: ReplayConversion; made: Fabricated; target: ReplayTargetOrg }> {
  const made = await fabricateCheckpoint(storeIn(), spec);
  const result = await convertCheckpoint({
    folder: made.folder,
    checkpoint: made.checkpoint,
    annex: await readReplayAnnex(made.folder),
    choices: { ...CHOICES, ...choices },
    access: target.access(),
    orgId: 'target-org',
    organizationId: target.organizationId,
    runningUserId: target.runningUserId,
    tier: 'sandbox',
    username: 'replayer@example.com.uat',
    targetName: 'UAT',
    salt: 'test-salt',
  });
  if ('refusal' in result) throw new Error(result.refusal.message);
  return { conversion: result.conversion, made, target };
}

/** The record of `objectApiName` the dataset holds for `id` of the checkpoint. */
function recordOf(
  dataset: FrozenDataset,
  objectApiName: string,
  id: string,
): FrozenRecord | undefined {
  return dataset.objects
    .find((object) => object.objectApiName === objectApiName)
    ?.records.find((record) => record.referenceId === replayReferenceIdOf(objectApiName, id));
}

const ref = replayReferenceIdOf;

describe('a checkpoint becomes the dataset a replay loads', () => {
  it('keys each record by its object and its Id, the same from one replay to the next', async () => {
    const first = await converted();
    const second = await converted();

    const keys = (dataset: FrozenDataset): string[] =>
      dataset.objects.flatMap((object) => object.records.map((record) => record.referenceId));
    expect(keys(first.conversion.dataset)).toEqual(keys(second.conversion.dataset));
    expect(keys(first.conversion.dataset)).toContain(`Account-${A1}`);
    // Every key's object is what comes before its last dash, as the loader reads it.
    for (const key of keys(first.conversion.dataset)) {
      const object = key.slice(0, key.lastIndexOf('-'));
      expect(first.conversion.dataset.objects.map((each) => each.objectApiName)).toContain(object);
    }
  });

  it('points each lookup at the key of the record it replays, and leaves a text holding an Id as it is', async () => {
    const { conversion } = await converted();
    const { dataset } = conversion;

    expect(recordOf(dataset, 'Contact', C1)?.fields.AccountId).toBe(ref('Account', A1));
    expect(recordOf(dataset, 'OpportunityLineItem', L1)?.fields).toMatchObject({
      OpportunityId: ref('Opportunity', O1),
      PricebookEntryId: ref('PricebookEntry', E2),
    });
    expect(recordOf(dataset, 'Task', T1)?.fields).toMatchObject({
      WhatId: ref('Opportunity', O1),
      WhoId: ref('Contact', C1),
    });
    expect(recordOf(dataset, 'Opportunity', O1)?.fields.Description).toBe(
      `Moved from ${A2} after the merger`,
    );
    // No stamp and no Id goes: the platform writes them, and the dates are the replay's.
    expect(recordOf(dataset, 'Account', A1)?.fields).not.toHaveProperty('Id');
    expect(recordOf(dataset, 'Account', A1)?.fields).not.toHaveProperty('CreatedById');
    expect(recordOf(dataset, 'Account', A1)?.fields).not.toHaveProperty('IsPersonAccount');
    expect(conversion.summary.auditDates).toBe('new');
  });

  it('empties an optional lookup to a record neither held nor in the other org, and says so', async () => {
    const { conversion } = await converted();

    expect(recordOf(conversion.dataset, 'Opportunity', O2)?.fields).not.toHaveProperty('AccountId');
    expect(recordOf(conversion.dataset, 'Task', T2)?.fields).not.toHaveProperty('WhatId');
    expect(conversion.summary.lookupsEmptied).toEqual([
      { field: 'Opportunity.AccountId', reason: 'objectNotHeld', records: 1 },
      { field: 'Task.WhatId', reason: 'objectNotHeld', records: 1 },
    ]);
  });

  it('keeps an owner the other org holds active, finds one by username without its sandbox’s name, and gives the others to the user who replays with why', async () => {
    const { conversion } = await converted();
    const { dataset, summary } = conversion;

    expect(recordOf(dataset, 'Account', A1)?.fields.OwnerId).toBe(KEPT);
    expect(recordOf(dataset, 'Account', P2)?.fields.OwnerId).toBe(RENAMED_THERE);
    // Sent without an owner, the record is the user's who writes it.
    expect(recordOf(dataset, 'Account', P1)?.fields).not.toHaveProperty('OwnerId');
    expect(recordOf(dataset, 'Case', K1)?.fields.OwnerId).toBe(QUEUE_THERE);
    // Kept: A1, P2, C1, PC2, O1, O2, T1, T2, and K1 by its queue. P1 and PC1
    // go to the user who replays; A2 and C2 are refused (GBP), and not counted.
    expect(summary.owners).toEqual({
      kept: 9,
      toRunningUser: 2,
      reasons: { notInTarget: 0, inactive: 2, queueMissing: 0 },
    });
  });

  it('never sends an owner of the checkpoint’s org the other org does not hold', async () => {
    const { conversion } = await converted();

    const owners = conversion.dataset.objects.flatMap((object) =>
      object.records.map((record) => record.fields.OwnerId).filter((id) => id !== undefined),
    );
    expect(owners).not.toContain(GONE);
    expect(owners).not.toContain(INACTIVE);
    expect(owners).not.toContain(RENAMED);
  });

  it('finds record types by developer name, and leaves one the other org lacks to its default, counted by object', async () => {
    const { conversion } = await converted();
    const { dataset, summary } = conversion;

    expect(recordOf(dataset, 'Opportunity', O1)).toMatchObject({
      fields: { RecordTypeId: 'Retail' },
      recordTypeDeveloperName: 'SFX_Retail',
    });
    expect(recordOf(dataset, 'Opportunity', O2)?.fields).not.toHaveProperty('RecordTypeId');
    expect(summary.recordTypes).toEqual([
      { object: 'Account', recordType: 'Business_Account', outcome: 'byName', records: 1 },
      { object: 'Account', recordType: 'PersonAccount', outcome: 'byName', records: 2 },
      { object: 'Opportunity', recordType: 'SFX_Retail', outcome: 'byName', records: 1 },
      { object: 'Opportunity', recordType: 'SFX_Source_Only', outcome: 'default', records: 1 },
    ]);
    expect(dataset.recordTypes.Opportunity).toEqual([
      { name: 'Retail', developerName: 'SFX_Retail', namespacePrefix: null },
    ]);
  });

  it('sends a person account without its name and its contact beside it, for the platform to write with it', async () => {
    const { conversion } = await converted();
    const { dataset } = conversion;

    expect(recordOf(dataset, 'Account', P1)?.fields).not.toHaveProperty('Name');
    expect(recordOf(dataset, 'Account', P1)?.fields.LastName).toBe('Doe');
    expect(recordOf(dataset, 'Account', A1)?.fields).not.toHaveProperty('LastName');
    expect(dataset.personContactSidecar).toEqual([
      { accountReferenceId: ref('Account', P1), contactReferenceId: ref('Contact', PC1) },
      { accountReferenceId: ref('Account', P2), contactReferenceId: ref('Contact', PC2) },
    ]);
  });

  it('refuses before any write the rows in a currency the other org has not activated, and their children', async () => {
    const { conversion } = await converted();
    const { dataset, summary } = conversion;

    expect(recordOf(dataset, 'Account', A2)).toBeUndefined();
    expect(recordOf(dataset, 'Contact', C2)).toBeUndefined();
    expect(summary.currencies).toEqual({ refused: [{ code: 'GBP', records: 1 }] });
    expect(summary.refused).toEqual([
      {
        object: 'Account',
        records: 1,
        reason: 'inactiveCurrency',
        path: 'activate GBP in UAT, or leave Account out',
      },
      {
        object: 'Contact',
        records: 1,
        reason: 'parentRefused',
        path: 'its Account is refused: lift that first',
      },
    ]);
    expect(summary.records.refusedBeforeWrite).toBe(2);
  });

  it('matches the standard price book to the other org’s through the annex, never making one', async () => {
    const { conversion } = await converted();
    const { dataset, summary } = conversion;

    expect(dataset.standardPricebook).toBe(ref('Pricebook2', STD));
    expect(recordOf(dataset, 'PricebookEntry', E1)?.fields.Pricebook2Id).toBe(
      ref('Pricebook2', STD),
    );
    expect(summary.standardPricebook).toBe('annex');
    const created = dataset.objects.reduce((sum, object) => sum + object.records.length, 0);
    expect(summary.records.toCreate).toBe(created - 1);
  });

  it('replays no file, and names each left with why', async () => {
    const { conversion } = await converted();

    expect(conversion.dataset.objects.map((object) => object.objectApiName)).not.toContain(
      'ContentDocument',
    );
    expect(conversion.summary.notReplayed).toEqual([
      { object: 'ContentDocument', reason: 'fileContentNotKept', records: 1 },
    ]);
    expect(conversion.filesLeft).toEqual([
      { objectApiName: 'ContentDocument', id: D1, name: 'Contract' },
    ]);
  });

  it('makes email addresses and phone numbers unreachable unless they are kept', async () => {
    const neutralized = await converted();
    const kept = await converted(undefined, undefined, { contactPoints: 'kept' });

    expect(recordOf(neutralized.conversion.dataset, 'Contact', C1)?.fields.Email).toBe(
      'one@example.org.invalid',
    );
    expect(recordOf(neutralized.conversion.dataset, 'Account', A1)?.fields.Phone).toMatch(
      /^\+33 6 39 98 \d\d \d\d$/,
    );
    expect(recordOf(kept.conversion.dataset, 'Contact', C1)?.fields.Email).toBe('one@example.org');
    expect(kept.conversion.summary.contactPoints).toBe('kept');
  });

  it('names the fields the other org does not have, which the replay leaves out', async () => {
    const { conversion } = await converted();

    expect(conversion.summary.fieldsNotInTarget).toEqual([
      { object: 'Account', fields: ['Legacy_Code__c'] },
    ]);
    expect(recordOf(conversion.dataset, 'Account', A1)?.fields).not.toHaveProperty(
      'Legacy_Code__c',
    );
  });

  it('says the annex is whole, and that dates and creators are the replay’s', async () => {
    const { conversion } = await converted();

    expect(conversion.summary.degraded).toEqual([]);
    expect(conversion.summary.masked).toEqual({ fields: [] });
  });
});

describe('the choices of a replay', () => {
  it('gives every record to the user who replays with owners “me”', async () => {
    const { conversion } = await converted(undefined, undefined, { owners: 'me' });

    const owners = conversion.dataset.objects.flatMap((object) =>
      object.records.filter((record) => 'OwnerId' in record.fields),
    );
    expect(owners).toEqual([]);
    expect(conversion.summary.owners.kept).toBe(0);
    expect(conversion.summary.owners.reasons).toEqual({
      notInTarget: 0,
      inactive: 0,
      queueMissing: 0,
    });
  });

  it('gives a user’s records to the user the owner map names, and refuses a map to a user the other org holds inactive or not at all', async () => {
    const mapped = await converted(undefined, undefined, { ownerMap: { [GONE]: RENAMED_THERE } });
    expect(mapped.conversion.summary.owners.reasons.notInTarget).toBe(0);

    const made = await fabricateCheckpoint(storeIn(), sandboxCheckpoint());
    const target = scratchTarget();
    const ask = async (ownerMap: Record<string, string>) =>
      convertCheckpoint({
        folder: made.folder,
        checkpoint: made.checkpoint,
        annex: await readReplayAnnex(made.folder),
        choices: { ...CHOICES, ownerMap },
        access: target.access(),
        orgId: 'target-org',
        organizationId: target.organizationId,
        runningUserId: target.runningUserId,
        tier: 'scratch',
        targetName: 'UAT',
      });
    expect(await ask({ [KEPT]: INACTIVE })).toMatchObject({
      refusal: { code: 'OWNER_MAP_INACTIVE', users: [INACTIVE] },
    });
    expect(await ask({ [KEPT]: idOf('005', 55) })).toMatchObject({
      refusal: { code: 'OWNER_MAP_UNKNOWN', users: [idOf('005', 55)] },
    });
  });

  it('empties a lookup to an object left out, and refuses a row whose required lookup it was, with the path that lifts it', async () => {
    const { conversion } = await converted(undefined, undefined, { excluded: ['Opportunity'] });

    expect(recordOf(conversion.dataset, 'Task', T1)?.fields).not.toHaveProperty('WhatId');
    expect(recordOf(conversion.dataset, 'OpportunityLineItem', L1)).toBeUndefined();
    expect(conversion.summary.refused).toContainEqual({
      object: 'OpportunityLineItem',
      records: 1,
      reason: 'requiredLookupMissing',
      path: 'replay Opportunity too',
    });
    expect(conversion.summary.notReplayed).toContainEqual({
      object: 'Opportunity',
      reason: 'excluded',
      records: 2,
    });
  });

  it('masks personal data when asked, names the fields masked and the free texts it does not read', async () => {
    const { conversion } = await converted(undefined, undefined, { mask: true });

    const contact = recordOf(conversion.dataset, 'Contact', C1);
    expect(contact?.fields.LastName).not.toBe('One');
    expect(String(contact?.fields.Email)).toMatch(/\.invalid$/);
    expect(conversion.summary.masked.fields).toEqual(
      expect.arrayContaining([
        'Account.LastName',
        'Account.PersonEmail',
        'Contact.Email',
        'Contact.LastName',
      ]),
    );
    expect(conversion.summary.masked.unmaskedFreeText).toContain('Opportunity.Description');
    // A lookup is never masked.
    expect(contact?.fields.AccountId).toBe(ref('Account', A1));
  });

  it('sets up a list setting’s rows the other org lacks and a hierarchy’s org-wide and profile rows, never over one there', async () => {
    const LIST = 'Lst__c';
    const HIER = 'Hier__c';
    const spec = sandboxCheckpoint({
      objects: [
        {
          objectApiName: LIST,
          customSetting: 'list',
          rows: [
            { Id: idOf('a01', 1), Name: 'Alpha', SetupOwnerId: SOURCE_ORG_ID, Value__c: '1' },
            { Id: idOf('a01', 2), Name: 'Beta', SetupOwnerId: SOURCE_ORG_ID, Value__c: '2' },
          ],
        },
        {
          objectApiName: HIER,
          customSetting: 'hierarchy',
          rows: [
            { Id: idOf('a02', 1), SetupOwnerId: SOURCE_ORG_ID, Value__c: 'org' },
            { Id: idOf('a02', 2), SetupOwnerId: PROFILE, Value__c: 'profile' },
            { Id: idOf('a02', 3), SetupOwnerId: GONE, Value__c: 'user' },
          ],
        },
      ],
    });
    const target = scratchTarget()
      .withObject(LIST, settingFields('list'))
      .withObject(HIER, settingFields('hierarchy'))
      .hold(LIST, { Id: idOf('a01', 51), Name: 'Alpha', SetupOwnerId: TARGET_ORG_ID })
      .hold('Profile', { Id: PROFILE });

    const without = await converted(spec, target);
    expect(without.conversion.dataset.objects).toEqual([]);
    expect(without.conversion.summary.notReplayed).toEqual([
      { object: LIST, reason: 'excluded', records: 2 },
      { object: HIER, reason: 'excluded', records: 3 },
    ]);

    const { conversion } = await converted(spec, target, { customSettings: true });
    const rows = (object: string) =>
      conversion.dataset.objects.find((each) => each.objectApiName === object)?.records ?? [];
    expect(rows(LIST).map((row) => row.fields.Name)).toEqual(['Beta']);
    expect(rows(HIER).map((row) => row.fields.SetupOwnerId)).toEqual([TARGET_ORG_ID, PROFILE]);
    expect(conversion.summary.customSettings).toEqual({ inserted: 3, alreadyThere: 1 });
    expect(conversion.summary.refused).toEqual([
      {
        object: HIER,
        records: 1,
        reason: 'requiredLookupMissing',
        path: 'the user its row is of is not in UAT',
      },
    ]);
  });
});

describe('what the other org is', () => {
  it('refuses person accounts and their contacts before any write in an org without them', async () => {
    const target = new ReplayTargetOrg({ personAccounts: false, currencies: ['USD', 'EUR', 'GBP'] })
      .addUser({ id: KEPT, username: 'kept@example.com' })
      .addRecordType({
        id: idOf('012', 21),
        sobjectType: 'Account',
        developerName: 'Business_Account',
      });

    const { conversion } = await converted(undefined, target);

    expect(recordOf(conversion.dataset, 'Account', P1)).toBeUndefined();
    expect(recordOf(conversion.dataset, 'Contact', PC1)).toBeUndefined();
    expect(conversion.summary.refused).toContainEqual({
      object: 'Account',
      records: 2,
      reason: 'personAccountsUnsupported',
      path: 'turn person accounts on in UAT, or leave Account out',
    });
    expect(conversion.dataset.personContactSidecar).toEqual([]);
    // Never asked for a column such an org does not have.
    expect(target.asked.some((soql) => soql.includes('IsPersonType'))).toBe(false);
  });

  it('takes the amounts of an org of one currency as they are, and says so', async () => {
    const target = scratchTarget();
    const single = new ReplayTargetOrg()
      .addUser({ id: KEPT, username: 'kept@example.com' })
      .addRecordType({
        id: idOf('012', 22),
        sobjectType: 'Account',
        developerName: 'PersonAccount',
        isPersonType: true,
      });
    void target;

    const { conversion } = await converted(undefined, single);

    expect(recordOf(conversion.dataset, 'Account', A2)?.fields).not.toHaveProperty(
      'CurrencyIsoCode',
    );
    expect(conversion.summary.currencies).toEqual({ refused: [], singleCurrencyTarget: true });
    expect(conversion.summary.fieldsNotInTarget).toEqual([
      { object: 'Account', fields: ['Legacy_Code__c'] },
    ]);
    expect(single.asked.some((soql) => soql.includes('CurrencyType'))).toBe(false);
  });

  it('links the records the other org holds under the same Ids, never writing them, and points the replayed ones at them', async () => {
    const target = scratchTarget().hold('Account', { Id: A1, Name: 'Acme there' });

    const { conversion } = await converted(undefined, target);

    expect(recordOf(conversion.dataset, 'Account', A1)).toBeUndefined();
    expect(recordOf(conversion.dataset, 'Contact', C1)?.fields.AccountId).toBe(A1);
    expect(conversion.linkedById.get(ref('Account', A1))).toBe(A1);
    expect(conversion.summary.records.linkedById).toBe(1);
  });

  it('points the prices at the standard price book the other org holds under the same Id, never making one', async () => {
    const target = scratchTarget().hold('Pricebook2', {
      Id: STD,
      Name: 'Standard',
      IsStandard: true,
    });

    const { conversion } = await converted(undefined, target);

    expect(recordOf(conversion.dataset, 'PricebookEntry', E1)?.fields.Pricebook2Id).toBe(STD);
    expect(recordOf(conversion.dataset, 'Pricebook2', STD)).toBeUndefined();
    expect(conversion.dataset).not.toHaveProperty('standardPricebook');
    expect(conversion.summary.lookupsEmptied).not.toContainEqual(
      expect.objectContaining({ field: 'PricebookEntry.Pricebook2Id' }),
    );
  });

  it('reads 200 Ids of an object first, and every one only when some are there', async () => {
    const many = Array.from({ length: 450 }, (_, n) => ({
      Id: idOf('a05', n + 1),
      Name: `Row ${n}`,
    }));
    const spec: CheckpointSpec = { objects: [{ objectApiName: 'Thing__c', rows: many }] };
    const fields = [
      { name: 'Id', type: 'id', createable: false, nillable: false, defaultedOnCreate: true },
      { name: 'Name', type: 'string', createable: true, nillable: true, defaultedOnCreate: false },
    ];
    const none = new ReplayTargetOrg().withObject('Thing__c', fields);
    await converted(spec, none);
    expect(none.asked.filter((soql) => soql.startsWith('SELECT Id FROM Thing__c'))).toHaveLength(1);

    const copied = new ReplayTargetOrg().withObject('Thing__c', fields).hold('Thing__c', many[0]);
    const { conversion } = await converted(spec, copied);
    expect(copied.asked.filter((soql) => soql.startsWith('SELECT Id FROM Thing__c'))).toHaveLength(
      3,
    );
    expect(conversion.summary.records).toMatchObject({ toCreate: 449, linkedById: 1 });
  });

  it('refuses the rows of a record type the user who replays may not create records of', async () => {
    const target = scratchTarget().addRecordType({
      id: idOf('012', 24),
      sobjectType: 'Opportunity',
      developerName: 'SFX_Source_Only',
      available: false,
    });

    const { conversion } = await converted(undefined, target);

    expect(recordOf(conversion.dataset, 'Opportunity', O2)).toBeUndefined();
    expect(conversion.summary.refused).toContainEqual({
      object: 'Opportunity',
      records: 1,
      reason: 'recordTypeUnavailable',
      path: 'SFX_Source_Only is not assigned to the user who replays in UAT: assign it to them, or leave Opportunity out',
    });
  });

  it('names an object the other org does not have among those not replayed', async () => {
    const spec = sandboxCheckpoint();
    spec.objects.push({ objectApiName: 'Gadget__c', rows: [{ Id: idOf('a07', 1), Name: 'G' }] });

    const { conversion } = await converted(spec);

    expect(conversion.summary.notReplayed).toContainEqual({
      object: 'Gadget__c',
      reason: 'notInTarget',
      records: 1,
    });
  });

  it('goes into an org a load is allowed in alone: production and Staging refuse it, as any load', async () => {
    const { conversion } = await converted();
    const load = (orgTier: 'production' | 'staging' | 'scratch') =>
      assertLoadGuards({
        orgId: TARGET_ORG_ID,
        orgTier,
        dataset: conversion.dataset,
        mockDetector: { areCalloutsMocked: async () => true },
      });

    await expect(load('production')).rejects.toMatchObject({ code: 'non-sandbox' });
    await expect(load('staging')).rejects.toMatchObject({ code: 'non-sandbox' });
    await expect(load('scratch')).resolves.toBeUndefined();
  });
});

describe('a checkpoint taken before 1.81, without an annex', () => {
  /** The checkpoint without its annex, as a take before 1.81 leaves it. */
  const before181 = (): CheckpointSpec => ({ ...sandboxCheckpoint(), annex: undefined });

  it('finds a record type by its Id where the other org holds it, else gives the default, and says what it lacked', async () => {
    const target = scratchTarget().addRecordType({
      id: SOURCE_ONLY,
      sobjectType: 'Opportunity',
      developerName: 'Copied_Type',
    });

    const { conversion } = await converted(before181(), target);

    expect(recordOf(conversion.dataset, 'Opportunity', O2)).toMatchObject({
      fields: { RecordTypeId: 'Copied_Type' },
      recordTypeDeveloperName: 'Copied_Type',
    });
    expect(conversion.summary.recordTypes).toContainEqual({
      object: 'Opportunity',
      recordType: SOURCE_ONLY,
      outcome: 'byId',
      records: 1,
    });
    expect(conversion.summary.recordTypes).toContainEqual({
      object: 'Opportunity',
      recordType: RETAIL,
      outcome: 'default',
      records: 1,
    });
    expect(conversion.summary.degraded).toEqual([
      'recordTypes',
      'users',
      'queues',
      'standardPricebook',
    ]);
  });

  it('gives a person account the other org’s one person account type, an owner not under the same Id to the user who replays, a queue not under the same Id too', async () => {
    const { conversion } = await converted(before181());

    expect(recordOf(conversion.dataset, 'Account', P1)?.fields.RecordTypeId).toBe('Person Account');
    expect(recordOf(conversion.dataset, 'Account', P2)?.fields).not.toHaveProperty('OwnerId');
    // P2 and its contact, owned by a user the other org holds under no such Id.
    expect(conversion.summary.owners.reasons).toEqual({
      notInTarget: 2,
      inactive: 2,
      queueMissing: 1,
    });
  });

  it('tells the standard price book by the prices: the book that prices every product the others price', async () => {
    const { conversion } = await converted(before181());

    expect(conversion.summary.standardPricebook).toBe('deduced');
    expect(conversion.dataset.standardPricebook).toBe(ref('Pricebook2', STD));
  });

  it('refuses the prices when two books price every product, and the line items under them', async () => {
    const spec = before181();
    const entries = spec.objects.find((object) => object.objectApiName === 'PricebookEntry');
    entries?.rows.push({
      Id: idOf('01u', 4),
      Pricebook2Id: CUS,
      Product2Id: PR2,
      UnitPrice: 1,
      CurrencyIsoCode: 'USD',
    });

    const { conversion } = await converted(spec);

    expect(conversion.summary.standardPricebook).toBe('ambiguous');
    expect(recordOf(conversion.dataset, 'PricebookEntry', E1)).toBeUndefined();
    expect(recordOf(conversion.dataset, 'OpportunityLineItem', L1)).toBeUndefined();
    expect(conversion.summary.refused).toContainEqual(
      expect.objectContaining({
        object: 'PricebookEntry',
        reason: 'requiredLookupMissing',
        records: 4,
      }),
    );
    expect(conversion.summary.refused).toContainEqual(
      expect.objectContaining({
        object: 'OpportunityLineItem',
        reason: 'parentRefused',
        records: 1,
      }),
    );
  });

  it('converts the file SandForge 1.80 exported, received with its key, without its org', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-replay-180-'));
    dirs.push(dir);
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '..', 'fixtures', 'checkpoint-1.80.sfcheckpoint.json'), 'utf8'),
    ) as { key: string; base64: string };
    const file = join(dir, `made-by-1.80${ARCHIVE_EXTENSION}`);
    writeFileSync(file, Buffer.from(fixture.base64, 'base64'), { mode: 0o600 });
    const key = parseArchiveKey(fixture.key);
    if (key === undefined) throw new Error('the fixture holds no key');
    const received = await importReceivedArchive({
      storeRoot: join(dir, 'store'),
      locksDir: join(dir, 'locks'),
      file,
      key,
      keepDays: 30,
      takenOn: { host: 'laptop', pid: 7 },
    });
    if (!received.imported || received.store === undefined) throw new Error('not imported');
    const { checkpoint } = received;
    const folder = received.store.folderOf(checkpoint.org.organizationId, checkpoint.checkpointId);
    const target = new ReplayTargetOrg().withObject('Hier__c', settingFields('hierarchy'));

    const source = { folder, checkpoint, annex: await readReplayAnnex(folder) };
    const survey = await surveyCheckpoint({
      ...source,
      choices: { ...CHOICES, customSettings: true },
    });
    const result = await convertCheckpoint({
      ...source,
      choices: { ...CHOICES, customSettings: true },
      access: target.access(),
      orgId: 'target-org',
      organizationId: target.organizationId,
      runningUserId: target.runningUserId,
      tier: 'scratch',
      targetName: 'SCRATCH',
    });
    if ('refusal' in result) throw new Error(result.refusal.message);

    expect(source.annex).toBeUndefined();
    expect(survey.objects.records).toBe(6 + 2);
    const { summary, dataset } = result.conversion;
    expect(summary.degraded).toEqual(['recordTypes', 'users', 'queues', 'standardPricebook']);
    expect(
      dataset.objects.find((object) => object.objectApiName === 'Account')?.records,
    ).toHaveLength(6);
    expect(summary.notReplayed).toContainEqual({
      object: 'ContentDocument',
      reason: 'fileContentNotKept',
      records: 1,
    });
    expect(summary.customSettings?.inserted).toBeGreaterThan(0);
    // The other org is the only one asked anything.
    expect(target.asked.every((soql) => !soql.includes(checkpoint.org.organizationId))).toBe(true);
  });
});

describe('a conversion from a survey and a reading given apart', () => {
  it('converts what it is handed, with the same result as the three steps together', async () => {
    const made = await fabricateCheckpoint(storeIn(), sandboxCheckpoint());
    const annex = await readReplayAnnex(made.folder);
    const target = scratchTarget();
    const together = await convertCheckpoint({
      folder: made.folder,
      checkpoint: made.checkpoint,
      annex,
      choices: CHOICES,
      access: target.access(),
      orgId: 'target-org',
      organizationId: target.organizationId,
      runningUserId: target.runningUserId,
      tier: 'sandbox',
      username: 'replayer@example.com.uat',
      targetName: 'UAT',
      salt: 'same',
    });
    if ('refusal' in together) throw new Error(together.refusal.message);

    const apart = await checkpointToDataset({
      folder: made.folder,
      checkpoint: made.checkpoint,
      annex,
      choices: CHOICES,
      survey: together.survey,
      target: together.target,
      targetName: 'UAT',
      salt: 'same',
    });

    expect(apart).toEqual({ conversion: together.conversion });
    expect(together.target.requests).toBeGreaterThan(0);
  });
});

describe('the files of a checkpoint', () => {
  it('links again a file the other org holds under the same Id to the record replayed it was linked to, and no other', async () => {
    const spec = sandboxCheckpoint({
      files: {
        links: [
          {
            Id: idOf('06A', 1),
            ContentDocumentId: D1,
            LinkedEntityId: A1,
            ShareType: 'V',
            Visibility: 'AllUsers',
          },
          {
            Id: idOf('06A', 2),
            ContentDocumentId: idOf('069', 2),
            LinkedEntityId: O1,
            ShareType: 'V',
            Visibility: 'AllUsers',
          },
        ],
        documents: [
          { Id: D1, LatestPublishedVersionId: null, ContentSize: 10, anchored: true },
          { Id: idOf('069', 2), LatestPublishedVersionId: null, ContentSize: 10, anchored: true },
        ],
      },
    });
    const target = scratchTarget().hold('ContentDocument', { Id: D1, Title: 'Contract' });

    const { conversion } = await converted(spec, target);

    const links = conversion.dataset.objects.find(
      (object) => object.objectApiName === 'ContentDocumentLink',
    )?.records;
    expect(links).toEqual([
      {
        referenceId: `ContentDocumentLink-${D1}_${A1}`,
        fields: {
          ContentDocumentId: D1,
          LinkedEntityId: ref('Account', A1),
          ShareType: 'V',
          Visibility: 'AllUsers',
        },
      },
    ]);
  });
});

describe('a checkpoint a take made', () => {
  it('converts what the take kept, its owners found through its annex', async () => {
    vi.mocked(getJsforceConnection).mockReset();
    const t = await taken(
      (org) => {
        org.add('Account', { Id: account(1), Name: 'One', OwnerId: MEMORY_ORG_USER });
        org.add('Contact', { Id: contact(1), LastName: 'Uno', AccountId: account(1) });
      },
      takenOrg(),
      ['Account', 'Contact'],
    );
    const target = new ReplayTargetOrg().addUser({
      id: idOf('005', 9),
      username: 'ada@example.com',
    });

    const result = await convertCheckpoint({
      folder: t.folder,
      checkpoint: t.checkpoint,
      annex: await readReplayAnnex(t.folder),
      choices: CHOICES,
      access: target.access(),
      orgId: 'target-org',
      organizationId: target.organizationId,
      runningUserId: target.runningUserId,
      tier: 'scratch',
      targetName: 'SCRATCH',
    });
    removeTaken();
    if ('refusal' in result) throw new Error(result.refusal.message);

    const { dataset, summary } = result.conversion;
    expect(recordOf(dataset, 'Account', account(1))?.fields).toEqual({
      Name: 'One',
      OwnerId: idOf('005', 9),
    });
    expect(recordOf(dataset, 'Contact', contact(1))?.fields).toEqual({
      LastName: 'Uno',
      AccountId: ref('Account', account(1)),
    });
    expect(summary.owners).toMatchObject({ kept: 1, toRunningUser: 0 });
    expect(summary.degraded).toEqual([]);
  });
});
