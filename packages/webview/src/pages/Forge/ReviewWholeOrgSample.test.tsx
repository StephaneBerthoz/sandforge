import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import type { BaseMessage, ForgeConfig, ForgeSampleBudget } from '@sandforge/shared';
import '../../i18n';
import { ReviewWholeOrgSample } from './ReviewWholeOrgSample';
import { useForgeStore } from '../../stores/useForgeStore';
import { sampleBudget, wholeOrgGraph } from './testing/wholeOrg';

/* ---- Bridge double: what the block posts, and a way to answer it ---- */
const mockPostMessage = vi.fn();
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

/** A clone of the whole org between two orgs, as Review holds it. */
const WHOLE_ORG: ForgeConfig = {
  inputMode: 'org',
  depth: 'all',
  sourceOrgId: 'org-src',
  targetOrgId: 'org-tgt',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

/** The budget requests posted, their payloads. */
function requests(): Array<{
  graph: unknown;
  config: ForgeConfig;
  muteAutomation?: boolean;
}> {
  return mockPostMessage.mock.calls
    .map((call) => (call[0] as { payload: BaseMessage & { payload: unknown } }).payload)
    .filter((message) => message.type === 'forge:sample-budget:request')
    .map((message) => message.payload as { graph: unknown; config: ForgeConfig });
}

/** The extension answering the last budget request, for `targetOrgId`. */
function answer(budget: ForgeSampleBudget, targetOrgId = 'org-tgt'): void {
  const ids = mockPostMessage.mock.calls
    .map((call) => (call[0] as { payload: BaseMessage }).payload)
    .filter((message) => message.type === 'forge:sample-budget:request')
    .map((message) => message.id);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: 'host-1',
          type: 'forge:sample-budget:response',
          timestamp: Date.now(),
          correlationId: ids[ids.length - 1],
          payload: { targetOrgId, budget },
        },
      }),
    );
  });
}

/** The extension refusing the last budget request. */
function refuse(message: string): void {
  const ids = mockPostMessage.mock.calls
    .map((call) => (call[0] as { payload: BaseMessage }).payload)
    .filter((m) => m.type === 'forge:sample-budget:request')
    .map((m) => m.id);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: 'host-2',
          type: 'forge:sample-budget:error',
          timestamp: Date.now(),
          correlationId: ids[ids.length - 1],
          payload: { message, code: 'SAMPLE_BUDGET_ERROR', retryable: true },
        },
      }),
    );
  });
}

function renderBlock(config: ForgeConfig = WHOLE_ORG): void {
  useForgeStore.getState().setConfig(config);
  render(<ReviewWholeOrgSample graph={wholeOrgGraph()} source="prod" target="dev" />);
}

/** The sample's options as the run under review holds them. */
function sample(): ForgeConfig['sample'] {
  return useForgeStore.getState().config?.sample;
}

/*
 * A whole production org rarely fits a Developer sandbox: Review says what
 * every record would take of the target against what it has left, offers a
 * sample that fits instead, and sets how it is drawn, with what drawing it
 * reads of the source, before anything is simulated.
 */
