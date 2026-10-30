import { describe, expect, it } from 'vitest';
import type { PipelineStep } from '@sandforge/shared';
import { rewindGrantDigest, pipelineRewindStepConfigSchema } from '@sandforge/shared';

import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { notConfirmedRefusal } from '../checkpoint/rewindBounds.js';
import {
  REWIND_GRANTS_CATEGORY,
  RewindGrants,
  digestOf,
  grantRefusalWords,
  revokeRewindGrantsOf,
  type RewindGrant,
} from './RewindGrants.js';

const CONFIG = {
  orgId: 'org-dev',
  checkpointId: 'ck-20261030-020000-abcd',
  maxRecords: 100,
};

function rewindStep(config: Record<string, unknown> = CONFIG, id = 'step-r'): PipelineStep {
  return { id, name: 'Nightly reset', type: 'rewind', config, continueOnError: false };
}

function storeWith(saved: string[] = ['p-1']): ConfigStore {
  const store = new ConfigStore(new InMemoryConfigStoreBackend());
  for (const id of saved) store.set(`pipeline:saved:${id}`, { id, name: id }, 'pipelines');
  return store;
}

function grantOf(overrides: Partial<RewindGrant> = {}): RewindGrant {
  return {
    pipelineId: 'p-1',
    stepId: 'step-r',
    organizationId: '00D000000000001AAA',
    checkpointId: CONFIG.checkpointId,
    digest: rewindGrantDigest(pipelineRewindStepConfigSchema.parse(CONFIG)),
    grantedAt: '2026-10-30T09:00:00.000Z',
    grantedBy: 'sha256:0123456789ab',
    ...overrides,
  };
}

