import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../i18n';
import en from '../../i18n/locales/en.json';
import { useAppStore } from '../../stores/useAppStore';
import { useGrappeStore } from '../../stores/useGrappeStore';
import { GrappePage } from './GrappePage';

const mockPostMessage = vi.fn();
vi.mock('../../hooks/useVSCodeApi', () => {
  const api = {
    postMessage: (message: unknown) => mockPostMessage(message),
    getState: () => undefined,
    setState: () => undefined,
  };
  return { useVSCodeApi: () => api, getVscodeApi: () => api };
});

/** The payloads of every message of `type` the page posted. */
function sent(type: string): unknown[] {
  return mockPostMessage.mock.calls
    .map(([envelope]) => (envelope as { payload: { type: string; payload?: unknown } }).payload)
    .filter((message) => message.type === type)
    .map((message) => message.payload);
}

describe('GrappePage empty state', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useAppStore.setState({ currentRoute: 'grappe', grappeEnabled: false });
    useGrappeStore.setState({
      active: false,
      totalPartitions: 0,
      totalRecords: 0,
      partitions: new Map(),
      totalProcessed: 0,
      totalFailed: 0,
    });
  });

  it('sends the user to a module whose runs can actually populate this page', () => {
    // Only Seed, Sync and Autopilot emit grappe:* events. The CTA used to open
    // Forge, which emits none — following it could never fill the dashboard it
    // was offered from.
    render(<GrappePage />);
    fireEvent.click(screen.getByTestId('grappe-settings'));
    expect(useAppStore.getState().currentRoute).toBe('seed');
  });

  it('opens the setting that turns Grappe on, in the Settings editor', () => {
    // Grappe needs sandforge.grappe.enabled, off by default: the page said so,
    // with no way to get there.
    render(<GrappePage />);
    fireEvent.click(screen.getByRole('button', { name: en.grappe.openSetting }));

    expect(sent('workbench:open-setting')).toEqual([{ setting: 'sandforge.grappe.enabled' }]);
  });

  it('should label the call to action as a module action, not a settings one', () => {
    render(<GrappePage />);
    expect(screen.getByTestId('grappe-settings').textContent).toBe(en.grappe.openSeed);
  });

  it('names only settings that exist, and offers no settings screen of its own', () => {
    // The empty state used to read "Configure threshold in Settings" under a
    // "Configure Threshold" button, for a screen this webview does not have.
    // An earlier fix answered that by banning the word, which also banned the
    // honest sentence: `sandforge.grappe.autoActivateThreshold` is a real
    // setting, and telling the reader what turns Grappe on is the point of an
    // empty state. So the check is what it was written for — every
    // `sandforge.*` this page names is contributed by the manifest, and the
    // only action offered is the module one.
    render(<GrappePage />);
    const page = screen.getByTestId('grappe-page');
    expect(page.textContent).not.toMatch(/configure threshold/i);
    expect(screen.getByTestId('grappe-settings').textContent).toBe(en.grappe.openSeed);

    // Resolved from the working directory, not from `import.meta.url`: the
    // webview is transformed for a browser, where that URL has no file scheme.
    const manifestPath = ['../extension/package.json', 'packages/extension/package.json']
      .map((candidate) => resolve(process.cwd(), candidate))
      .find((candidate) => existsSync(candidate));
    expect(manifestPath, 'the extension manifest is not where this test looks').toBeDefined();
    const manifest = JSON.parse(readFileSync(manifestPath as string, 'utf8')) as {
      contributes: { configuration: { properties: Record<string, unknown> } };
    };
    const contributed = Object.keys(manifest.contributes.configuration.properties);
    expect(contributed.length).toBeGreaterThan(0);
    // Text node by text node: the page's textContent runs the how-to's steps
    // together, "…grappe.enabled.Leave the page…", and read a setting that is
    // not one. `[\w.]*\w` so a full stop ending the sentence is not read as
    // part of the id.
    const texts: string[] = [];
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) texts.push(walker.currentNode.textContent ?? '');
    for (const named of texts.join(' ').match(/sandforge\.[\w.]*\w/g) ?? []) {
      expect(contributed).toContain(named);
    }
    expect(screen.getByText(en.grappe.emptyDesc)).toBeDefined();
  });

  it('says what the page is for before anything about a setting', () => {
    // It opened on "Grappe needs sandforge.grappe.enabled." under "No Active
    // Grappes", a setting id to a newcomer who did not know what Grappe was.
    render(<GrappePage />);
    const empty = screen.getByTestId('grappe-empty');

    expect(within(empty).getByRole('heading').textContent).toBe('No large run in progress');
    expect(empty.textContent).toContain(
      "Grappe shows a large run's progress, partition by partition. Turn it on to follow your next Seed of 10,000 records or more.",
    );
    expect(empty.textContent).not.toContain('sandforge.grappe.enabled');
  });

  it('keeps the setting id on the button that opens it, said when it is pointed at or focused', async () => {
    render(<GrappePage />);
    const button = screen.getByTestId('grappe-open-setting');
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.focus(button);

    expect((await screen.findByRole('tooltip')).textContent).toBe('sandforge.grappe.enabled');
  });

  it('no longer asks to turn Grappe on once it is on', () => {
    useAppStore.setState({ grappeEnabled: true });
    render(<GrappePage />);

    const empty = screen.getByTestId('grappe-empty');
    expect(empty.textContent).toContain(en.grappe.emptyDescOn);
    expect(empty.textContent).not.toContain('Turn it on');
  });
});

