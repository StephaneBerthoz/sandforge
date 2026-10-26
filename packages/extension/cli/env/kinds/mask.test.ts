import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvMaskResource, EnvResourceState } from '@sandforge/shared';
import { missingFieldLine } from '../../sandforge-dataops.js';
import {
  forgetMaskStore,
  maskApplyLine,
  maskDeleteWhy,
  maskDryRead,
  maskDryRunCount,
  maskDryRunLine,
  maskForgottenLine,
  maskHeldOf,
  maskingSetsOf,
  maskNotes,
  maskObjectsOf,
  maskReplaceWords,
  maskRunCount,
  maskRunOfResource,
  maskWritten,
  readMaskDryRun,
  readMaskRun,
  type MaskDryRunAnswer,
  type MaskRunAnswer,
} from './mask.js';

/*
 * The mask kind: DataOps rules held to the panel's own save, the lines of
 * `sandforge-dataops`, its answers read with zod, what the org holds of a
 * masking applied, the words the plan and the destroy say, and the store a
 * destroy deletes — never a value put back.
 */

const SETS = {
  'contact-points': {
    name: 'contact-points',
    rules: [
      { fieldPattern: 'Contact.Email', ruleType: 'fake' as const },
      { fieldPattern: 'Contact.Phone', ruleType: 'mask' as const, config: { maskKeepLast: 2 } },
    ],
  },
};

const resource: EnvMaskResource = {
  kind: 'mask',
  rules: 'contact-points',
  object: 'Contact',
  where: "LastName = 'Copied'",
};

function runOf(over: Partial<EnvMaskResource> = {}) {
  const converted = maskRunOfResource('customers', { ...resource, ...over }, SETS);
  if ('refusals' in converted) throw new Error(converted.refusals.map((r) => r.message).join());
  return converted;
}

/** A dry run's answer, as the script prints it with --json, the panel's messages in it. */
function dryAnswer(over: {
  objects?: Array<{ objectApiName: string; count: number | null }>;
  preview?: Array<{ objectApiName: string; fields: string[]; error?: string }>;
  fieldsNotFound?: Array<{ objectApiName: string; fieldApiName: string }>;
  error?: string;
}): MaskDryRunAnswer {
  return {
    tool: 'sandforge-dataops',
    command: 'dry-run',
    org: 'TGT',
    posted: [
      ...(over.error !== undefined
        ? [{ type: 'dataops:error', payload: { message: over.error } }]
        : [
            {
              type: 'dataops:anonymize:coverage:response',
              payload: { objects: over.objects ?? [{ objectApiName: 'Contact', count: 2 }] },
            },
            {
              type: 'dataops:anonymize:preview:response',
              payload: {
                objects: over.preview ?? [
                  { objectApiName: 'Contact', fields: ['Email', 'Phone'], rows: [] },
                ],
                fieldsNotFound: over.fieldsNotFound ?? [],
              },
            },
          ]),
    ],
  };
}

describe('the masking sets of a file', () => {
  it('holds each set to the rules the DataOps panel saves, refused where the file wrote them', () => {
    expect(maskingSetsOf({ a: { rules: SETS['contact-points'].rules } })).toEqual({
      sets: { a: { name: 'a', rules: SETS['contact-points'].rules } },
    });
    expect(
      maskingSetsOf({
        twice: {
          rules: [
            { fieldPattern: 'Contact.Email', ruleType: 'fake' },
            { fieldPattern: 'Contact.EMAIL', ruleType: 'hash' },
          ],
        },
      }),
    ).toEqual({
      refusals: [
        {
          path: ['masking', 'twice', 'rules'],
          message: 'refused by the rules the DataOps panel saves: A field has two rules',
        },
      ],
    });
  });
});

