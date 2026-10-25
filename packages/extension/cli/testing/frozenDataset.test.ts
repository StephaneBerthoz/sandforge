import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { frozenDatasetDigest } from '../../src/modules/frozendataset/datasetDigest.js';
import { parseManifest } from '../../src/modules/frozendataset/manifest.js';
import { FIXTURE_SOURCE_ORG_ID, freezeDataset, referenceIdOf } from './frozenDataset.js';

/*
 * The dataset the environment's tests load: written by the module's own
 * writer, made-up records named by rank, nothing of a real dataset.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-frozen-fixture-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the dataset of the environment’s tests', () => {
  it('is written as an extraction writes one: a manifest the module reads, a data file per object, the contacts under their accounts by referenceId', async () => {
    const written = await freezeDataset(join(dir, 'claims'), {
      accounts: 2,
      perAccount: 2,
      mark: 'claim',
      version: '1.4.0',
    });

    const manifest = parseManifest(
      JSON.parse(readFileSync(join(written, 'manifest.json'), 'utf8')),
    );
    expect(manifest).toMatchObject({
      version: '1.4.0',
      status: 'frozen',
      source: { orgId: FIXTURE_SOURCE_ORG_ID },
      volumetry: { measured: { Account: 2, Contact: 4 } },
    });
    const contacts = JSON.parse(readFileSync(join(written, 'data', 'Contact.json'), 'utf8')) as {
      records: Array<{ referenceId: string; fields: Record<string, unknown> }>;
    };
    expect(contacts.records.map((record) => record.fields['AccountId'])).toEqual([
      referenceIdOf('Account', 1),
      referenceIdOf('Account', 1),
      referenceIdOf('Account', 2),
      referenceIdOf('Account', 2),
    ]);
    expect(contacts.records[0]).toEqual({
      referenceId: 'Contact-000001',
      fields: { LastName: 'SFENV claim 1', AccountId: 'Account-000001' },
    });
    expect(existsSync(join(written, 'record-types.json'))).toBe(true);
  });

  it('holds no Salesforce id in its records, and digests the same whenever it is frozen again', async () => {
    const a = await freezeDataset(join(dir, 'a'), { accounts: 3, perAccount: 1, mark: 'k' });
    const b = await freezeDataset(join(dir, 'b'), { accounts: 3, perAccount: 1, mark: 'k' });
    const c = await freezeDataset(join(dir, 'c'), { accounts: 4, perAccount: 1, mark: 'k' });

    const data = readFileSync(join(a, 'data', 'Account.json'), 'utf8');
    expect(data).not.toMatch(/\b[0-9A-Za-z]{3}0{6,}[0-9A-Za-z]{3,9}\b/);
    expect(await frozenDatasetDigest(a)).toBe(await frozenDatasetDigest(b));
    expect(await frozenDatasetDigest(c)).not.toBe(await frozenDatasetDigest(a));
  });

  it('is refused inside the repository, as every dataset is', async () => {
    await expect(
      freezeDataset(resolve(__dirname, 'never-written'), { accounts: 1, perAccount: 0, mark: 'k' }),
    ).rejects.toThrow();
    expect(existsSync(resolve(__dirname, 'never-written'))).toBe(false);
  });
});
