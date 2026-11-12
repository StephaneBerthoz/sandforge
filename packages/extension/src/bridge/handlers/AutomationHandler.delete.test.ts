import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';

import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { RewindGrants } from '../../modules/automation/RewindGrants.js';
import { memoryTriggerClaims } from '../../modules/automation/TriggerClaims.js';
import type { TriggerClaims } from '../../modules/automation/TriggerClaims.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { AutomationHandler } from './AutomationHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';

/** A saved pipeline with a nightly schedule, as the page saves it. */
function pipeline(id: string, name = 'Nightly reset'): Record<string, unknown> {
  return {
    id,
    name,
    description: '',
    version: 1,
    steps: [
      { id: 'step-d', name: 'Wait', type: 'delay', config: { seconds: 1 }, continueOnError: false },
    ],
    triggers: [
      {
        id: 'trig-night',
        type: 'schedule',
        enabled: true,
        config: { cron: '0 2 * * *', timezone: 'UTC' },
      },
    ],
    variables: [],
    tags: [],
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
  };
}

describe('AutomationHandler: deleting a saved pipeline', () => {
  let deps: HandlerDeps;
  let store: ConfigStore;
  let handler: AutomationHandler;
  let claims: TriggerClaims;
  let next = 0;

  /** Send a message and return what the handler answered to it. */
  async function send(type: string, payload?: unknown): Promise<BaseMessage & { payload?: never }> {
    const id = `req-${++next}`;
    await handler.handle(
      inboundRequest({ id, type, timestamp: Date.now(), payload } as unknown as BaseMessage),
    );
    const answer = vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { correlationId?: string })
      .find((m) => m.correlationId === id);
    if (!answer) throw new Error(`no answer to ${type}`);
    return answer as BaseMessage & { payload?: never };
  }

  const payloadOf = (message: BaseMessage): Record<string, unknown> =>
    (message as { payload?: Record<string, unknown> }).payload ?? {};

  const save = (id: string) => send('pipeline:save', { id, config: pipeline(id) });

  beforeEach(() => {
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    claims = memoryTriggerClaims();
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn(),
        getAllOrgs: vi.fn(() => []),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      nextId: () => String(++next),
    };
    handler = new AutomationHandler(deps);
  });

  afterEach(() => {
    handler.stopTriggers();
  });

  it('removes the pipeline from the saved list and says it did', async () => {
    await save('pipe-1');
    await save('pipe-2');

    const answer = await send('pipeline:delete', { id: 'pipe-1' });

    expect(answer.type).toBe('pipeline:delete:response');
    expect(payloadOf(answer)).toEqual({ id: 'pipe-1', deleted: true });
    const listed = payloadOf(await send('pipeline:list'))['pipelines'] as Array<{ id: string }>;
    expect(listed.map((saved) => saved.id)).toEqual(['pipe-2']);
  });

  it('answers deleted: false for an id nothing is saved under, a pipeline another window deleted first', async () => {
    await save('pipe-2');

    const answer = await send('pipeline:delete', { id: 'pipe-1' });

    expect(payloadOf(answer)).toEqual({ id: 'pipe-1', deleted: false });
    expect(store.has('pipeline:saved:pipe-2')).toBe(true);
  });

  it('takes back the confirmations of its Rewind steps, so a save of it again comes back unconfirmed', async () => {
    await save('pipe-1');
    const grants = new RewindGrants(store);
    const grant = {
      pipelineId: 'pipe-1',
      stepId: 'step-r',
      organizationId: '00D000000000001',
      checkpointId: 'ck-20261030-020000-abcd',
      digest: `sha256:${'a'.repeat(64)}`,
      grantedAt: '2026-10-30T02:00:00.000Z',
    };
    grants.write(grant);
    grants.write({ ...grant, pipelineId: 'pipe-2' });

    await send('pipeline:delete', { id: 'pipe-1' });

    expect(grants.all().map((kept) => kept.pipelineId)).toEqual(['pipe-2']);
  });

  it('refuses while a run holds the pipeline, keeps it saved, and deletes it once the run has ended', async () => {
    handler.startTriggers({ report: vi.fn(), claims });
    await save('pipe-1');
    const run = claims.hold('pipe-1', {
      startedAt: '2026-10-30T02:00:00.000Z',
      triggeredBy: 'schedule',
    });
    if ('busy' in run) throw new Error('the pipeline was held before the run');

    const refused = await send('pipeline:delete', { id: 'pipe-1' });

    expect(refused.type).toBe('pipeline:error');
    expect(payloadOf(refused)).toMatchObject({ code: 'PIPELINE_RUNNING', retryable: true });
    expect(String(payloadOf(refused)['message'])).toBe(
      'Pipeline "Nightly reset" is running: the run started by its schedule at ' +
        '2026-10-30T02:00:00.000Z has not ended. Delete it once that run has ended.',
    );
    expect(store.has('pipeline:saved:pipe-1')).toBe(true);

    run.release();
    expect(payloadOf(await send('pipeline:delete', { id: 'pipe-1' }))).toEqual({
      id: 'pipe-1',
      deleted: true,
    });
    // Held while it was deleted, and given back: a run can take it again.
    const after = claims.hold('pipe-1', { startedAt: 'now', triggeredBy: 'manual' });
    expect('release' in after).toBe(true);
  });

  it('looks at the schedules again at once, forgetting what it kept of the deleted triggers', async () => {
    await save('pipe-1');
    // What the scheduler remembers of a trigger that has fired.
    store.set(
      'pipeline-trigger:pipe-1:trig-night',
      { lastFiredAt: '2026-10-30T02:00:00.000Z', lastOutcome: 'started' },
      'pipeline-triggers',
    );
    handler.startTriggers({ report: vi.fn(), claims });
    await vi.waitFor(() =>
      expect(vi.mocked(deps.log).mock.calls.flat()).toContain('[pipeline-triggers] started'),
    );
    // The first look keeps it: the trigger is still saved.
    await send('pipeline:list');
    expect(store.has('pipeline-trigger:pipe-1:trig-night')).toBe(true);

    await send('pipeline:delete', { id: 'pipe-1' });

    await vi.waitFor(() => expect(store.has('pipeline-trigger:pipe-1:trig-night')).toBe(false));
    expect(payloadOf(await send('pipeline:list'))['triggers']).toEqual([]);
  });

  it('refuses a request with no id, deleting nothing', async () => {
    await save('pipe-1');

    const refused = await send('pipeline:delete', { id: '' });

    expect(refused.type).toBe('pipeline:error');
    expect(payloadOf(refused)).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(store.has('pipeline:saved:pipe-1')).toBe(true);
  });
});