describe('a mask resource, converted', () => {
  it('takes the rules of the set it names, or of a template that ships, with what it masks', () => {
    expect(runOf().run).toEqual({
      source: { set: 'contact-points' },
      rules: SETS['contact-points'],
      object: 'Contact',
      where: "LastName = 'Copied'",
    });
    const shipped = runOf({
      rules: { template: 'tpl-sandbox-scrub' },
      object: undefined,
      where: undefined,
    });
    expect(shipped.run.source).toEqual({ template: 'tpl-sandbox-scrub' });
    expect(shipped.run.rules.rules.length).toBeGreaterThan(0);
    expect(maskObjectsOf(shipped.run).length).toBeGreaterThan(0);
    expect(maskObjectsOf(runOf().run)).toEqual([{ object: 'Contact' }]);
  });

  it('refuses an object its rules hold no rule for, but takes Account, whose person accounts the contact rules mask', () => {
    expect(
      maskRunOfResource('customers', { ...resource, object: 'Case', where: undefined }, SETS),
    ).toEqual({
      refusals: [
        {
          path: ['resources', 'customers', 'object'],
          resource: 'customers',
          message:
            'the rule set contact-points has no rule for Case: a run would mask nothing. Name an object its rules mask, or give it a rule for this one',
        },
      ],
    });
    expect('run' in maskRunOfResource('customers', { ...resource, object: 'Account' }, SETS)).toBe(
      true,
    );
  });

  it('warns of a condition reading a field its rules write over, but not of one asking whether it is empty', () => {
    const warned = runOf({ where: "Email LIKE '%@example.com' AND LastName = 'Copied'" });
    expect(warned.warnings.map((w) => w.message)).toEqual([
      'its condition reads Email, which its rules write over: once masked, its records may no longer be those it selects, and a plan after reads them as gone. Select them by a field its rules leave as it is',
    ]);
    // Negative controls: an emptiness test, and a field named only in a value.
    expect(runOf({ where: 'Email != null' }).warnings).toEqual([]);
    expect(runOf({ where: "LastName = 'Email = x'" }).warnings).toEqual([]);
  });

  it('fingerprints the rules by what they do: their order and the name of their set aside', () => {
    const reversed = maskRunOfResource(
      'customers',
      { ...resource, rules: 'b' },
      {
        b: { name: 'b', rules: [...SETS['contact-points'].rules].reverse() },
      },
    );
    if (!('run' in reversed)) throw new Error('refused');

    expect(maskWritten(reversed.run)).toEqual(maskWritten(runOf().run));
    expect(maskWritten(runOf({ where: undefined }).run)).not.toEqual(maskWritten(runOf().run));
  });
});

describe('the lines of a mask resource', () => {
  it('runs sandforge-dataops anonymize on the org, in the resource’s own store: a dry run, then a run unasked', () => {
    const input = { target: 'TGT', run: runOf().run, rulesFile: '/r.json', store: '/s' };

    expect(maskDryRunLine(input)).toEqual([
      'anonymize',
      '--org',
      'TGT',
      '--object',
      'Contact',
      '--where',
      "LastName = 'Copied'",
      '--rules',
      '/r.json',
      '--store',
      '/s',
      '--dry-run',
      '--json',
    ]);
    expect(maskApplyLine(input).slice(-2)).toEqual(['--yes', '--json']);
    expect(() => maskApplyLine({ ...input, target: '-x' })).toThrow('reads as a flag');
  });
});