describe('ReviewWholeOrgSample', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useForgeStore.getState().reset();
  });

  it('reads what the target has left for the graph and the config under review, nothing drawn', () => {
    renderBlock();

    const [request] = requests();
    expect(request.graph).toEqual(wholeOrgGraph());
    expect(request.config).toEqual(WHOLE_ORG);
    expect(screen.getByTestId('review-sample-whole-org').textContent).toBe(
      'Reading what dev has left of its data storage…',
    );
  });

  it('says every record would take more than the target has left, and that a sample fits', () => {
    renderBlock();
    answer(sampleBudget());

    expect(screen.getByTestId('review-sample-whole-org').textContent).toBe(
      'Every record takes about 412 MB of the data storage of dev, which has 4.5 MB left: the run would be refused. A sample that fits would take about 3.2 MB.',
    );
    // Every record is still what the run copies until the sample is chosen.
    expect((screen.getByTestId('review-sample-every') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId('review-sample-options')).toBeNull();
    expect(sample()).toBeUndefined();
  });

  it('says every record fits when it does, with what is left', () => {
    renderBlock();
    answer(
      sampleBudget({
        wholeOrg: { verdict: 'fits', estimateMB: 19, maxMB: 1_024, remainingMB: 800 },
      }),
    );

    expect(screen.getByTestId('review-sample-whole-org').textContent).toBe(
      'Every record takes about 19 MB of the data storage of dev, which has 800 MB left out of 1,024 MB.',
    );
  });

  it('says why what is left could not be read', () => {
    renderBlock();
    refuse('INVALID_SESSION_ID');

    expect(screen.getByTestId('review-sample-whole-org').textContent).toBe(
      'What dev has left of its data storage could not be read: INVALID_SESSION_ID',
    );
  });

  it('drops an answer for another target', () => {
    renderBlock();
    answer(sampleBudget(), 'org-other');

    expect(screen.getByTestId('review-sample-whole-org').textContent).toBe(
      'Reading what dev has left of its data storage…',
    );
  });

  it('sets a sample at its defaults once chosen, and says what it may take and what drawing it reads', () => {
    renderBlock();
    answer(sampleBudget());

    fireEvent.click(screen.getByTestId('review-sample-fits'));

    expect(sample()).toEqual({});
    expect(screen.getByTestId('review-sample-budget').textContent).toBe(
      'The sample may take about 3.2 MB: 80 % of the 4.5 MB dev has left, 0.5 MB kept off for rounding.',
    );
    expect(screen.getByTestId('review-sample-cost').textContent).toBe(
      'Drawing it reads API requests of prod: about 1,950, of 14,000 left today out of 15,000. It takes about 4min.',
    );
    expect(screen.getByTestId('review-sample-whole').textContent).toBe(
      'Copied whole of itself: Opportunity (an object of few records that drawn records name).',
    );
    // Its budget is read again for the sample's options.
    expect(requests().slice(-1)[0].config.sample).toEqual({});
  });

  it('says the target would not say its storage, and that the MB it may take is to be set', () => {
    renderBlock({ ...WHOLE_ORG, sample: {} });
    answer(
      sampleBudget({
        wholeOrg: { verdict: 'unread', estimateMB: 412, unread: 'REQUEST_LIMIT_EXCEEDED' },
        budget: undefined,
      }),
    );

    expect(screen.getByTestId('review-sample-budget').textContent).toBe(
      'dev would not say what data storage it has left: set the MB the sample may take, under Sample settings, or the run is refused.',
    );
  });

  it('says the MB asked hold the sample when they do', () => {
    renderBlock({ ...WHOLE_ORG, sample: { withinMB: 2 } });
    answer(
      sampleBudget({
        budget: { bytes: 2_097_152, remainingMB: 4.5, maxMB: 5, withinMB: 2, limitedBy: 'within' },
      }),
    );

    expect(screen.getByTestId('review-sample-budget').textContent).toBe(
      'The sample may take about 2 MB, the MB asked under Sample settings.',
    );
  });

  it('draws the newest first once asked, reads its cost again, and says a draw past a tenth of the day is refused', () => {
    renderBlock({ ...WHOLE_ORG, sample: {} });
    answer(sampleBudget());
    const draw = screen.getByTestId('review-sample-draw') as HTMLSelectElement;
    expect(draw.value).toBe('uniform');
    expect([...draw.options].map((option) => option.textContent)).toEqual([
      'Spread over the org',
      'The newest first',
    ]);

    fireEvent.change(draw, { target: { value: 'recent' } });

    expect(sample()).toEqual({ draw: 'recent' });
    expect(requests().slice(-1)[0].config.sample).toEqual({ draw: 'recent' });
    expect(screen.getByTestId('review-sample-draw-hint').textContent).toBe(
      'The records made last, by their creation date: drawing reads only those it keeps, and the sample leans to the newest data.',
    );

    answer(
      sampleBudget({
        planReads: {
          source: { verdict: 'exceeds', estimate: 9_000, max: 15_000, remaining: 14_000 },
          seconds: 1_200,
        },
      }),
    );
    expect(screen.getByTestId('review-sample-cost-refused').textContent).toBe(
      'That is past a tenth of what prod has left today: the draw would be refused before an id is read. Draw the newest first, or leave the largest objects out.',
    );
  });

  it('keeps the seed shown, and draws again with the next one', () => {
    renderBlock({ ...WHOLE_ORG, sample: { seed: 4 } });

    expect(screen.getByTestId('review-sample-seed').textContent).toBe('Seed 4');
    fireEvent.click(screen.getByTestId('review-sample-draw-again'));

    expect(sample()).toEqual({ seed: 5 });
    expect(screen.getByTestId('review-sample-seed').textContent).toBe('Seed 5');
    // The seed changes nothing of what the sample may take: not read again.
    expect(requests().every((request) => request.config.sample?.seed === undefined)).toBe(true);
  });

  it('takes the MB asked once the field is left, and refuses what is not a size', () => {
    renderBlock({ ...WHOLE_ORG, sample: {} });
    const within = screen.getByTestId('review-sample-within') as HTMLInputElement;

    fireEvent.change(within, { target: { value: '2.5' } });
    expect(sample()).toEqual({});
    fireEvent.blur(within);
    expect(sample()).toEqual({ withinMB: 2.5 });

    fireEvent.change(within, { target: { value: '-1' } });
    expect(within.getAttribute('aria-invalid')).toBe('true');
    fireEvent.blur(within);
    expect(sample()).toEqual({ withinMB: 2.5 });
    expect(within.value).toBe('2.5');

    fireEvent.change(within, { target: { value: '' } });
    fireEvent.blur(within);
    expect(sample()).toEqual({});
  });

  it('copies an optional lookup’s record or leaves the lookup empty, as asked', () => {
    renderBlock({ ...WHOLE_ORG, sample: {} });
    const parents = screen.getByTestId('review-sample-parents') as HTMLSelectElement;
    expect([...parents.options].map((option) => option.textContent)).toEqual([
      'Copy it, without its children',
      'Leave the lookup empty',
    ]);

    fireEvent.change(parents, { target: { value: 'required' } });

    expect(sample()).toEqual({ parents: 'required' });
  });

  it('caps the children of a record per relation, 100 by default, or takes them all', () => {
    renderBlock({ ...WHOLE_ORG, sample: {} });
    const children = screen.getByTestId('review-sample-children') as HTMLSelectElement;
    expect(children.value).toBe('100');

    fireEvent.change(children, { target: { value: 'all' } });
    expect(sample()).toEqual({ children: 'all' });
    fireEvent.change(children, { target: { value: '500' } });
    expect(sample()).toEqual({ children: 500 });
  });

  it('shows a cap a past run set that the list does not offer', () => {
    renderBlock({ ...WHOLE_ORG, sample: { children: 25 } });

    const children = screen.getByTestId('review-sample-children') as HTMLSelectElement;
    expect(children.value).toBe('25');
  });

  it('lists the objects to copy whole, those it copies whole of itself ticked with why, and adds those asked', () => {
    renderBlock({ ...WHOLE_ORG, sample: {} });
    answer(sampleBudget());
    fireEvent.click(screen.getByTestId('review-sample-whole-toggle'));

    const list = screen.getByTestId('review-sample-whole-list');
    const opportunity = within(list).getByTestId(
      'review-sample-whole-Opportunity',
    ) as HTMLInputElement;
    expect(opportunity.checked).toBe(true);
    expect(opportunity.disabled).toBe(true);
    expect(within(list).getByTestId('review-sample-whole-why-Opportunity').textContent).toBe(
      'an object of few records that drawn records name',
    );

    fireEvent.click(within(list).getByTestId('review-sample-whole-Account'));
    expect(sample()).toEqual({ whole: ['Account'] });
    expect(requests().slice(-1)[0].config.sample).toEqual({ whole: ['Account'] });

    fireEvent.click(within(list).getByTestId('review-sample-whole-Account'));
    expect(sample()).toEqual({});
  });

  it('goes back to every record once chosen, and reads the budget of every record', () => {
    renderBlock({ ...WHOLE_ORG, sample: { seed: 2 } });

    fireEvent.click(screen.getByTestId('review-sample-every'));

    expect(useForgeStore.getState().config).not.toHaveProperty('sample');
    expect(screen.queryByTestId('review-sample-options')).toBeNull();
    expect(requests().slice(-1)[0].config).not.toHaveProperty('sample');
  });

  it('reads it with the mute Review holds: what the mute silences creates no record', () => {
    useForgeStore.getState().setConfig(WHOLE_ORG);
    useForgeStore.getState().setMuteAutomation(true);
    render(<ReviewWholeOrgSample graph={wholeOrgGraph()} source="prod" target="dev" />);

    expect(requests().slice(-1)[0].muteAutomation).toBe(true);
  });
});
