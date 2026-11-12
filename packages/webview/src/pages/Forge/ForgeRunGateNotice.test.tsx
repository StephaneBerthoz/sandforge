import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { developerOrg } from '../Checkpoint/testing/checkpointFixtures';
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

  it.each([
    [
      'CHECKPOINT_REFUSED' as const,
      'The run was refused before it wrote anything: the checkpoint it was to take first of the objects it writes was refused, or could not be taken. Nothing was written. Untick Checkpoint first to run without it, or fix what refuses it.',
    ],
    [
      'API_BUDGET_EXCEEDED' as const,
      'The run was refused before it wrote anything: it takes more API requests than the target org has left today, and would have stopped part way through. Run it once the org has requests to spare — the daily limit is counted over the last 24 hours — or write fewer records.',
    ],
  ])('alerts that the run was refused at its write gate (%s)', (code, text) => {
    act(() => useForgeRunGateStore.getState().setStop({ code }));
    render(<ForgeRunGateNotice />);

    expect(screen.getByTestId('forge-run-gate-notice').getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(text);
  });

  it('goes once dismissed', () => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'WRITE_DECLINED' }));
    render(<ForgeRunGateNotice />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByTestId('forge-run-gate-notice')).toBeNull();
    expect(useForgeRunGateStore.getState().stop).toBeNull();
  });

  describe('a run refused for the checkpoint it was to take first', () => {
    it('says what refused it, by the take’s own code', () => {
      act(() =>
        useForgeRunGateStore.getState().setStop({ code: 'CHECKPOINT_REFUSED', reason: 'DISK' }),
      );
      render(<ForgeRunGateNotice />);
      expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(
        "The run was refused before it wrote anything: the checkpoint it was to take first of the objects it writes was refused. This machine's disk has too little room for it. Nothing was written. Untick Checkpoint first to run without it, or fix what refuses it.",
      );
      expect(screen.getByTestId('forge-run-gate-notice').getAttribute('role')).toBe('alert');
    });

    it('says another run holds the org, as it would be told', () => {
      act(() =>
        useForgeRunGateStore
          .getState()
          .setStop({ code: 'CHECKPOINT_REFUSED', reason: 'RUN_WRITING' }),
      );
      render(<ForgeRunGateNotice />);
      expect(screen.getByTestId('forge-run-gate-reason').textContent).toContain(
        'Another SandForge run, take, rewind or undo is writing to the org',
      );
    });

    it('says it was refused or could not be taken when the stop names nothing', () => {
      act(() => useForgeRunGateStore.getState().setStop({ code: 'CHECKPOINT_REFUSED' }));
      render(<ForgeRunGateNotice />);
      expect(screen.getByTestId('forge-run-gate-reason').textContent).toContain(
        'was refused, or could not be taken',
      );
    });
  });

  describe('a run past the day’s API requests', () => {
    it('names the checkpoint among them only when the run was to take one', () => {
      act(() =>
        useForgeRunGateStore
          .getState()
          .setStop({ code: 'API_BUDGET_EXCEEDED' }, { checkpointAsked: true }),
      );
      const { unmount } = render(<ForgeRunGateNotice />);
      expect(screen.getByTestId('forge-run-gate-reason').textContent).toContain(
        'the checkpoint it was to take first among them',
      );
      unmount();

      act(() => useForgeRunGateStore.getState().setStop({ code: 'API_BUDGET_EXCEEDED' }));
      render(<ForgeRunGateNotice />);
      const reason = screen.getByTestId('forge-run-gate-reason').textContent;
      expect(reason).toContain('more API requests than the target org has left today');
      expect(reason).not.toContain('checkpoint');
    });
  });

  it('says what became of a checkpoint the run had taken when it stopped', () => {
    useOrgStore.setState({ orgs: [developerOrg()], selectedOrgId: 'org-dev' });
    act(() =>
      useForgeRunGateStore.getState().setStop(
        { code: 'WRITE_DECLINED' },
        {
          checkpointAsked: true,
          checkpoint: { state: 'deleted', deleted: 'nothingWritten' },
        },
      ),
    );
    render(<ForgeRunGateNotice />);
    expect(screen.getByTestId('forge-run-gate-checkpoint-deleted').textContent).toBe(
      'The checkpoint taken before the run was deleted: the run wrote nothing.',
    );
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
    // Followed down the execution screen while the run read and asked, the
    // page came back to Review as far down, the notice above the fold and
    // nothing changed where the user looked.
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
