import { describe, it, expect, beforeEach } from 'vitest';
import type {
  ForgeConfig,
  ForgeExecutionResult,
  ForgeSamplingProgress,
  WholeOrgSampleBudget,
} from '@sandforge/shared';
import { useForgeStore } from './useForgeStore';
import { wholeOrgDryRun, wholeOrgGraph } from '../pages/Forge/testing/wholeOrg';

/** A clone of the whole org, as the form sends it. */
const WHOLE_ORG: ForgeConfig = {
  inputMode: 'org',
  depth: 'all',
  sourceOrgId: 'org-src',
  targetOrgId: 'org-tgt',
  anonymizePII: true,
  skipEmpty: false,
  batchSize: 'auto',
};

/** What a sample of it may take, as the extension offers it. */
const OFFER: WholeOrgSampleBudget = {
  bytes: 3_774_873,
  remainingMB: 5,
  maxMB: 5,
  share: 0.8,
  roundingMB: 0.5,
  limitedBy: 'storage',
};

function getState(): ReturnType<typeof useForgeStore.getState> {
  return useForgeStore.getState();
}

/** A message of the extension, as the window hands it to every listener. */
function fromTheExtension(type: string, payload: unknown, correlationId = 'wv-run-1'): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { id: `host-${type}`, type, timestamp: Date.now(), correlationId, payload },
    }),
  );
}

/** The run of the whole org on screen, under request `wv-run-1`. */
function runOnScreen(config: ForgeConfig = WHOLE_ORG): void {
  getState().setConfig(config);
  getState().setGraph(wholeOrgGraph());
  getState().setExecutionRequestId('wv-run-1');
  getState().setPhase('execution');
}

const COUNTING: ForgeSamplingProgress = {
  step: 'counting',
  objectApiName: 'Contact',
  done: 2,
  total: 4,
  rows: 0,
  requests: 3,
  pricedAt: 120,
};

function dryResult(): ForgeExecutionResult {
  return {
    forgeId: 'forge-dry',
    status: 'failure',
    graph: wholeOrgGraph(),
    duration: 2_000,
    timestamp: '2026-11-14T10:00:00.000Z',
    idRemapCount: 0,
    dryRun: true,
  };
}

