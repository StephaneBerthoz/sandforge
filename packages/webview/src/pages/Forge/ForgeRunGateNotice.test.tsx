import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { useOrgStore } from '../../stores/useOrgStore';
import { useForgeStore } from '../../stores/useForgeStore';
import type { ForgeConfig, ForgeRunGateStop } from '@sandforge/shared';
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

  it('alerts that a clone of the whole org was refused for the objects it reads whole, naming the bound and each object past it', () => {
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
    expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(
      'The run was refused before it wrote anything: a clone of the whole org reads a few objects whole, and more than 50,000 records, as many as the sandforge.forge.maxRecordsPerObject setting lets it hold at once, were found in PricebookEntry, Product2. Raise the setting, or leave these objects out on Review.',
    );
  });

  /*
   * The refusals of a clone of the whole org, said in the user's language:
   * which storage, which allowance of which org, and files that could not be
   * weighed. The host words them in English, and the page showed that.
   */
  describe('of a clone of the whole org', () => {
    beforeEach(() => {
      act(() =>
        useForgeStore.getState().setConfig({
          inputMode: 'org',
          depth: 'all',
          anonymizePII: true,
          skipEmpty: false,
          batchSize: 'auto',
          sourceOrgId: 'org-src',
          targetOrgId: 'org-tgt',
        } as ForgeConfig),
      );
    });

    afterEach(() => {
      act(() => useForgeStore.setState({ config: null }));
    });

    it.each([
      [
        'the files it copies past the file storage left',
        {
          code: 'STORAGE_EXCEEDED',
          storage: { estimateMB: 2_048, remainingMB: 900, kind: 'files' },
        },
        'The run was refused before it wrote anything: the files it copies take about 2,048 MB of file storage, and the target org has 900 MB left. Leave the files out on Review, or free file storage in the target org.',
      ],
      [
        'its records past the data storage left',
        { code: 'STORAGE_EXCEEDED', storage: { estimateMB: 3_500, remainingMB: 1_000 } },
        'The run was refused before it wrote anything: the records of the whole org take about 3,500 MB of data storage, and the target org has 1,000 MB left. Leave objects out on Review, or free data storage in the target org.',
      ],
      [
        "its reads past the source's requests",
        {
          code: 'API_BUDGET_EXCEEDED',
          api: { kind: 'requests', org: 'source', estimate: 120_000, remaining: 4_000 },
        },
        'The run was refused before it wrote anything: reading the source org would take about 120,000 of its API requests, and it has 4,000 left today. Run it once the org has more to spare, or leave objects out on Review.',
      ],
      [
        "its writes past the target's requests",
        {
          code: 'API_BUDGET_EXCEEDED',
          api: { kind: 'requests', org: 'target', estimate: 60_000, remaining: 5_000 },
        },
        'The run was refused before it wrote anything: it would take about 60,000 API requests of the target org, which has 5,000 left today. Run it once the org has more to spare, or leave objects out on Review.',
      ],
      [
        "its jobs past the target's Bulk API batches",
        {
          code: 'API_BUDGET_EXCEEDED',
          api: { kind: 'bulkBatches', org: 'target', estimate: 16_000, remaining: 2_000 },
        },
        'The run was refused before it wrote anything: its Bulk API jobs would take about 16,000 batches of the target org, which has 2,000 left over the last 24 hours. Run it once the org has more to spare.',
      ],
      [
        'files the source would neither sum nor list',
        { code: 'FILES_UNREAD' },
        'The run was refused before it wrote anything: the source org would neither sum nor list its files, so what they take of the target’s file storage is not known. Turn the copy of files off on Review, or run it again once the source answers.',
      ],
      [
        'files whose fit the target would not tell',
        { code: 'FILE_STORAGE_UNREAD' },
        'The run was refused before it wrote anything: the target org would not say what file storage it has left, so the files to copy could not be weighed against it. Turn the copy of files off on Review, or run it again once the org answers.',
      ],
    ])('alerts that it was refused for %s', (_what, stop, text) => {
      act(() => useForgeRunGateStore.getState().setStop(stop as ForgeRunGateStop));
      render(<ForgeRunGateNotice />);

      expect(screen.getByTestId('forge-run-gate-notice').getAttribute('role')).toBe('alert');
      expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(text);
    });

    /*
     * A sample of the whole org refused, said in the page's words — Review,
     * Simulate — where the host's English names the command line's flags.
     */
    it.each([
      [
        'a target that would not say its storage, nothing else bounding the sample',
        { code: 'SAMPLE_STORAGE_UNREAD' },
        'The run was refused before it wrote anything: the target org would not say what data storage it has left, and the sample has nothing else to be held to. Set the MB it may take on Review, or run it again once the org answers.',
      ],
      [
        'a sample that cannot fit',
        {
          code: 'SAMPLE_CANNOT_FIT',
          sample: { needMB: 7.5, budgetMB: 3.6, heaviest: ['Case', 'Pricebook2'] },
        },
        'The run was refused before it wrote anything: no sample fits. The objects copied whole and the first record drawn of each object alone take about 7.5 MB, past the 3.6 MB the sample may take; the heaviest: Case, Pricebook2. Leave objects out, or copy fewer whole, on Review, or let the sample take more.',
      ],
      [
        'a sample too large to hold',
        { code: 'SAMPLE_TOO_LARGE', sample: { rows: 1_000_001, most: 1_000_000 } },
        'The run was refused before it wrote anything: drawing the sample read 1,000,001 records, more than the 1,000,000 it holds at once. Let the sample take less, or leave objects out or read them through a filter on Review.',
      ],
      [
        'a plan of another org or setup',
        { code: 'SAMPLE_PLAN_MISMATCH', sample: { plan: 'otherSetup' } },
        'The run was refused before it wrote anything: the plan of the sample it was to copy was drawn of another org or for another setup, or has changed since. Simulate again to draw a new one.',
      ],
      [
        'a plan gone',
        { code: 'SAMPLE_PLAN_GONE', sample: { plan: 'gone' } },
        'The run was refused before it wrote anything: the plan of its sample is no longer on this machine, or no longer as it was drawn, so its records cannot be taken up. Run it again from Review to draw a new sample, or remove what it wrote from Results.',
      ],
      [
        'a target with less room than the sample was fitted to',
        {
          code: 'STORAGE_EXCEEDED',
          storage: { estimateMB: 3.5, remainingMB: 4 },
          sample: { fittedMB: 3.6, holdsMB: 2.8 },
        },
        'The run was refused before it wrote anything: the sample was fitted to 3.6 MB of the target org’s data storage, and what the target has left now holds 2.8 MB of a sample. Simulate again to draw a sample that fits.',
      ],
      // As the executor refuses them, with no figure: said without one.
      [
        'a sample that cannot fit, as the executor names its heaviest objects alone',
        { code: 'SAMPLE_CANNOT_FIT', sample: { heaviest: ['Case', 'Pricebook2'] } },
        'The run was refused before it wrote anything: no sample fits. The objects copied whole and the first record drawn of each object alone take more than the sample may take; the heaviest: Case, Pricebook2. Leave objects out, or copy fewer whole, on Review, or let the sample take more.',
      ],
      [
        'a sample too large to hold, said without its records',
        { code: 'SAMPLE_TOO_LARGE' },
        'The run was refused before it wrote anything: drawing the sample read more records than it holds at once. Let the sample take less, or leave objects out or read them through a filter on Review.',
      ],
      [
        'a run resumed as it was not set up',
        { code: 'SAMPLE_PLAN_MISMATCH' },
        'The run was refused before it wrote anything: the run it resumes was set up otherwise, a sample where this one copies every record, or every record where this one copies a sample. Resume it as it was set up.',
      ],
    ])('alerts that a sample was refused for %s', (_what, stop, text) => {
      act(() => useForgeRunGateStore.getState().setStop(stop as ForgeRunGateStop));
      render(<ForgeRunGateNotice />);

      expect(screen.getByTestId('forge-run-gate-notice').getAttribute('role')).toBe('alert');
      expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(text);
    });

    it('says a target with less room than the sample was fitted to in the panel’s language', async () => {
      act(() =>
        useForgeRunGateStore.getState().setStop({
          code: 'STORAGE_EXCEEDED',
          storage: { estimateMB: 3.5, remainingMB: 4 },
          sample: { fittedMB: 3.6, holdsMB: 2.8 },
        }),
      );
      i18n.addResourceBundle('fr', 'translation', fr, true, true);
      await act(() => i18n.changeLanguage('fr'));
      try {
        render(<ForgeRunGateNotice />);
        expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(
          "Le clonage a été refusé avant d'écrire quoi que ce soit : l'échantillon a été ajusté à 3,6 Mo du stockage de données de l'org cible, et ce qu'il lui reste maintenant en contient 2,8 Mo. Simulez de nouveau pour tirer un échantillon qui tient.",
        );
      } finally {
        await act(() => i18n.changeLanguage('en'));
      }
    });
  });

  describe('of a run its file copier refused, which clones no whole org', () => {
    // Told the page as a run that failed, its refusal was said in English with
    // no hint, on the execution screen; a clone of the whole org's words say
    // the source would not sum the org's files, which no other run asks.
    it('says the files of its records could not all be looked up, in the panel’s language', async () => {
      act(() => useForgeRunGateStore.getState().setStop({ code: 'FILES_UNREAD' }));
      i18n.addResourceBundle('fr', 'translation', fr, true, true);
      await act(() => i18n.changeLanguage('fr'));
      try {
        render(<ForgeRunGateNotice />);
        expect(screen.getByTestId('forge-run-gate-notice').getAttribute('role')).toBe('alert');
        expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(
          "Le clonage a été refusé avant d'écrire quoi que ce soit : les fichiers des enregistrements à cloner n'ont pas tous pu être recherchés dans la source, et les enregistrements seraient partis sans certains d'entre eux. Désactivez la copie des fichiers dans la revue, ou relancez-le quand la source répondra.",
        );
      } finally {
        await act(() => i18n.changeLanguage('en'));
      }
    });

    it('says what the files take and what the target has left, in the panel’s language', async () => {
      // Said as the file copier's English sentence on the execution screen,
      // with neither the panel's language nor its way of writing a number.
      act(() =>
        useForgeRunGateStore.getState().setStop({
          code: 'FILE_STORAGE_EXCEEDED',
          storage: { estimateMB: 12.5, remainingMB: 3, kind: 'files' },
        }),
      );
      i18n.addResourceBundle('fr', 'translation', fr, true, true);
      await act(() => i18n.changeLanguage('fr'));
      try {
        render(<ForgeRunGateNotice />);
        expect(screen.getByTestId('forge-run-gate-notice').getAttribute('role')).toBe('alert');
        expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(
          "Le clonage a été refusé avant d'écrire quoi que ce soit : les fichiers qu'il copie occupent environ 12,5 Mo de stockage de fichiers, et il reste 3 Mo à l'org cible. Excluez les fichiers dans la revue ou libérez du stockage de fichiers dans l'org cible.",
        );
      } finally {
        await act(() => i18n.changeLanguage('en'));
      }
    });

    it('says the target would not tell its file storage, as for a clone of the whole org', () => {
      act(() => useForgeRunGateStore.getState().setStop({ code: 'FILE_STORAGE_UNREAD' }));
      render(<ForgeRunGateNotice />);

      expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(
        'The run was refused before it wrote anything: the target org would not say what file storage it has left, so the files to copy could not be weighed against it. Turn the copy of files off on Review, or run it again once the org answers.',
      );
    });
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