describe('GrappePage layout', () => {
  beforeEach(() => {
    useAppStore.setState({ currentRoute: 'grappe', grappeEnabled: false });
    useGrappeStore.setState({
      active: false,
      totalPartitions: 2,
      totalRecords: 12000,
      partitions: new Map(),
      totalProcessed: 11000,
      totalFailed: 3,
    });
  });

  it('opens on the page header its neighbours use, not a header of its own', () => {
    render(<GrappePage />);

    const header = screen.getByTestId('page-header');
    expect(within(header).getByRole('heading', { level: 1 }).textContent).toBe('Grappe');
    expect(screen.getByTestId('page-header-subtitle').textContent).toBe(en.grappe.subtitle);
    // Full width, as every other page: it sat in a centred max-w-6xl column.
    expect(screen.getByTestId('grappe-page').className).not.toContain('max-w-6xl');
  });

  it('shows its totals on KPI cards labelled in sentence case', () => {
    // "Partitions", "Records", "processed", "failed": two of four in lower case.
    render(<GrappePage />);

    const cards = within(screen.getByTestId('grappe-kpi-row')).getAllByTestId('kpi-card');
    expect(cards.map((card) => card.querySelector('.text-sm')?.textContent)).toEqual([
      'Partitions',
      'Records',
      'Processed',
      'Failed',
    ]);
    expect(cards.map((card) => within(card).getByTestId('kpi-value').textContent)).toEqual([
      '2',
      '12,000',
      '11,000',
      '3',
    ]);
  });
});

describe('GrappePage active run', () => {
  beforeEach(() => {
    useAppStore.setState({ currentRoute: 'grappe' });
    useGrappeStore.setState({
      active: true,
      totalPartitions: 2,
      totalRecords: 2000,
      partitions: new Map([
        ['Account-1', { grappeId: 'Account-1', percentage: 40, processedRecords: 400 }],
      ]),
      totalProcessed: 0,
      totalFailed: 0,
    });
  });

  it('names the overall bar and each partition bar', () => {
    render(<GrappePage />);
    const overall = screen.getByRole('progressbar', { name: 'Grappe progress' });
    expect(overall.getAttribute('aria-valuenow')).toBe('20');
    expect(screen.getByRole('progressbar', { name: 'Account-1' })).toBeDefined();
  });

  it('heads the run with what it is, and says how far it is in one phrase', () => {
    // "Grappe — Active Execution" under a page already titled Grappe, and
    // "20% Completed" built from a number and a capitalised word.
    render(<GrappePage />);

    expect(screen.getByRole('heading', { level: 2, name: 'Run in progress' })).toBeDefined();
    expect(screen.getByText('20% complete')).toBeDefined();
  });

  it('keeps the Grappe colours on the bars', () => {
    render(<GrappePage />);
    const overall = screen.getByRole('progressbar', { name: 'Grappe progress' });
    expect((overall.firstChild as HTMLElement).className).toContain(
      'bg-linear-to-r from-hue-indigo to-hue-purple',
    );
    const partition = screen.getByRole('progressbar', { name: 'Account-1' });
    expect((partition.firstChild as HTMLElement).className).toContain('bg-hue-indigo');
  });
});
