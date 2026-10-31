import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { BaseMessage, ForgeConfig, ForgeGraph, ForgeRehearsal } from '@sandforge/shared';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';

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

import { ForgeRehearseAction } from './ForgeRehearseAction';
import { useForgeStore } from '../../stores/useForgeStore';

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: '001000000000001AAA',
  depth: 'direct',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

const GRAPH: ForgeGraph = {
  nodes: [],
  edges: [],
  totalRecords: 0,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

const VERDICTS: ForgeRehearsal = {
  gaps: [],
  rows: 12,
  sampled: 4,
  judged: 4,
  passed: 3,
  notJudged: 1,
  notJudgedWhy: [{ objectApiName: 'Task', rows: 1, reason: 'parent_refused' }],
  updates: 0,
  updatesJudged: 0,
  updatesPassed: 0,
  updatesNotRehearsed: 0,
  calls: 2,
  plannedCalls: 1,
};

function requestId(): string {
  const sent = mockPostMessage.mock.calls
    .map((call) => (call[0] as { payload: BaseMessage }).payload)
    .filter((message) => message.type === 'forge:rehearse:request');
  return sent[sent.length - 1].id;
}

function fromExtension(type: string, payload: unknown): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${type}`,
          type,
          timestamp: Date.now(),
          correlationId: requestId(),
          payload,
        },
        origin: '',
      }),
    );
  });
}

describe('ForgeRehearseAction', () => {
  beforeEach(() => {
    mockPostMessage.mockReset();
    useForgeStore.getState().reset();
    useForgeStore.setState({ graph: GRAPH, config: CONFIG });
  });

  it('rehearses the run on a click, and waits for it with the button off', () => {
    render(<ForgeRehearseAction />);
    const button = screen.getByTestId('rehearse-button');
    expect(button?.textContent).toContain('Rehearse');
    fireEvent.click(button);
    expect(requestId()).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('forge-rehearse-status')?.textContent).toContain(
      'Rehearsal: reading the rows as the run would…',
    );
  });

  it('says each phase: the object read, the calls to confirm, the call under way', () => {
    render(<ForgeRehearseAction />);
    fireEvent.click(screen.getByTestId('rehearse-button'));
    const status = screen.getByTestId('forge-rehearse-status');
    fromExtension('forge:rehearse:progress', { phase: 'reading', objectApiName: 'Contact' });
    expect(status?.textContent).toContain(
      'Rehearsal: reading the rows as the run would (Contact)…',
    );
    fromExtension('forge:rehearse:progress', { phase: 'confirming', calls: 1 });
    expect(status?.textContent).toContain(
      'Rehearsal: confirm in VS Code the 1 composite call it costs.',
    );
    fromExtension('forge:rehearse:progress', { phase: 'rehearsing', call: 1, calls: 2 });
    expect(status?.textContent).toContain('Rehearsal: call 1 of 2, rolled back as it ends…');
  });

  it('says what the rehearsal found, and lets it run again', () => {
    render(<ForgeRehearseAction />);
    fireEvent.click(screen.getByTestId('rehearse-button'));
    fromExtension('forge:rehearse:response', { rehearsal: VERDICTS });
    expect(screen.getByTestId('forge-rehearse-status')?.textContent).toContain(
      'Rehearsal done, every write rolled back. Judged: 4; would save: 3; refused: 1; not judged: 1; composite calls: 2.',
    );
    expect((screen.getByTestId('rehearse-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('counts the rows linked to a record the target holds apart, never among the refused', () => {
    render(<ForgeRehearseAction />);
    fireEvent.click(screen.getByTestId('rehearse-button'));
    fromExtension('forge:rehearse:response', {
      rehearsal: { ...VERDICTS, judged: 4, passed: 3, linked: 1, notJudged: 0 },
    });
    expect(screen.getByTestId('forge-rehearse-status')?.textContent).toContain(
      'Judged: 4; would save: 3; refused: 0; not judged: 0; composite calls: 2. ' +
        'Linked to a record the target org already holds, as the run links them: 1.',
    );
  });

  it('says the updates the run makes after its inserts apart: judged, refused, and those not rehearsed', () => {
    render(<ForgeRehearseAction />);
    fireEvent.click(screen.getByTestId('rehearse-button'));
    fromExtension('forge:rehearse:response', {
      rehearsal: {
        ...VERDICTS,
        updates: 9,
        updatesJudged: 3,
        updatesPassed: 2,
        updatesNotRehearsed: 4,
      },
    });
    expect(screen.getByTestId('forge-rehearse-status')?.textContent).toContain(
      'Updates the run makes after its inserts: 3 judged, 2 would save, 1 refused; 4 of 9 not rehearsed.',
    );
  });

  it('says nothing of updates for a run that makes none', () => {
    render(<ForgeRehearseAction />);
    fireEvent.click(screen.getByTestId('rehearse-button'));
    fromExtension('forge:rehearse:response', { rehearsal: VERDICTS });
    expect(screen.getByTestId('forge-rehearse-status')?.textContent).not.toContain('Updates');
  });

  it('says a run that creates no row sent nothing', () => {
    render(<ForgeRehearseAction />);
    fireEvent.click(screen.getByTestId('rehearse-button'));
    fromExtension('forge:rehearse:response', { rehearsal: { ...VERDICTS, rows: 0 } });
    expect(screen.getByTestId('forge-rehearse-status')?.textContent).toContain(
      'Rehearsal done: the run creates no row, and nothing was sent.',
    );
  });

  it('says a declined rehearsal sent nothing, and a failed one why it failed', () => {
    render(<ForgeRehearseAction />);
    fireEvent.click(screen.getByTestId('rehearse-button'));
    fromExtension('forge:rehearse:error', {
      message: 'x',
      code: 'REHEARSAL_DECLINED',
      retryable: true,
    });
    expect(screen.getByTestId('forge-rehearse-status')?.textContent).toContain(
      'Rehearsal cancelled at its confirmation. Nothing was sent to the target.',
    );
    fireEvent.click(screen.getByTestId('rehearse-button'));
    fromExtension('forge:rehearse:error', {
      message: 'composite refused',
      code: 'REHEARSAL_ERROR',
      retryable: true,
    });
    expect(screen.getByTestId('forge-rehearse-status')?.textContent).toContain(
      'The rehearsal could not run: composite refused',
    );
  });

  it('is off without a run to rehearse', () => {
    useForgeStore.setState({ config: null });
    render(<ForgeRehearseAction />);
    expect((screen.getByTestId('rehearse-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('describes the button by what a rehearsal does and where it stands', () => {
    render(<ForgeRehearseAction />);
    const button = screen.getByTestId('rehearse-button');
    expect(button.getAttribute('aria-describedby')).toBe(
      'forge-rehearse-hint forge-rehearse-status',
    );
    expect(button.getAttribute('title')).toContain('Has the target judge a sample of the rows');
    expect(screen.getByRole('status')).toBe(screen.getByTestId('forge-rehearse-status'));
  });

  it('says under the button, in sight, that the target tries a sample and that it costs API calls', () => {
    // Beside Simulate, the same outlined button, its difference was in a
    // hover title and an sr-only line, though it creates rows in the target.
    render(<ForgeRehearseAction />);
    const caption = screen.getByTestId('forge-rehearse-caption');
    expect(caption.textContent).toBe('The target tries a sample, rolled back; costs API calls.');
    expect(caption.id).toBe('forge-rehearse-hint');
    expect(caption.className).not.toContain('sr-only');
  });
});

describe('ForgeRehearseAction in French and German', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it.each([
    ['fr', fr, 'Essai à blanc', /^Répéter$/],
    ['de', de, 'Probelauf', /^Proben$/],
  ] as const)(
    'names the button in %s as a dry run, not as a repeat or as samples',
    async (lng, catalogue, label, ambiguous) => {
      // Beside Simulate and Execute, "Répéter" read first as "Repeat", and
      // "Proben" as the plural noun "samples", which its own hint used.
      i18n.addResourceBundle(lng, 'translation', catalogue, true, true);
      await i18n.changeLanguage(lng);
      render(<ForgeRehearseAction />);
      const button = screen.getByTestId('rehearse-button');
      expect(button.textContent).toBe(label);
      expect(button.textContent).not.toMatch(ambiguous);
      expect(screen.getByTestId('forge-rehearse-caption').textContent).toBe(
        catalogue.forgeRun.rehearsal.caption,
      );
    },
  );
});
