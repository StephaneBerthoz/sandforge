import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { BaseMessage, SeedScenarioPackEntry } from '@sandforge/shared';
import { BUILT_IN_SCENARIO_PACKS, RETAIL_ORDERS_PACK } from '@sandforge/shared';
import '../../../i18n';

const mockPostMessage = vi.fn();
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

import { ScenarioCards } from './ScenarioCards';
import { useAppStore } from '../../../stores/useAppStore';

function sent(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type);
}

function answer(requestType: string, type: string, payload: unknown): void {
  const request = sent(requestType).pop();
  if (!request) throw new Error(`no '${requestType}' was sent`);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${Math.random()}`,
          type,
          timestamp: Date.now(),
          correlationId: request.id,
          payload,
        },
      }),
    );
  });
}

const OWN = { ...RETAIL_ORDERS_PACK, id: 'own-shop', name: 'Our shop' };
const PACKS: SeedScenarioPackEntry[] = [
  ...BUILT_IN_SCENARIO_PACKS.map((pack) => ({ source: 'built-in' as const, pack })),
  {
    source: 'workspace',
    path: '/ws/own-shop.sandforge-scenario.json',
    relativePath: 'own-shop.sandforge-scenario.json',
    pack: OWN,
  },
  {
    source: 'workspace',
    path: '/ws/broken.sandforge-scenario.json',
    relativePath: 'broken.sandforge-scenario.json',
    issues: ['topics: Too small: expected array to have >=3 items'],
  },
];

describe('ScenarioCards', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useAppStore.setState({ aiAvailable: false });
  });

  it('shows a card for each shipped pack in the interface language, and each workspace pack by its file', () => {
    render(<ScenarioCards onPick={vi.fn()} onDraft={vi.fn()} />);
    answer('seed:scenario:packs', 'seed:scenario:packs:response', {
      packs: PACKS,
      workspace: true,
    });

    expect(screen.getByTestId('scenario-card-retail-orders').textContent).toContain(
      'Online shop orders',
    );
    expect(screen.getByTestId('scenario-card-saas-support').textContent).toContain('5 topics');
    expect(screen.getByTestId('scenario-card-own-shop').textContent).toContain(
      'Saved in own-shop.sandforge-scenario.json',
    );
  });

  it('says why a file named as a pack is not one, with the field', () => {
    render(<ScenarioCards onPick={vi.fn()} onDraft={vi.fn()} />);
    answer('seed:scenario:packs', 'seed:scenario:packs:response', {
      packs: PACKS,
      workspace: true,
    });

    const card = screen.getByTestId('scenario-card-invalid-broken.sandforge-scenario.json');
    expect(card.textContent).toContain('Not a scenario pack');
    expect(card.textContent).toContain('topics: Too small');
  });

  it('opens the review of the pack picked, with where it comes from, and writes nothing', () => {
    const onPick = vi.fn();
    render(<ScenarioCards onPick={onPick} onDraft={vi.fn()} />);
    answer('seed:scenario:packs', 'seed:scenario:packs:response', {
      packs: PACKS,
      workspace: true,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Review the scenario Our shop' }));

    expect(onPick).toHaveBeenCalledWith({
      pack: OWN,
      source: {
        kind: 'workspace',
        path: '/ws/own-shop.sandforge-scenario.json',
        relativePath: 'own-shop.sandforge-scenario.json',
      },
    });
    expect(sent('seed:scenario:execute')).toEqual([]);
  });

  it('offers to draft a pack from the user’s own text only with AI on', () => {
    const onDraft = vi.fn();
    const { rerender } = render(<ScenarioCards onPick={vi.fn()} onDraft={onDraft} />);
    expect(screen.queryByTestId('scenario-card-draft')).toBeNull();

    act(() => useAppStore.setState({ aiAvailable: true }));
    rerender(<ScenarioCards onPick={vi.fn()} onDraft={onDraft} />);
    fireEvent.click(screen.getByTestId('btn-draft-scenario'));

    expect(onDraft).toHaveBeenCalled();
  });
});
