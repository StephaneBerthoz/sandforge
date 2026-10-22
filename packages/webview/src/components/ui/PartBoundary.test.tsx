import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../i18n';
import { PartBoundary } from './PartBoundary';

const vscodeApiMock = vi.hoisted(() => ({
  postMessage: vi.fn(),
  getState: vi.fn(() => undefined),
  setState: vi.fn(),
}));

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => vscodeApiMock,
  useVSCodeApi: () => vscodeApiMock,
}));

const CHUNK_URL =
  'https://file+.vscode-resource.vscode-cdn.net/home/someone/ext/webview-dist/assets/chunks/StorageDonut-x1.js';

/** A part loaded on demand whose file the browser could not fetch. */
const NotFetched = React.lazy(() =>
  Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${CHUNK_URL}`)),
);

/** A part that breaks as it renders. */
const Broken: React.FC = () => {
  throw new Error('part render failed');
};

/** The posted bridge messages of one type. */
function posted(type: string): unknown[] {
  return vscodeApiMock.postMessage.mock.calls
    .map((call) => (call[0] as { payload: { type: string } }).payload)
    .filter((message) => message.type === type);
}

describe('PartBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vscodeApiMock.postMessage.mockClear();
  });

  afterEach(() => {
    delete window.__SANDFORGE_MODULE__;
  });

  it('renders the part as it is when nothing fails', () => {
    render(
      <PartBoundary>
        <p data-testid="part">chart</p>
      </PartBoundary>,
    );

    expect(screen.getByTestId('part')).toBeInTheDocument();
    expect(screen.queryByTestId('part-failed')).toBeNull();
  });

  it('keeps a part whose file could not be fetched to its place, said in words, the rest of the page up', async () => {
    // Only the page's boundary caught it: a decorative chart replaced the
    // whole Monitor page, Live Operations and its Stop buttons with it.
    render(
      <div>
        <button type="button">Stop</button>
        <PartBoundary data-testid="donut-failed">
          <React.Suspense fallback={null}>
            <NotFetched />
          </React.Suspense>
        </PartBoundary>
      </div>,
    );
    const failed = await screen.findByTestId('donut-failed');

    expect(failed).toHaveAttribute('role', 'alert');
    expect(failed).toHaveTextContent('This part did not load');
    expect(failed.textContent).not.toContain('someone');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(posted('error:boundary')).toHaveLength(1);
  });

  it('reloads the panel from its button, the one way back for a part React keeps failed', async () => {
    window.__SANDFORGE_MODULE__ = 'monitor';
    render(
      <PartBoundary>
        <React.Suspense fallback={null}>
          <NotFetched />
        </React.Suspense>
      </PartBoundary>,
    );

    fireEvent.click(await screen.findByTestId('part-failed-reload'));

    expect(posted('panel:reload')).toEqual([
      expect.objectContaining({ payload: { moduleId: 'monitor' } }),
    ]);
  });

  it('says a part that broke as it rendered stopped with an error, and what else it means', () => {
    render(
      <PartBoundary note="The run goes on in the extension.">
        <Broken />
      </PartBoundary>,
    );

    const failed = screen.getByTestId('part-failed');
    expect(failed).toHaveTextContent('This part stopped with an error');
    expect(failed).toHaveTextContent('The run goes on in the extension.');
  });
});