describe('what the script answers', () => {
  it('counts per object what a dry run would mask, creating nothing and taking no storage', () => {
    expect(maskDryRunCount(dryAnswer({}))).toEqual({
      objects: [{ object: 'Contact', wouldCreate: 2 }],
      total: 2,
      created: 0,
      storageBytes: 0,
      emails: [],
    });
  });

  it('refuses in the script’s words a field the org lacks, an object it would not count or read, and rules masking none of its fields', () => {
    expect(
      maskDryRead(
        dryAnswer({ fieldsNotFound: [{ objectApiName: 'Contact', fieldApiName: 'Nickname__c' }] }),
      ).refusals,
    ).toEqual([missingFieldLine('Contact', 'Nickname__c')]);
    expect(
      maskDryRead(dryAnswer({ objects: [{ objectApiName: 'Contact', count: null }] })).refusals,
    ).toEqual(['Contact: the org did not count the records it would mask']);
    expect(
      maskDryRead(dryAnswer({ preview: [{ objectApiName: 'Contact', fields: [], error: 'no' }] }))
        .refusals,
    ).toEqual(['Contact: not read: no']);
    expect(
      maskDryRead(dryAnswer({ preview: [{ objectApiName: 'Contact', fields: [] }] })).refusals,
    ).toEqual([
      'Contact: its rules mask no field the org shows this user: a run would mask nothing there',
    ]);
    expect(maskDryRunCount(dryAnswer({ error: 'refused by the guard' })).refusal).toBe(
      'refused by the guard',
    );
    // Negative control: a dry run that says nothing is refused, never taken for nothing to mask.
    expect(
      maskDryRunCount({ tool: 'sandforge-dataops', command: 'dry-run', org: 'T', posted: [] })
        .refusal,
    ).toContain('the masking never came to say what it would mask');
  });

  it('reads a run’s answer: per object what it went through, the snapshot it took first, and what it left', () => {
    const answer: MaskRunAnswer = {
      tool: 'sandforge-dataops',
      command: 'run',
      org: 'TGT',
      posted: [
        {
          type: 'dataops:anonymize:response',
          payload: {
            status: 'partial',
            objects: [
              { objectApiName: 'Contact', total: 3, processed: 2, failed: 1, notMasked: 1 },
            ],
            fieldsNotFound: [{ objectApiName: 'Contact', fieldApiName: 'Nickname__c' }],
            snapshot: { operationId: 'cli-dataops-anonymize-1-a-snapshot', totalRecords: 3 },
          },
        },
      ],
    };

    expect(maskRunCount(answer)).toEqual({
      objects: [{ object: 'Contact', masked: 2, refused: 1, notMasked: 1 }],
      snapshotId: 'cli-dataops-anonymize-1-a-snapshot',
      short: missingFieldLine('Contact', 'Nickname__c'),
    });
    // A failure names its snapshot too: that is when one is wanted.
    expect(
      maskRunCount({
        ...answer,
        posted: [
          {
            type: 'dataops:error',
            payload: { message: 'QUERY_TIMEOUT', snapshot: { operationId: 'x-snapshot' } },
          },
        ],
      }),
    ).toEqual({ objects: [], snapshotId: 'x-snapshot', refusal: 'QUERY_TIMEOUT' });
    // Nothing under its condition: no result posted, nothing masked.
    expect(maskRunCount({ ...answer, posted: [] })).toEqual({ objects: [] });
  });

  it('refuses to read what is not an answer of the script, naming it', () => {
    expect(() => readMaskDryRun('{"tool":"sandforge-seed"}')).toThrow(
      'sandforge-dataops did not answer the answer of a dry run',
    );
    expect(() => readMaskRun('refused')).toThrow(
      'sandforge-dataops did not answer the answer of a masking (not JSON)',
    );
  });
});