describe('RewindGrants', () => {
  it('keeps a confirmation under its own category, which is not the pipelines category', () => {
    const store = storeWith();
    new RewindGrants(store).write(grantOf());
    expect(Object.keys(store.getByCategory(REWIND_GRANTS_CATEGORY))).toHaveLength(1);
    expect(store.getKeysByPrefix('pipeline:saved:')).toEqual(['pipeline:saved:p-1']);
  });

  it('verifies a step whose configuration is the one confirmed, its keys written in another order', () => {
    const grants = new RewindGrants(storeWith());
    grants.write(grantOf());
    const { orgId, checkpointId, maxRecords } = CONFIG;
    const verified = grants.verify('p-1', rewindStep({ maxRecords, checkpointId, orgId }));
    expect(verified).toEqual({
      grant: {
        organizationId: '00D000000000001AAA',
        checkpointId: CONFIG.checkpointId,
        digest: grantOf().digest,
        grantedAt: '2026-10-30T09:00:00.000Z',
      },
    });
  });

  it('refuses a step never confirmed, and one whose configuration changed since', () => {
    const grants = new RewindGrants(storeWith());
    expect(grants.verify('p-1', rewindStep())).toEqual({ refusal: 'never' });
    grants.write(grantOf());
    expect(grants.verify('p-1', rewindStep({ ...CONFIG, maxRecords: 101 }))).toEqual({
      refusal: 'changed',
    });
    // A configuration that no longer reads is no longer the one confirmed.
    expect(grants.verify('p-1', rewindStep({ ...CONFIG, maxRecords: 0 }))).toEqual({
      refusal: 'changed',
    });
  });

  it('holds a confirmation void once its pipeline is no longer saved', () => {
    const store = storeWith();
    const grants = new RewindGrants(store);
    grants.write(grantOf());
    store.delete('pipeline:saved:p-1');
    expect(grants.verify('p-1', rewindStep())).toEqual({ refusal: 'never' });
  });

  it('takes back a confirmation once a save changes the step, and saving it back does not revive it', () => {
    const grants = new RewindGrants(storeWith());
    grants.write(grantOf());
    expect(grants.revokeChanged('p-1', [rewindStep({ ...CONFIG, maxRecords: 5 })])).toEqual([
      'step-r',
    ]);
    expect(grants.revokeChanged('p-1', [rewindStep()])).toEqual([]);
    expect(grants.verify('p-1', rewindStep())).toEqual({ refusal: 'never' });
  });

  it('keeps a confirmation across a save that changes only the step name or another step', () => {
    const grants = new RewindGrants(storeWith());
    grants.write(grantOf());
    const renamed = { ...rewindStep(), name: 'Reset the training org' };
    const other: PipelineStep = {
      id: 'step-n',
      name: 'Tell',
      type: 'notification',
      config: { message: 'done' },
      continueOnError: false,
    };
    expect(grants.revokeChanged('p-1', [other, renamed])).toEqual([]);
    expect('grant' in grants.verify('p-1', renamed)).toBe(true);
  });

  it('takes back the confirmation of a step removed from the pipeline, or turned into another type', () => {
    const grants = new RewindGrants(storeWith());
    grants.write(grantOf());
    grants.write(grantOf({ stepId: 'step-s' }));
    const turned: PipelineStep = { ...rewindStep(CONFIG, 'step-s'), type: 'seed' };
    expect(grants.revokeChanged('p-1', [turned]).sort()).toEqual(['step-r', 'step-s']);
  });

  it("takes back every confirmation of one pipeline and none of another's", () => {
    const store = storeWith(['p-1', 'p-2']);
    const grants = new RewindGrants(store);
    grants.write(grantOf());
    grants.write(grantOf({ stepId: 'step-s' }));
    grants.write(grantOf({ pipelineId: 'p-2' }));
    expect(revokeRewindGrantsOf(store, 'p-1').sort()).toEqual(['step-r', 'step-s']);
    expect(grants.all().map((grant) => grant.pipelineId)).toEqual(['p-2']);
  });

  it('takes back the confirmations of a pipeline no longer saved, and of a checkpoint no longer kept', async () => {
    const store = storeWith(['p-1', 'p-2']);
    const grants = new RewindGrants(store);
    grants.write(grantOf());
    grants.write(grantOf({ pipelineId: 'p-2', checkpointId: 'ck-20261030-020000-gone' }));
    grants.write(grantOf({ pipelineId: 'p-3' }));
    const asked: string[] = [];
    const revoked = await grants.revokeVoid(async (checkpointId) => {
      asked.push(checkpointId);
      return checkpointId !== 'ck-20261030-020000-gone';
    });
    expect(revoked.map((grant) => grant.pipelineId).sort()).toEqual(['p-2', 'p-3']);
    expect(grants.all().map((grant) => grant.pipelineId)).toEqual(['p-1']);
    // Asked once per checkpoint, and never for a pipeline already gone.
    expect(asked.sort()).toEqual(['ck-20261030-020000-abcd', 'ck-20261030-020000-gone']);
  });

  it('reads an entry that is not a confirmation as none', () => {
    const store = storeWith();
    store.set(
      'pipeline:rewind-grant:p-1:step-r',
      { ...grantOf(), digest: 'sha256:short' },
      REWIND_GRANTS_CATEGORY,
    );
    const grants = new RewindGrants(store);
    expect(grants.get('p-1', 'step-r')).toBeUndefined();
    expect(grants.verify('p-1', rewindStep())).toEqual({ refusal: 'never' });
  });

  it('refuses to keep what is not a confirmation', () => {
    const grants = new RewindGrants(storeWith());
    expect(() => grants.write(grantOf({ grantedAt: 'yesterday' }))).toThrow();
    expect(grants.all()).toEqual([]);
  });

  it("words a missing confirmation as the rewind's own refusal does", () => {
    for (const changed of [false, true]) {
      expect(grantRefusalWords('Nightly reset', changed ? 'changed' : 'never')).toBe(
        notConfirmedRefusal('Nightly reset', changed).message,
      );
    }
  });

  it('digests a configuration that reads, and nothing else', () => {
    expect(digestOf(CONFIG)).toBe(grantOf().digest);
    expect(digestOf({ ...CONFIG, checkpointId: 'latest' })).toBeUndefined();
    expect(digestOf(undefined)).toBeUndefined();
  });
});
