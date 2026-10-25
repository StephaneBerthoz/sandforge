/**
 * A small Frozen dataset for the tests of an environment's `frozen` kind,
 * written by the module's own writer — `FrozenDatasetWriter`, behind the
 * non-reidentification control's verdict, with a manifest the module builds —
 * into a folder of the test's own, outside the repository as every dataset
 * is: `n` accounts, and `perAccount` contacts under each, each named
 * `SFENV <mark> <rank>`.
 *
 * Nothing of a real dataset is copied here: the records are made up, their
 * referenceIds are ranks as an extraction gives them, and no field holds a
 * Salesforce id.
 */

import { buildFrozenManifest } from '../../src/modules/frozendataset/manifest.js';
import { FrozenDatasetWriter } from '../../src/modules/frozendataset/FrozenDatasetWriter.js';
import { SasPathGuard } from '../../src/modules/frozendataset/SasPathGuard.js';
import type { FrozenDataset } from '../../src/modules/frozendataset/types.js';

/** What the dataset holds. */
export interface FrozenFixture {
  /** The accounts it holds. */
  accounts: number;
  /** The contacts under each account. */
  perAccount: number;
  /** What the records are named by: `SFENV <mark> <rank>`. */
  mark: string;
  /** The manifest's version. */
  version?: string;
  /** The org it was frozen from, as the manifest names it; never the one it is loaded into. */
  sourceOrgId?: string;
}

/** The org a dataset of the fixture was frozen from, unless it names another. */
export const FIXTURE_SOURCE_ORG_ID = '00D000000000006SRC';

/** The referenceId of the k-th record of an object, as an extraction ranks them. */
export function referenceIdOf(objectApiName: string, k: number): string {
  return `${objectApiName}-${String(k).padStart(6, '0')}`;
}

/**
 * Freeze the fixture into `dir`, as an extraction freezes a dataset: its data
 * files, its record types and person contacts (none), and its manifest.
 *
 * @returns The folder written.
 */
export async function freezeDataset(dir: string, fixture: FrozenFixture): Promise<string> {
  const accounts = Array.from({ length: fixture.accounts }, (_, i) => ({
    referenceId: referenceIdOf('Account', i + 1),
    fields: { Name: `SFENV ${fixture.mark} ${i + 1}` },
  }));
  const contacts = accounts.flatMap((account, i) =>
    Array.from({ length: fixture.perAccount }, (_, j) => ({
      referenceId: referenceIdOf('Contact', i * fixture.perAccount + j + 1),
      fields: {
        LastName: `SFENV ${fixture.mark} ${i * fixture.perAccount + j + 1}`,
        AccountId: account.referenceId,
      },
    })),
  );
  const version = fixture.version ?? '1.0.0';
  const dataset: FrozenDataset = {
    datasetVersion: version,
    objects: [
      { objectApiName: 'Account', records: accounts },
      ...(contacts.length > 0 ? [{ objectApiName: 'Contact', records: contacts }] : []),
    ],
    recordTypes: {},
    personContactSidecar: [],
  };
  const at = '2026-10-20T08:00:00.000Z';
  const control = { passed: true, checks: [], author: 'sandforge-tests', checkedAt: at };
  const manifest = buildFrozenManifest({
    version,
    source: { orgId: fixture.sourceOrgId ?? FIXTURE_SOURCE_ORG_ID, decisionDate: at },
    saltFingerprint: '0123456789ab',
    rulesVersion: '1.0.0',
    volumetry: {
      budgetMax: 2500,
      measured: { Account: accounts.length, Contact: contacts.length },
      measuredAt: at,
    },
    nonReidentification: control,
    author: 'sandforge-tests',
    now: () => new Date(at),
  });
  const written = await new FrozenDatasetWriter(new SasPathGuard()).write(
    dir,
    dataset,
    manifest,
    control,
  );
  return written.dir;
}
