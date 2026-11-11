import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { ForgeConfig } from '@sandforge/shared';
import { useForgeStore } from '../../stores/useForgeStore';
import { useForgeRunGateStore } from './runGate';
import { ForgeRunGateNotice } from './ForgeRunGateNotice';

/*
 * Whether the system asks for reduced motion, as framer-motion reads it. It
 * reads the setting once, the first time a component asks: the hook stands in
 * here, so that each test sets its own.
 */
const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock('framer-motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('framer-motion')>()),
  useReducedMotion: () => motion.reduced,
}));

describe('ForgeRunGateNotice', () => {
  beforeEach(() => {
    act(() => useForgeRunGateStore.getState().clear());
    useForgeStore.setState({ config: null });
  });

  it('says nothing while no run stopped at its gate', () => {
    render(<ForgeRunGateNotice />);
    expect(screen.queryByTestId('forge-run-gate-notice')).toBeNull();
  });

  it('alerts that a production target was refused before anything was read', () => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'PRODUCTION_TARGET' }));
    render(<ForgeRunGateNotice />);

    const notice = screen.getByTestId('forge-run-gate-notice');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(
      'The run did not start: the target org is a production org, or one SandForge cannot tell is a sandbox, a scratch org or a Developer Edition org. Forge writes to those only, and nothing was read or written. Pick one of them as the target.',
    );
  });

  it('says what the records take and what the target had left, for a refusal for storage', () => {
    act(() =>
      useForgeRunGateStore
        .getState()
        .setStop({ code: 'STORAGE_EXCEEDED', storage: { estimateMB: 66.9, remainingMB: 12 } }),
    );
    render(<ForgeRunGateNotice />);

    expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(
      'The run was refused before it wrote anything: its records take about 66.9 MB of data storage, and the target org has 12 MB left. Leave objects out, lower the records per object, or free data storage in the target org.',
    );
  });

  it.each([
    [
      'AUTOMATION_DECLINED' as const,
      'You cancelled the run at the confirmation of what the target org runs as the records are inserted. Nothing was read or written.',
    ],
    [
      'READ_DECLINED' as const,
      'You cancelled the run at the confirmation of the tables it reads with no cap per object, each past 50,000 records. Nothing was read or written. Set Records per object to read fewer.',
    ],
    [
      'WRITE_DECLINED' as const,
      'You cancelled the run before it wrote anything. The source records were read; nothing was written to the target org.',
    ],
  ])('tells, without alarm, of a run the user cancelled at a question (%s)', (code, text) => {
    act(() => useForgeRunGateStore.getState().setStop({ code }));
    render(<ForgeRunGateNotice />);

    expect(screen.getByTestId('forge-run-gate-notice').getAttribute('role')).toBe('status');
    expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(text);
  });

  it('says the most rows of one object the run was set to read, past which the user cancelled', () => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'READ_DECLINED', ceiling: 200_000 }));
    render(<ForgeRunGateNotice />);

    expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(
      'You cancelled the run at the confirmation of the tables it reads with no cap per object, each past 200,000 records. Nothing was read or written. Set Records per object to read fewer.',
    );
  });

  it('says a run that needed a confirmation nobody could give was stopped', () => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'CONFIRMATION_UNAVAILABLE' }));
    render(<ForgeRunGateNotice />);

    expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(
      'The run was stopped before it wrote anything: it needed your confirmation, and none could be asked.',
    );
  });

  // A clone of the whole org has no records per object to lower.
  it('says the whole org’s records take more data storage than the target has, with no cap to lower', () => {
    useForgeStore.setState({
      config: {
        inputMode: 'org',
        depth: 'all',
        sourceOrgId: 'org-source',
        targetOrgId: 'org-target',
        anonymizePII: true,
        skipEmpty: true,
        batchSize: 'auto',
      } satisfies ForgeConfig,
    });
    act(() =>
      useForgeRunGateStore
        .getState()
        .setStop({ code: 'STORAGE_EXCEEDED', storage: { estimateMB: 1_250, remainingMB: 800 } }),
    );
    render(<ForgeRunGateNotice />);

    expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(
      'The run was refused before it wrote anything: the records of the whole org take about 1,250 MB of data storage, and the target org has 800 MB left. Leave objects out on Review, or free data storage in the target org.',
    );
  });

  it('says the files a run copies take more file storage than the target has', () => {
    act(() =>
      useForgeRunGateStore.getState().setStop({
        code: 'STORAGE_EXCEEDED',
        storage: { estimateMB: 4_096, remainingMB: 1_024, kind: 'files' },
      }),
    );
    render(<ForgeRunGateNotice />);

    expect(screen.getByTestId('forge-run-gate-notice').getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(
      'The run was refused before it wrote anything: the files it copies take about 4,096 MB of file storage, and the target org has 1,024 MB left. Leave the files out on Review, or free file storage in the target org.',
    );
  });

  // Neither is a question the user answered: both alert, as a refusal does,
  // and neither says "You cancelled".
  it.each([
    [
      { kind: 'requests', org: 'target', estimate: 90_000, remaining: 1_000 } as const,
      'The run was refused before it wrote anything: it would take about 90,000 API requests of the target org, which has 1,000 left today. Run it once the org has more to spare, or leave objects out on Review.',
    ],
    [
      { kind: 'requests', org: 'source', estimate: 40_000, remaining: 2_500 } as const,
      'The run was refused before it wrote anything: reading the source org would take about 40,000 of its API requests, and it has 2,500 left today. Run it once the org has more to spare, or leave objects out on Review.',
    ],
    [
      { kind: 'bulkBatches', org: 'target', estimate: 16_000, remaining: 9_000 } as const,
      'The run was refused before it wrote anything: its Bulk API jobs would take about 16,000 batches of the target org, which has 9,000 left over the last 24 hours. Run it once the org has more to spare.',
    ],
  ])('alerts that a run was refused for the allowance and the org it names (%o)', (api, text) => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'API_BUDGET_EXCEEDED', api }));
    render(<ForgeRunGateNotice />);

    expect(screen.getByTestId('forge-run-gate-notice').getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(text);
  });

  it('says a refusal for the API budget that names no allowance in the words of the code', () => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'API_BUDGET_EXCEEDED' }));
    render(<ForgeRunGateNotice />);

    expect(screen.getByTestId('forge-run-gate-notice').getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(
      'The run was refused before it wrote anything: it would take more API requests than the source or target org has left today, or more Bulk API batches than the target has left. Run it once the org has some to spare.',
    );
  });

  it('alerts that a clone of the whole org was refused for the objects it reads whole past its bound', () => {
    act(() =>
      useForgeRunGateStore.getState().setStop({
        code: 'READ_BOUND_EXCEEDED',
        readBound: {
          bound: 50_000,
          objects: [
            { objectApiName: 'PricebookEntry', rows: 72_000 },
            { objectApiName: 'Product2', rows: 51_000 },
          ],
        },
      }),
    );
    render(<ForgeRunGateNotice />);

    expect(screen.getByTestId('forge-run-gate-notice').getAttribute('role')).toBe('alert');
    const reason = screen.getByTestId('forge-run-gate-reason').textContent;
    expect(reason).toBe(
      'The run was refused before it wrote anything: a clone of the whole org reads a few objects whole, and more than 50,000 records, as many as the sandforge.forge.maxRecordsPerObject setting lets it hold at once, were found in PricebookEntry, Product2. Raise the setting, or leave these objects out on Review.',
    );
    expect(reason).not.toMatch(/cancelled/);
  });

  it('goes once dismissed', () => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'WRITE_DECLINED' }));
    render(<ForgeRunGateNotice />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByTestId('forge-run-gate-notice')).toBeNull();
    expect(useForgeRunGateStore.getState().stop).toBeNull();
  });
});