describe('what the org holds of a masking applied', () => {
  const kept = (masked: number): Pick<EnvResourceState, 'runs'> => ({
    runs: [
      {
        n: 1,
        script: 'sandforge-dataops',
        snapshotId: 's1-snapshot',
        startedAt: '2026-10-25T09:00:00.000Z',
        objects: [{ objectApiName: 'Contact', created: 0, refused: 0, masked }],
      },
    ],
  });

  it('keeps it while its condition selects as many records as it masked', () => {
    expect(maskHeldOf(kept(2), dryAnswer({}))).toEqual({
      objects: [{ object: 'Contact', present: 2 }],
      masked: 2,
    });
  });

  it('says drift for records copied in since, which hold their original values, and for records gone', () => {
    expect(maskHeldOf(kept(1), dryAnswer({})).drift).toBe(
      'Contact 2 under its condition, 1 masked: 1 more, which hold their original values',
    );
    expect(maskHeldOf(kept(3), dryAnswer({}))).toEqual({
      objects: [{ object: 'Contact', present: 2, gone: 1 }],
      masked: 3,
      drift: 'Contact 2 under its condition, 3 masked: 1 gone',
    });
  });

  it('leaves it unread when its dry run refuses, never kept', () => {
    expect(maskHeldOf(kept(2), dryAnswer({ error: 'no session' }))).toEqual({
      objects: [],
      masked: 0,
      unread: 'no session',
    });
  });
});

describe('what the plan and the destroy say', () => {
  const kept: Pick<EnvResourceState, 'runs'> = {
    runs: [
      {
        n: 1,
        script: 'sandforge-dataops',
        snapshotId: 's1-snapshot',
        startedAt: '2026-10-25T09:00:00.000Z',
        objects: [],
      },
      { n: 2, script: 'sandforge-dataops', startedAt: '2026-10-25T09:05:00.000Z', objects: [] },
    ],
  };

  it('says masking is one-way, and the line that puts values back is the person’s own act', () => {
    expect(maskNotes('customers', { alias: 'pool-1', store: '/j/dataops/customers' })).toEqual([
      'masking is one-way: each run first takes a snapshot of the values it writes over, kept on this machine in /j/dataops/customers, and destroy never puts them back: it deletes the snapshots. Putting them back is your own act, before a destroy: sandforge-dataops anonymize --org pool-1 --restore <the snapshot its run names> --store /j/dataops/customers',
    ]);
    expect(maskDeleteWhy('destroy', 'customers', kept, { alias: 'pool-1', store: '/s' })).toBe(
      'taken back by destroy, which never unmasks: its records stay masked, and its store, /s, is deleted from this machine with its snapshots, the only copy of the values they held. To put back those they held before any masking, before this destroy, as your own act: sandforge-dataops anonymize --org pool-1 --restore s1-snapshot --store /s',
    );
  });

  it('says what a replace keeps: the values before any masking, in the first run’s snapshot alone', () => {
    expect(maskReplaceWords(kept)).toBe(
      "it masks again what its condition selects, the records it masked before a second time, and takes nothing back first: the values they held before any masking stay only in snapshot s1-snapshot, run 1's, which destroy deletes",
    );
  });
});

describe('the store a destroy deletes', () => {
  it('deletes it whole, the snapshots it lists and the files no listing names, and says which', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-mask-store-'));
    try {
      const store = join(dir, 'dataops', 'customers');
      mkdirSync(join(store, 'records'), { recursive: true });
      writeFileSync(
        join(store, 'snapshots.json'),
        JSON.stringify({
          'backup:b-snapshot': { value: {}, category: 'backup' },
          'backup:a-snapshot': { value: {}, category: 'backup' },
          'backup:a-snapshot:Contact': { value: [], category: 'backup' },
        }),
      );
      // What a masking stopped as it read its snapshot leaves: values, and no listing of them.
      writeFileSync(join(store, 'records', 'orphan.ndjson'), '{"Email":"ada@example.com"}\n');

      const forgotten = await forgetMaskStore(store);

      expect(forgotten).toEqual({ snapshots: ['a-snapshot', 'b-snapshot'] });
      expect(existsSync(store)).toBe(false);
      expect(maskForgottenLine('customers', forgotten)).toBe(
        'customers: its records stay masked — destroy never unmasks —, and its snapshots a-snapshot, b-snapshot, the only copy of the values they held, deleted from this machine with its store',
      );
      // Gone already, there is nothing left to delete.
      expect(await forgetMaskStore(store)).toEqual({ snapshots: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
