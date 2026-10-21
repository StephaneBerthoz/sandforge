import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import fr from '../i18n/locales/fr.json';
import { useRouteFocus } from './useRouteFocus';

/** What a page draws: its heading, or nothing yet while its chunk loads. */
type PageShape = 'heading' | 'no-heading' | 'loading';

interface ShellProps {
  route: string;
  page: PageShape;
}

/** The panel shell as PanelApp draws it: a focusable main holding the page. */
function Shell({ route, page }: ShellProps): React.ReactElement {
  useRouteFocus(route);
  return (
    <>
      <button data-testid="outside">outside</button>
      <main id="main-content" tabIndex={-1} data-testid="main">
        {page === 'heading' && (
          <div key={route}>
            <h1 tabIndex={-1} data-testid={`heading-${route}`}>
              {route}
            </h1>
            <button data-testid={`cta-${route}`}>go</button>
          </div>
        )}
        {page === 'no-heading' && <p key={route}>{route}</p>}
        {page === 'loading' && <div data-testid="panel-loading" aria-busy="true" />}
      </main>
    </>
  );
}

function byTestId(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing ${id}`);
  return el;
}

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

describe('useRouteFocus', () => {
  it('leaves the focus where it was when the panel first draws its page', async () => {
    render(<Shell route="home" page="heading" />);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(document.body);
  });

  it('hands the new page its heading once the page changed and the control that navigated is gone', async () => {
    const { rerender } = render(<Shell route="home" page="heading" />);
    byTestId('cta-home').focus();
    rerender(<Shell route="seed" page="heading" />);
    await waitFor(() => expect(document.activeElement).toBe(byTestId('heading-seed')));
  });

  it('hands the main landmark the focus when the new page has no heading', async () => {
    const { rerender } = render(<Shell route="home" page="heading" />);
    rerender(<Shell route="sync" page="no-heading" />);
    await waitFor(() => expect(document.activeElement).toBe(byTestId('main')));
  });

  it('holds the focus on the main landmark while the page loads, then hands it the heading drawn', async () => {
    const { rerender } = render(<Shell route="home" page="heading" />);
    rerender(<Shell route="forge" page="loading" />);
    await waitFor(() => expect(document.activeElement).toBe(byTestId('main')));
    rerender(<Shell route="forge" page="heading" />);
    await waitFor(() => expect(document.activeElement).toBe(byTestId('heading-forge')));
  });

  it('hands the focus on when a loading page takes back the heading it was given', async () => {
    // Monitor draws a heading for a frame, then its skeleton: the focus the
    // heading held fell to <body>.
    const { rerender } = render(<Shell route="home" page="heading" />);
    rerender(<Shell route="monitor" page="heading" />);
    await waitFor(() => expect(document.activeElement).toBe(byTestId('heading-monitor')));
    rerender(<Shell route="monitor" page="loading" />);
    await waitFor(() => expect(document.activeElement).toBe(byTestId('main')));
    rerender(<Shell route="monitor" page="heading" />);
    await waitFor(() => expect(document.activeElement).toBe(byTestId('heading-monitor')));
  });

  it('leaves the focus where the user put it while the page loaded', async () => {
    const { rerender } = render(<Shell route="home" page="heading" />);
    rerender(<Shell route="forge" page="loading" />);
    await waitFor(() => expect(document.activeElement).toBe(byTestId('main')));
    byTestId('outside').focus();
    rerender(<Shell route="forge" page="heading" />);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(byTestId('outside'));
  });

  it('leaves the focus on a control outside the page, an overlay or the palette open over it', async () => {
    const { rerender } = render(<Shell route="home" page="heading" />);
    byTestId('outside').focus();
    rerender(<Shell route="monitor" page="heading" />);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(byTestId('outside'));
  });

  it('names the page in the document title, in the panel language', async () => {
    const { rerender } = render(<Shell route="home" page="heading" />);
    expect(document.title).toBe('SandForge: Home');
    rerender(<Shell route="orgs" page="heading" />);
    expect(document.title).toBe('SandForge: Organizations');
    // Each locale but English is loaded when the panel switches to it.
    i18n.addResourceBundle('fr', 'translation', fr);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
    expect(document.title).toBe('SandForge: Organisations');
  });
});
