import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import type { OrgCheckpoint } from '@sandforge/shared';
import { developerOrg, fakeHost, readyCheckpoint, scopeAnswer } from './testing/checkpointFixtures';

const host = vi.hoisted(() => ({
  current: null as null | import('./testing/checkpointFixtures').FakeHost,
}));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import { TakeCheckpoint } from './TakeCheckpoint';

/** The take of the Developer Edition org, with spies for what it tells its page. */
function renderTake() {
  const onClose = vi.fn();
  const onTaken = vi.fn();
  render(<TakeCheckpoint org={developerOrg()} onClose={onClose} onTaken={onTaken} />);
  return { onClose, onTaken };
}

/** Answer the scope of everything people work in. */
function answerScope(overrides: Parameters<typeof scopeAnswer>[0] = {}): void {
  act(() =>
    host.current?.answer('checkpoint:scope', 'checkpoint:scope:response', scopeAnswer(overrides)),
  );
}

/** The checkpoint a take keeps. */
function taken(overrides: Partial<OrgCheckpoint> = {}): OrgCheckpoint {
  return readyCheckpoint(overrides);
}

describe('TakeCheckpoint', () => {
  beforeEach(() => {
    host.current = fakeHost();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    // 2 PM on this machine's clock, whatever its zone: the default name is written in it.
    vi.setSystemTime(new Date(2026, 9, 22, 14, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the scope of everything people work in, and holds the button until it answers', () => {
    renderTake();
    expect(host.current?.lastPayload('checkpoint:scope')).toEqual({
      orgId: 'org-dev',
      mode: 'everything',
    });
    expect(screen.getByTestId('checkpoint-scope-reading').textContent).toBe(
      'Reading what DEV-SB holds…',
    );
    expect(screen.getByTestId('checkpoint-take-start')).toBeDisabled();
    // Nothing is taken before it is asked for.
    expect(host.current?.sent('checkpoint:take')).toEqual([]);
  });

  it('names the take after the date and time, or after a chip, and the baseline chip keeps it', () => {
    renderTake();
    const field = screen.getByTestId('checkpoint-take-name');
    expect(field).toHaveValue('Oct 22, 2026, 2:00 PM');
    fireEvent.click(screen.getByTestId('checkpoint-chip-before-uat'));
    expect(field).toHaveValue('Before UAT');
    expect(screen.getByTestId('checkpoint-take-keep')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('checkpoint-chip-clean-baseline'));
    expect(field).toHaveValue('Clean baseline');
    expect(screen.getByTestId('checkpoint-take-keep')).toBeChecked();
  });

  it('says what everything people work in holds: objects with records, empty ones, a package’s', () => {
    renderTake();
    answerScope();
    expect(screen.getByTestId('checkpoint-scope-summary').textContent).toBe(
      '5 objects · about 2,424 records',
    );
    const facts = screen.getByTestId('checkpoint-scope-facts');
    expect(
      within(facts)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      '3 hold records',
      '2 are empty: what is created there later is caught too',
      '1 belongs to the vlocity_cmt package',
    ]);
    // The objects holding the most records come first.
    const rows = within(screen.getByTestId('checkpoint-object-list')).getAllByRole('listitem');
    expect(rows[0].textContent).toBe('Contact2,012 records');
    expect(
      screen.getByText(
        'Left out: users, permissions, setup, custom settings, Chatter, history and log objects, files.',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('checkpoint-left-out')).getByText(/Chatter posts are left out\./),
    ).toBeInTheDocument();
  });

  it('says before it runs what the take costs, holds and cannot keep', () => {
    renderTake();
    answerScope();
    expect(screen.getByTestId('checkpoint-cost').textContent).toBe(
      'About 1min · about 250 API requests of the 14,997 left today · about 2.3 MB on this machine, kept until Nov 21, 2026',
    );
    const card = screen.getByTestId('checkpoint-before-it-runs');
    expect(
      within(card).getByText("It holds the records' values unencrypted, readable by you alone."),
    ).toBeInTheDocument();
    expect(
      within(card).getByText('Ask people to stop working in DEV-SB while it is taken.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('checkpoint-with-parent').textContent).toBe(
      'Deleted records of OpportunityLineItem come back only with their parent record.',
    );
    expect(screen.getByTestId('checkpoint-encrypted').textContent).toBe(
      'Contact.SSN__c is encrypted and admin@example.com cannot view encrypted data: the checkpoint cannot hold its values, so Rewind will not touch it.',
    );
    expect(screen.getByTestId('checkpoint-hidden').textContent).toBe(
      '2 fields are hidden from admin@example.com by field-level security: Rewind will not put them back.',
    );
    expect(screen.getByTestId('checkpoint-take-start')).toBeEnabled();
  });

  it('says a checkpoint kept until it is deleted is kept so', () => {
    renderTake();
    answerScope();
    fireEvent.click(screen.getByTestId('checkpoint-take-keep'));
    expect(screen.getByTestId('checkpoint-cost').textContent).toContain('kept until you delete it');
  });

  it('says the refusal the take would meet, and offers no take', () => {
    renderTake();
    answerScope({
      refusal: {
        code: 'API_BUDGET',
        message: 'This take takes about 250 API requests; DEV-SB has 120 left today.',
      },
    });
    expect(screen.getByTestId('checkpoint-refusal').textContent).toBe(
      'This take takes about 250 API requests; DEV-SB has 120 left today.',
    );
    expect(screen.getByTestId('checkpoint-take-start')).toBeDisabled();
  });

  it('says the refusal alone of a take refused before its scope is read, and no cost of it', () => {
    // As a Standard User, the page said "about 0 API requests of the 0 left
    // today" and "0 objects · about 0 records" with the refusal, an estimate
    // of nothing read as a take that would cost nothing.
    renderTake();
    answerScope({
      objects: [],
      leftOut: [],
      estimate: { records: 0, apiRequests: 0, apiRequestsLeft: 0, seconds: 0, bytes: 0 },
      refusal: {
        code: 'PERMISSIONS',
        message: 'A checkpoint needs a user with View All Data and Modify All Data.',
      },
    });

    const card = screen.getByTestId('checkpoint-before-it-runs');
    expect(within(card).getByRole('alert')).toHaveTextContent(
      'A checkpoint needs a user with View All Data and Modify All Data.',
    );
    expect(screen.queryByTestId('checkpoint-cost')).not.toBeInTheDocument();
    expect(card.textContent).not.toMatch(/API requests|unencrypted|Ask people/);
    expect(screen.queryByTestId('checkpoint-scope-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('checkpoint-see-objects')).not.toBeInTheDocument();
    expect(screen.getByTestId('checkpoint-take-start')).toBeDisabled();
  });

  it('says a scope that failed, and asks it again on Retry', () => {
    renderTake();
    act(() =>
      host.current?.fail('checkpoint:scope', {
        message: 'The org did not answer.',
        code: 'NETWORK',
      }),
    );
    expect(screen.getByTestId('checkpoint-scope-error')).toHaveTextContent(
      'The org did not answer.',
    );
    expect(screen.getByTestId('checkpoint-take-start')).toBeDisabled();
    fireEvent.click(screen.getByTestId('checkpoint-scope-retry'));
    expect(host.current?.sent('checkpoint:scope')).toHaveLength(2);
  });

  it('says the scope of everything failed when there is nothing to pick from', () => {
    renderTake();
    act(() =>
      host.current?.fail('checkpoint:scope', {
        message: 'The org did not answer.',
        code: 'NETWORK',
      }),
    );
    fireEvent.click(screen.getByTestId('checkpoint-scope-picked'));
    expect(screen.getByTestId('checkpoint-scope-error')).toHaveTextContent(
      'The org did not answer.',
    );
    fireEvent.click(screen.getByTestId('checkpoint-scope-retry'));
    expect(host.current?.lastPayload('checkpoint:scope')).toEqual({
      orgId: 'org-dev',
      mode: 'everything',
    });
  });

  it('takes everything people work in for 30 days under the name typed', () => {
    renderTake();
    answerScope();
    fireEvent.change(screen.getByTestId('checkpoint-take-name'), {
      target: { value: '  Before UAT ' },
    });
    fireEvent.click(screen.getByTestId('checkpoint-take-start'));
    expect(host.current?.lastPayload('checkpoint:take')).toEqual({
      orgId: 'org-dev',
      name: 'Before UAT',
      mode: 'everything',
      keepDays: 30,
    });
  });

  it('takes a baseline kept until it is deleted', () => {
    renderTake();
    answerScope();
    fireEvent.click(screen.getByTestId('checkpoint-chip-clean-baseline'));
    fireEvent.click(screen.getByTestId('checkpoint-take-start'));
    expect(host.current?.lastPayload('checkpoint:take')).toMatchObject({
      name: 'Clean baseline',
      keepDays: 0,
    });
  });

  it('refuses a blank name before anything is sent', () => {
    renderTake();
    answerScope();
    fireEvent.change(screen.getByTestId('checkpoint-take-name'), { target: { value: '  ' } });
    expect(screen.getByTestId('checkpoint-take-start')).toBeDisabled();
    expect(
      screen.getByText('A name is one line of text, of 120 characters at most.'),
    ).toBeInTheDocument();
  });

  it('asks the scope of the objects picked once the picks settle, and takes only those', () => {
    renderTake();
    answerScope();
    fireEvent.click(screen.getByTestId('checkpoint-scope-picked'));
    expect(screen.getByTestId('checkpoint-picked').textContent).toBe(
      'Pick the objects the checkpoint keeps.',
    );
    expect(screen.getByTestId('checkpoint-take-start')).toBeDisabled();

    fireEvent.click(screen.getByTestId('checkpoint-pick-Account'));
    fireEvent.click(screen.getByTestId('checkpoint-pick-Contact'));
    expect(screen.getByTestId('checkpoint-picked').textContent).toBe('2 objects picked');
    // Each click does not ask the org: the picks are asked for once they rest.
    expect(host.current?.sent('checkpoint:scope')).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(host.current?.lastPayload('checkpoint:scope')).toEqual({
      orgId: 'org-dev',
      mode: 'picked',
      objects: ['Account', 'Contact'],
    });
    expect(screen.getByTestId('checkpoint-take-start')).toBeDisabled();
    act(() =>
      host.current?.answer('checkpoint:scope', 'checkpoint:scope:response', {
        ...scopeAnswer({ mode: 'picked' }),
        objects: scopeAnswer().objects.slice(0, 2),
        estimate: {
          records: 2412,
          apiRequests: 40,
          apiRequestsLeft: 14_997,
          seconds: 20,
          bytes: 2_000_000,
        },
      }),
    );
    expect(screen.getByTestId('checkpoint-cost').textContent).toMatch(
      /^About 20s · about 40 API requests/,
    );
    fireEvent.click(screen.getByTestId('checkpoint-take-start'));
    expect(host.current?.lastPayload('checkpoint:take')).toMatchObject({
      mode: 'picked',
      objects: ['Account', 'Contact'],
    });
  });

  it('holds the take while a pick has not been estimated', () => {
    renderTake();
    answerScope();
    fireEvent.click(screen.getByTestId('checkpoint-scope-picked'));
    fireEvent.click(screen.getByTestId('checkpoint-pick-Account'));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    act(() =>
      host.current?.answer(
        'checkpoint:scope',
        'checkpoint:scope:response',
        scopeAnswer({ mode: 'picked' }),
      ),
    );
    expect(screen.getByTestId('checkpoint-take-start')).toBeEnabled();
    // Another pick: the estimate on screen is the last pick's, not this one's.
    fireEvent.click(screen.getByTestId('checkpoint-pick-Contact'));
    expect(screen.getByTestId('checkpoint-take-start')).toBeDisabled();
  });

  it('shows the take’s progress by its own request, and stops it on Stop', () => {
    renderTake();
    answerScope();
    fireEvent.click(screen.getByTestId('checkpoint-take-start'));
    const requestId = host.current?.sent('checkpoint:take')[0].id;
    expect(screen.getByTestId('checkpoint-take-step').textContent).toBe('Starting…');

    act(() =>
      host.current?.push('operation:progress', {
        operationId: 'another-run',
        percentage: 90,
        processedRecords: 900,
        totalRecords: 1000,
        currentStep: 'Another run',
      }),
    );
    expect(screen.getByTestId('checkpoint-take-step').textContent).toBe('Starting…');
    act(() =>
      host.current?.push('operation:progress', {
        operationId: requestId,
        percentage: 50,
        processedRecords: 1200,
        totalRecords: 2400,
        currentStep: 'Reading Contact (5 of 38)',
      }),
    );
    expect(screen.getByTestId('checkpoint-take-step').textContent).toBe(
      'Reading Contact (5 of 38) — 1,200 / 2,400',
    );

    fireEvent.click(screen.getByTestId('checkpoint-take-stop'));
    expect(host.current?.lastPayload('execution:abort')).toEqual({ operationId: requestId });
    expect(screen.getByText('Stopping: a stopped take is not kept.')).toBeInTheDocument();
  });

  it('says a stopped take kept nothing, and offers the take again', () => {
    renderTake();
    answerScope();
    fireEvent.click(screen.getByTestId('checkpoint-take-start'));
    act(() =>
      host.current?.fail('checkpoint:take', {
        message: 'The take was stopped.',
        code: 'CANCELLED',
      }),
    );
    expect(screen.getByTestId('checkpoint-take-stopped').textContent).toBe(
      'Stopped: nothing was kept.',
    );
    expect(screen.getByTestId('checkpoint-take-start')).toBeEnabled();
  });

  it('says a refused take in the extension’s words', () => {
    renderTake();
    answerScope();
    fireEvent.click(screen.getByTestId('checkpoint-take-start'));
    act(() =>
      host.current?.fail('checkpoint:take', {
        message: 'A SandForge run is writing to DEV-SB: take the checkpoint once it has ended.',
        code: 'RUN_WRITING',
      }),
    );
    expect(screen.getByTestId('checkpoint-take-error')).toHaveTextContent(
      'A SandForge run is writing to DEV-SB: take the checkpoint once it has ended.',
    );
    expect(screen.queryByTestId('checkpoint-take-stopped')).toBeNull();
  });

  it('says what it kept, has the list read again, and closes on Done', () => {
    const { onClose, onTaken } = renderTake();
    answerScope();
    fireEvent.click(screen.getByTestId('checkpoint-take-start'));
    act(() =>
      host.current?.answer('checkpoint:take', 'checkpoint:take:response', {
        checkpoint: taken(),
        operationId: host.current?.sent('checkpoint:take')[0].id,
      }),
    );
    expect(screen.getByTestId('checkpoint-taken').textContent).toBe(
      '“Before UAT” taken — 2,412 records in 2 objects, 2.3 MB',
    );
    expect(screen.queryByTestId('checkpoint-moved')).toBeNull();
    expect(onTaken).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('checkpoint-take-done'));
    expect(onClose).toHaveBeenCalled();
  });

  it('warns of the records that moved while it was taken', () => {
    renderTake();
    answerScope();
    fireEvent.click(screen.getByTestId('checkpoint-take-start'));
    act(() =>
      host.current?.answer('checkpoint:take', 'checkpoint:take:response', {
        checkpoint: taken({ movedWhileTaken: { changed: 1, deleted: 1, created: 1 } }),
        operationId: 'op',
      }),
    );
    expect(screen.getByTestId('checkpoint-moved').textContent).toBe(
      '3 records changed while it was being taken; a rewind treats them as changed since.',
    );
  });

  it('leaves on Cancel before anything is taken', () => {
    const { onClose } = renderTake();
    fireEvent.click(screen.getByTestId('checkpoint-take-cancel'));
    expect(onClose).toHaveBeenCalled();
    expect(host.current?.sent('checkpoint:take')).toEqual([]);
  });
});
