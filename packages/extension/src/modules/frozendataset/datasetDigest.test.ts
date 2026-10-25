import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { frozenDatasetDigest } from './datasetDigest.js';
import { frozenDatasetDigest as exportedFromTheModule } from './index.js';

/** A manifest as the extraction writes it, before any load. */
const MANIFEST = {
  version: '1.4.0',
  status: 'frozen',
  frozenAt: '2026-10-20T08:00:00.000Z',
  source: { orgId: '00D000000000001AAA', decisionDate: '2026-10-20T07:00:00.000Z' },
  saltFingerprint: 'abcdef012345',
  rulesVersion: '1.0.0',
  volumetry: { budgetMax: 2500, measured: { Account: 2, Contact: 3 }, measuredAt: 'x' },
  controls: {
    nonReidentification: { passed: true, checks: [] },
    dryRunLoad: null,
    author: 'a',
    date: 'x',
  },
};

/** The files of a small dataset, by their path inside it. */
function datasetFiles(): Record<string, string> {
  return {
    'manifest.json': `${JSON.stringify(MANIFEST, null, 2)}\n`,
    'data/Account.json': '{"objectApiName":"Account","records":[{"referenceId":"Account-1"}]}\n',
    'data/Contact.json': '{"objectApiName":"Contact","records":[{"referenceId":"Contact-1"}]}\n',
    'record-types.json': '{}\n',
    'personcontact-sidecar.json': '[]\n',
    'platform-records.json': '{}\n',
  };
}

let roots: string[];

/** The files, but one. */
function without(files: Record<string, string>, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([file]) => file !== name));
}

/** Write a dataset's files into a new folder, in the order given. */
function writeDataset(files: Record<string, string>, order = Object.keys(files)): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-digest-'));
  roots.push(dir);
  for (const name of order) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), files[name]);
  }
  return dir;
}

beforeEach(() => {
  roots = [];
});

afterEach(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

describe('frozenDatasetDigest', () => {
  it('gives a sha256 digest in the shape an environment pins', async () => {
    expect(await frozenDatasetDigest(writeDataset(datasetFiles()))).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  it('is the same for the same files, wherever they are and in whatever order they were written', async () => {
    const files = datasetFiles();
    const first = await frozenDatasetDigest(writeDataset(files));
    const copied = await frozenDatasetDigest(writeDataset(files, Object.keys(files).reverse()));
    expect(copied).toBe(first);
    expect(await frozenDatasetDigest(writeDataset(files))).toBe(first);
  });

  it('changes when the content of any file a load reads changes', async () => {
    const files = datasetFiles();
    const first = await frozenDatasetDigest(writeDataset(files));
    const changes: Record<string, string> = {
      'manifest.json': JSON.stringify({ ...MANIFEST, version: '1.4.1' }),
      'data/Account.json': files['data/Account.json'].replace('Account-1', 'Account-2'),
      'data/Contact.json': files['data/Contact.json'].replace('Contact-1', 'Contact-2'),
      'record-types.json': '{"Account":[]}\n',
      'personcontact-sidecar.json': '[{"accountReferenceId":"Account-1"}]\n',
      'platform-records.json': '{"standardPricebook":"Pricebook2-1"}\n',
    };
    expect(Object.keys(changes).sort()).toEqual(Object.keys(files).sort());
    for (const [name, content] of Object.entries(changes)) {
      expect(await frozenDatasetDigest(writeDataset({ ...files, [name]: content })), name).not.toBe(
        first,
      );
    }
  });

  it('changes when a data file comes or goes, and when an optional file a load reads does', async () => {
    const files = datasetFiles();
    const first = await frozenDatasetDigest(writeDataset(files));
    const withCase = { ...files, 'data/Case.json': '{"objectApiName":"Case","records":[]}\n' };
    expect(await frozenDatasetDigest(writeDataset(withCase))).not.toBe(first);
    expect(await frozenDatasetDigest(writeDataset(without(files, 'data/Contact.json')))).not.toBe(
      first,
    );
    expect(await frozenDatasetDigest(writeDataset(without(files, 'record-types.json')))).not.toBe(
      first,
    );
  });

  it('tells a file from another of the same content: a record moved between objects changes it', async () => {
    const files = datasetFiles();
    const swapped = {
      ...files,
      'data/Account.json': files['data/Contact.json'],
      'data/Contact.json': files['data/Account.json'],
    };
    expect(await frozenDatasetDigest(writeDataset(swapped))).not.toBe(
      await frozenDatasetDigest(writeDataset(files)),
    );
  });

  it('stays the same once a verification wrote its verdict into the manifest, or the manifest was written again', async () => {
    const files = datasetFiles();
    const first = await frozenDatasetDigest(writeDataset(files));
    const verified = {
      ...MANIFEST,
      controls: {
        ...MANIFEST.controls,
        dryRunLoad: { status: 'passed', at: '2026-10-21T09:00:00.000Z', detail: 'verdict=passed' },
      },
    };
    expect(
      await frozenDatasetDigest(
        writeDataset({ ...files, 'manifest.json': JSON.stringify(verified) }),
      ),
    ).toBe(first);
  });

  it('leaves out what a load never reads: a file beside the dataset, a data file that is not JSON', async () => {
    const files = datasetFiles();
    const first = await frozenDatasetDigest(writeDataset(files));
    expect(
      await frozenDatasetDigest(
        writeDataset({ ...files, 'NOTES.txt': 'kept by hand\n', 'data/README.md': '# data\n' }),
      ),
    ).toBe(first);
  });

  it('refuses a folder that holds no dataset, saying so', async () => {
    await expect(
      frozenDatasetDigest(writeDataset(without(datasetFiles(), 'manifest.json'))),
    ).rejects.toThrow(/No frozen dataset at .*: it holds no manifest\.json/);
  });

  it("is exported from the module, for the environment's fingerprints", () => {
    expect(exportedFromTheModule).toBe(frozenDatasetDigest);
  });
});