describe('ForgeRunGateNotice brought into view', () => {
  /** The frames asked for and not yet drawn, by id. */
  let frames: Map<number, FrameRequestCallback>;
  let scrolled: ReturnType<typeof vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>>;
  const scrollIntoView = Element.prototype.scrollIntoView;

  /** Draw the frames asked for, as the browser does once the page is painted. */
  function nextFrame(): void {
    const pending = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of pending) callback(0);
    });
  }

  beforeEach(() => {
    act(() => useForgeRunGateStore.getState().clear());
    useForgeStore.setState({ config: null });
    motion.reduced = false;
    frames = new Map();
    let lastId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      lastId += 1;
      frames.set(lastId, callback);
      return lastId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id);
    });
    scrolled = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
    Element.prototype.scrollIntoView = scrolled;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Element.prototype.scrollIntoView = scrollIntoView;
    (document.activeElement as HTMLElement | null)?.blur();
  });

  it('scrolls the notice of a refusal into view and hands it the keyboard, once the page is painted', () => {
    // Clicked at the foot of a long Review, Execute brought the page back with
    // the notice above the fold, and nothing changed where the user looked.
    act(() => useForgeRunGateStore.getState().setStop({ code: 'STORAGE_EXCEEDED' }));
    render(<ForgeRunGateNotice />);
    const notice = screen.getByTestId('forge-run-gate-notice');
    expect(scrolled).not.toHaveBeenCalled();

    nextFrame();

    expect(scrolled).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
    expect(scrolled.mock.contexts[0]).toBe(notice);
    expect(document.activeElement).toBe(notice);
    expect(useForgeRunGateStore.getState().revealed).toBe(true);
  });

  it('is focusable from code only, never a stop of the Tab key, and draws no outline', () => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'PRODUCTION_TARGET' }));
    render(<ForgeRunGateNotice />);

    const notice = screen.getByTestId('forge-run-gate-notice');
    expect(notice.getAttribute('tabindex')).toBe('-1');
    expect(notice.className).toContain('focus:outline-hidden');
  });

  it('jumps to the notice rather than scrolling smoothly when the system asks for reduced motion', () => {
    motion.reduced = true;
    act(() => useForgeRunGateStore.getState().setStop({ code: 'STORAGE_EXCEEDED' }));
    render(<ForgeRunGateNotice />);

    nextFrame();

    expect(scrolled).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' });
  });

  it('leaves the keyboard on a control outside the page, scrolling the notice into view all the same', () => {
    render(<button data-testid="outside">outside</button>);
    const outside = screen.getByTestId('outside');
    outside.focus();
    act(() => useForgeRunGateStore.getState().setStop({ code: 'STORAGE_EXCEEDED' }));
    render(<ForgeRunGateNotice />);

    nextFrame();

    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(outside);
    expect(useForgeRunGateStore.getState().revealed).toBe(true);
  });

  it('takes the keyboard from the group around it, which the page hands each phase', () => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'STORAGE_EXCEEDED' }));
    render(
      <div role="group" tabIndex={-1} data-testid="phase">
        <ForgeRunGateNotice />
      </div>,
    );
    screen.getByTestId('phase').focus();

    nextFrame();

    expect(document.activeElement).toBe(screen.getByTestId('forge-run-gate-notice'));
  });

  it('does the same for a run the user cancelled at a question, said without alarm', () => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'WRITE_DECLINED' }));
    render(<ForgeRunGateNotice />);
    const notice = screen.getByTestId('forge-run-gate-notice');
    expect(notice.getAttribute('role')).toBe('status');

    nextFrame();

    expect(scrolled).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
    expect(document.activeElement).toBe(notice);
  });

  it('is not brought into view again when the page is drawn again with the same stop', () => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'STORAGE_EXCEEDED' }));
    const first = render(<ForgeRunGateNotice />);
    nextFrame();
    first.unmount();
    scrolled.mockClear();

    render(<ForgeRunGateNotice />);
    nextFrame();

    expect(scrolled).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it('is brought into view again for the next stop, once the last was dismissed', () => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'STORAGE_EXCEEDED' }));
    render(<ForgeRunGateNotice />);
    nextFrame();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    scrolled.mockClear();

    act(() => useForgeRunGateStore.getState().setStop({ code: 'PRODUCTION_TARGET' }));
    nextFrame();

    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByTestId('forge-run-gate-notice'));
  });

  it('marks nothing when it goes before the page is painted, as a mount StrictMode undoes', () => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'STORAGE_EXCEEDED' }));
    const { unmount } = render(<ForgeRunGateNotice />);
    expect(frames.size).toBe(1);

    unmount();

    expect(frames.size).toBe(0);
    expect(useForgeRunGateStore.getState().revealed).toBe(false);
  });
});
