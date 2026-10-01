import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import type { BaseMessage, ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import '../../i18n';
import { useForgeStore } from '../../stores/useForgeStore';
import { useForgeViewStore } from '../../stores/useForgeViewStore';
import { MotionProvider } from '../../motion/MotionProvider';
import { ForgePage } from './ForgePage';

/*
 * A discovery, from Discover to its graph, with the page left and come back
 * to as the command palette or a shortcut leaves it — unmounted, then mounted
 * again — and with Back and Discover again: the page with the real store, the
 * input screen and the discovery screen.
 */

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

vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      orgs: [
        {
          id: 'org-source',
          alias: 'Source',
          username: 'source@example.test',
          instanceUrl: 'https://source.example.test',
          status: 'connected',
          orgType: 'Sandbox',
          safetyTier: 'low',
        },
        {
          id: 'org-target',
          alias: 'Target',
          username: 'target@example.test',
          instanceUrl: 'https://target.example.test',
          status: 'connected',
          orgType: 'Sandbox',
          safetyTier: 'low',
        },
      ],
      selectedOrgId: 'org-source',
    }),
}));

vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ navigate: vi.fn(), currentRoute: 'forge', aiAvailable: false }),
}));

vi.mock('../../components/graph/LiveGraph', () => ({
  LiveGraph: () => <div data-testid="live-graph" />,
}));

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 3,
    fieldCount: 20,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 15,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

/** What a first discovery answers with: one account. */
const FIRST_GRAPH: ForgeGraph = {
  nodes: [node('Account', 0)],
  edges: [],
  totalRecords: 1,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 1,
};

/** What a second discovery answers with: the account and its contacts. */
const SECOND_GRAPH: ForgeGraph = {
  nodes: [node('Account', 0), node('Contact', 1)],
  edges: [],
  totalRecords: 4,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 2,
};

/**
 * The page as the panel renders it, with its motion features: each screen
 * goes out before the next comes in, as it does in the panel. Without them
 * the screens swap at once, and an answer that comes between the two is
 * never put to the test.
 */
function renderPage(): ReturnType<typeof render> {
  return render(
    <MotionProvider>
      <ForgePage />
    </MotionProvider>,
  );
}

/** The messages of `type` the page posted. */
function posted(type: string): Array<BaseMessage & { payload?: unknown }> {
  return mockPostMessage.mock.calls
    .map(([envelope]) => (envelope as { payload: BaseMessage & { payload?: unknown } }).payload)
    .filter((message) => message.type === type);
}

/** The extension posting `type`, answering `correlationId`. */
function host(type: string, payload: Record<string, unknown>, correlationId: string): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { id: `host-${type}`, type, timestamp: Date.now(), correlationId, payload },
      }),
    );
  });
}

/**
 * On the input screen, a record and a target set, and Discover clicked.
 * Nothing is awaited: the discovery screen comes in once the input screen has
 * gone out.
 *
 * @returns the request of the discovery sent.
 */
function discover(): string {
  fireEvent.change(screen.getByTestId('forge-input-record'), {
    target: { value: '001000000000001AAA' },
  });
  fireEvent.click(screen.getByTestId('forge-target-org'));
  fireEvent.click(screen.getByTestId('forge-target-org-option-org-target'));
  fireEvent.click(screen.getByTestId('forge-discover-btn'));
  const sent = posted('forge:discover');
  return sent[sent.length - 1].id;
}

/** The objects the discovery screen counts, once it shows a graph. */
async function objectsShown(): Promise<string | null> {
  await screen.findByTestId('forge-discovery');
  return screen.getByTestId('stat-objects').textContent;
}

beforeEach(() => {
  mockPostMessage.mockClear();
  useForgeStore.getState().reset();
  useForgeViewStore.setState({ setting: 'auto', choice: null });
});

