import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalGate } from './ApprovalGate';
import type { ApprovalQuestion, ApprovalRequest } from './ApprovalGate';

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  operationId: 'op-1',
  stepId: 'step-approve',
  stepName: 'Before the sync',
  pipelineName: 'Nightly',
  timeoutMs: 60_000,
  ...over,
});

/** A notification whose button the test presses. */
function notification(): {
  ask: (question: ApprovalQuestion) => Promise<'approve' | 'reject' | undefined>;
  press: (choice: 'approve' | 'reject' | undefined) => void;
  shown: ApprovalQuestion[];
} {
  const shown: ApprovalQuestion[] = [];
  let press: (choice: 'approve' | 'reject' | undefined) => void = () => undefined;
  return {
    shown,
    ask: (question) => {
      shown.push(question);
      return new Promise((resolve) => {
        press = resolve;
      });
    },
    press: (choice) => press(choice),
  };
}

describe('ApprovalGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T08:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes Approve on the notification as the answer, with who and when', async () => {
    const shown = notification();
    const gate = new ApprovalGate({ ask: shown.ask, who: () => 'sha256:0123456789ab' });

    const answer = gate.ask(request());
    expect(shown.shown[0].expiresAt).toBe('2026-10-13T08:01:00.000Z');
    vi.setSystemTime(new Date('2026-10-13T08:00:20.000Z'));
    shown.press('approve');

    await expect(answer).resolves.toEqual({
      decision: 'approved',
      via: 'notification',
      at: '2026-10-13T08:00:20.000Z',
      by: 'sha256:0123456789ab',
    });
    expect(gate.isWaiting('op-1', 'step-approve')).toBe(false);
  });

  it('takes Reject on the page as the answer, and tells the page the step waits', async () => {
    const announce = vi.fn();
    const gate = new ApprovalGate({ ask: notification().ask, announce });

    const answer = gate.ask(request({ message: 'Look at the comparison first.' }));
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: 'step-approve',
        message: 'Look at the comparison first.',
        expiresAt: '2026-10-13T08:01:00.000Z',
      }),
    );
    expect(gate.answer('op-1', 'step-approve', 'rejected', 'page')).toBe(true);

    await expect(answer).resolves.toMatchObject({ decision: 'rejected', via: 'page' });
  });

  it('gives up when nobody answers within the wait, and says nobody answered', async () => {
    const gate = new ApprovalGate({ ask: notification().ask });

    const answer = gate.ask(request({ timeoutMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(answer).resolves.toEqual({
      decision: 'timedOut',
      at: '2026-10-13T08:00:05.000Z',
    });
  });

  it('gives up as cancelled when the run is cancelled while it waits', async () => {
    const gate = new ApprovalGate({ ask: notification().ask });
    const run = new AbortController();

    const answer = gate.ask(request(), run.signal);
    run.abort();

    await expect(answer).resolves.toMatchObject({ decision: 'cancelled' });
    expect(gate.answer('op-1', 'step-approve', 'approved', 'page')).toBe(false);
  });

  it('keeps the first answer, and tells a later press on the notification it came too late', async () => {
    const shown = notification();
    const tooLate = vi.fn();
    const gate = new ApprovalGate({ ask: shown.ask, tooLate });

    const answer = gate.ask(request());
    gate.answer('op-1', 'step-approve', 'rejected', 'page');
    shown.press('approve');
    await vi.runAllTimersAsync();

    await expect(answer).resolves.toMatchObject({ decision: 'rejected', via: 'page' });
    expect(tooLate).toHaveBeenCalledTimes(1);
  });

  it('goes on waiting when the notification is closed without an answer', async () => {
    const shown = notification();
    const gate = new ApprovalGate({ ask: shown.ask });

    const answer = gate.ask(request());
    shown.press(undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gate.isWaiting('op-1', 'step-approve')).toBe(true);
    gate.answer('op-1', 'step-approve', 'approved', 'page');

    await expect(answer).resolves.toMatchObject({ decision: 'approved', via: 'page' });
  });

  it('says it can ask no one where there is no window to show the question in', () => {
    expect(new ApprovalGate({}).canAsk).toBe(false);
    expect(new ApprovalGate({ ask: notification().ask }).canAsk).toBe(true);
  });
});