describe('a sample of the whole org, in the store', () => {
  beforeEach(() => {
    getState().reset();
  });

  describe('the choice of a sample', () => {
    it('sets the options of a sample on the run under review, and takes them off for every record', () => {
      getState().setConfig(WHOLE_ORG);

      getState().setSample({ draw: 'recent', seed: 4 });
      expect(getState().config?.sample).toEqual({ draw: 'recent', seed: 4 });

      getState().setSample(undefined);
      expect(getState().config).not.toHaveProperty('sample');
    });

    it('turns the copy of the files off, with its acceptance: a sample copies none', () => {
      getState().setConfig(WHOLE_ORG);
      getState().setFileCopy({ enabled: true, acceptedAsIs: true });

      getState().setSample({});

      expect(getState().fileCopy).toMatchObject({ enabled: false, acceptedAsIs: false });
    });

    it('keeps what Review read: a sample is chosen on it, not a new run', () => {
      getState().setConfig(WHOLE_ORG);
      const unread = [{ part: 'ValidationRule', reason: 'INSUFFICIENT_ACCESS' }];
      getState().setGaps('metadata', [], unread);

      getState().setSample({});

      expect(getState().gapReads).toEqual({ metadata: unread });
    });

    it('sets nothing with no run under review, nor on a run walked from a record', () => {
      getState().setSample({});
      expect(getState().config).toBeNull();

      getState().setConfig({ ...WHOLE_ORG, inputMode: 'record', depth: 'direct' });
      getState().setSample({});
      expect(getState().config).not.toHaveProperty('sample');
    });
  });

  describe('where the drawing of its plan stands', () => {
    it('keeps the step the run on screen is at, before any object is written', () => {
      runOnScreen();

      fromTheExtension('forge:sampling:progress', COUNTING);

      expect(getState().sampling).toEqual(COUNTING);
    });

    it("takes no other run's drawing, nor one that does not read as one", () => {
      runOnScreen();

      fromTheExtension('forge:sampling:progress', COUNTING, 'wv-another-panel');
      fromTheExtension('forge:sampling:progress', { step: 'guessing', rows: 1, requests: 1 });
      fromTheExtension('forge:sampling:progress', { step: 'drawing', rows: 'many', requests: 1 });

      expect(getState().sampling).toBeNull();
    });

    it('is done at the first object the run reports on', () => {
      runOnScreen();
      fromTheExtension('forge:sampling:progress', COUNTING);

      fromTheExtension('forge:progress', { objectName: 'Account', status: 'running' });

      expect(getState().sampling).toBeNull();
    });

    it('is done once the run answers, refused or not, and forgotten as the next starts', () => {
      runOnScreen();
      fromTheExtension('forge:sampling:progress', COUNTING);
      fromTheExtension('forge:execute:response', {
        result: dryResult(),
        operationId: 'forge-execute-1',
      });
      expect(getState().sampling).toBeNull();

      runOnScreen();
      fromTheExtension('forge:sampling:progress', COUNTING);
      fromTheExtension('forge:execute:error', {
        message: 'refused',
        code: 'SAMPLE_CANNOT_FIT',
        retryable: false,
      });
      expect(getState().sampling).toBeNull();

      runOnScreen();
      fromTheExtension('forge:sampling:progress', COUNTING);
      getState().setExecutionRequestId('wv-run-2');
      expect(getState().sampling).toBeNull();
    });
  });

  describe('the offer of a sample that fits, from a simulation of every record', () => {
    it('keeps what a sample of the whole org may take, beside the dry run past the storage', () => {
      runOnScreen();

      fromTheExtension('forge:execute:response', {
        result: dryResult(),
        operationId: 'forge-execute-1',
        wholeOrgDryRun: wholeOrgDryRun(),
        sampleOffer: OFFER,
      });

      expect(getState().sampleOffer).toEqual(OFFER);
    });

    it('takes no offer that does not read as one, nor one beside a run that wrote', () => {
      runOnScreen();
      fromTheExtension('forge:execute:response', {
        result: dryResult(),
        operationId: 'forge-execute-1',
        wholeOrgDryRun: wholeOrgDryRun(),
        sampleOffer: { bytes: 'lots' },
      });
      expect(getState().sampleOffer).toBeNull();

      runOnScreen();
      fromTheExtension('forge:execute:response', {
        result: { ...dryResult(), dryRun: false, status: 'success' },
        operationId: 'forge-execute-1',
        sampleOffer: OFFER,
      });
      expect(getState().sampleOffer).toBeNull();

      // Nor beside a simulation that said nothing of the whole org.
      runOnScreen();
      fromTheExtension('forge:execute:response', {
        result: dryResult(),
        operationId: 'forge-execute-1',
        sampleOffer: OFFER,
      });
      expect(getState().sampleOffer).toBeNull();
    });

    it('taken, goes back to Review with a sample at its defaults, and forgets the offer', () => {
      runOnScreen();
      fromTheExtension('forge:execute:response', {
        result: dryResult(),
        operationId: 'forge-execute-1',
        wholeOrgDryRun: wholeOrgDryRun(),
        sampleOffer: OFFER,
      });

      getState().copySampleInstead();

      expect(getState().phase).toBe('review');
      expect(getState().config?.sample).toEqual({});
      expect(getState().result).toBeNull();
      expect(getState().wholeOrgDryRun).toBeNull();
      expect(getState().sampleOffer).toBeNull();
    });

    it('is forgotten when the next run starts', () => {
      runOnScreen();
      fromTheExtension('forge:execute:response', {
        result: dryResult(),
        operationId: 'forge-execute-1',
        wholeOrgDryRun: wholeOrgDryRun(),
        sampleOffer: OFFER,
      });

      getState().setExecutionRequestId('wv-run-2');

      expect(getState().sampleOffer).toBeNull();
    });
  });
});
