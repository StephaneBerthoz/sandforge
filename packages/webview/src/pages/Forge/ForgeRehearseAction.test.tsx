import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { BaseMessage, ForgeConfig, ForgeGraph, ForgeRehearsal } from '@sandforge/shared';
import '../../i18n';

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
    expect(document.getElementById('forge-rehearse-hint')?.textContent).toContain(
      'Has the target judge a sample of the rows',
    );
    expect(screen.getByRole('status')).toBe(screen.getByTestId('forge-rehearse-status'));
  });
});