describe('ForgePage — a discovery that answers while the page is away', () => {
  it('shows the graph its discovery answered with while the page was away', async () => {
    const { unmount } = renderPage();
    const discovery = discover();
    await screen.findByTestId('forge-discovery-loading');
    // The palette or a shortcut takes the panel to another page.
    unmount();

    host('forge:discover:response', { graph: SECOND_GRAPH }, discovery);

    renderPage();
    expect(await objectsShown()).toBe('2');
    expect(screen.queryByTestId('forge-discovery-loading')).toBeNull();
    expect(posted('forge:execute')).toEqual([]);
  });

  it('shows the error its discovery ended on while the page was away, and retries it', async () => {
    const { unmount } = renderPage();
    const discovery = discover();
    await screen.findByTestId('forge-discovery-loading');
    unmount();

    host('forge:discover:error', { message: 'INVALID_SESSION_ID: session expired' }, discovery);

    renderPage();
    const empty = await screen.findByTestId('forge-discovery-empty');
    expect(empty.textContent).toContain('INVALID_SESSION_ID');
    expect(screen.queryByTestId('forge-discovery-loading')).toBeNull();

    fireEvent.click(screen.getByTestId('forge-retry-discovery'));
    const retry = posted('forge:discover')[1];
    host('forge:discover:response', { graph: FIRST_GRAPH }, retry.id);
    expect(await objectsShown()).toBe('1');
  });

  it('shows the graph of a discovery that answers before its screen has come in', async () => {
    renderPage();
    const discovery = discover();

    // A discovery the extension answers from its cache answers at once.
    host('forge:discover:response', { graph: SECOND_GRAPH }, discovery);

    expect(await objectsShown()).toBe('2');
  });
});

describe('ForgePage — Back, then Discover again', () => {
  /** A first discovery answered on its screen and shown, then Back to the input screen. */
  async function firstDiscoveryThenBack(): Promise<void> {
    renderPage();
    const first = discover();
    await screen.findByTestId('forge-discovery-loading');
    host('forge:discover:response', { graph: FIRST_GRAPH }, first);
    expect(await objectsShown()).toBe('1');
    fireEvent.click(screen.getByTestId('forge-back-btn'));
    await screen.findByTestId('forge-input');
  }

  it('shows the second discovery’s graph, never the first one’s, however soon it answers', async () => {
    await firstDiscoveryThenBack();

    const second = discover();
    host('forge:discover:response', { graph: SECOND_GRAPH }, second);

    expect(await objectsShown()).toBe('2');
  });

  it('shows no graph while the second discovery runs: the first one’s is not its answer', async () => {
    await firstDiscoveryThenBack();

    discover();

    expect(await screen.findByTestId('forge-discovery-loading')).toBeDefined();
    expect(screen.queryByTestId('forge-execute-btn')).toBeNull();
  });

  it('keeps the second discovery’s graph when the first one, cancelled, answers late', async () => {
    renderPage();
    const first = discover();
    fireEvent.click(await screen.findByTestId('forge-discovery-cancel'));
    await screen.findByTestId('forge-input');
    const second = discover();
    await screen.findByTestId('forge-discovery-loading');

    // The first discovery's answer was on its way before the abort reached it.
    host('forge:discover:response', { graph: FIRST_GRAPH }, first);
    expect(screen.getByTestId('forge-discovery-loading')).toBeDefined();
    host('forge:discover:response', { graph: SECOND_GRAPH }, second);
    expect(await objectsShown()).toBe('2');
    host('forge:discover:response', { graph: FIRST_GRAPH }, first);

    expect(screen.getByTestId('stat-objects').textContent).toBe('2');
    expect(useForgeStore.getState().graph).toEqual(SECOND_GRAPH);
  });

  it('stops the second discovery on Back, and takes nothing it answers after', async () => {
    await firstDiscoveryThenBack();
    const second = discover();

    fireEvent.click(await screen.findByTestId('forge-discovery-cancel'));

    expect(posted('forge:abort')).toHaveLength(1);
    await screen.findByTestId('forge-input');
    host('forge:discover:response', { graph: SECOND_GRAPH }, second);
    expect(useForgeStore.getState().graph).toEqual(FIRST_GRAPH);
    expect(useForgeStore.getState().phase).toBe('input');
  });
});
