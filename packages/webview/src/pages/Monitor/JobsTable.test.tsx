import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createInstance, type i18n as I18n } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import '../../i18n';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import { JobsTable } from './JobsTable';
import type { JobDisplayInfo } from './MonitorPage';

function createJob(overrides: Partial<JobDisplayInfo> = {}): JobDisplayInfo {
  return {
    id: `j-${Math.random().toString(36).slice(2, 8)}`,
    jobType: 'BatchApex',
    status: 'Completed',
    objectType: 'Account',
    createdBy: 'Admin',
    createdDate: '2026-02-24T10:00:00Z',
    totalRecords: 100,
    processedRecords: 100,
    failedRecords: 0,
    ...overrides,
  };
}

describe('JobsTable', () => {
  it('should render empty state when no jobs', () => {
    render(<JobsTable jobs={[]} />);
    expect(screen.getByText(/No recent jobs/i)).toBeDefined();
  });

  it('should render filter buttons', () => {
    render(<JobsTable jobs={[createJob()]} />);
    expect(screen.getByTestId('job-filters')).toBeDefined();
    expect(screen.getByTestId('filter-all')).toBeDefined();
    expect(screen.getByTestId('filter-running')).toBeDefined();
    expect(screen.getByTestId('filter-failed')).toBeDefined();
    expect(screen.getByTestId('filter-completed')).toBeDefined();
  });

  it('should group jobs by type', () => {
    const jobs = [
      createJob({ jobType: 'BatchApex' }),
      createJob({ jobType: 'BatchApex' }),
      createJob({ jobType: 'Future' }),
    ];
    render(<JobsTable jobs={jobs} />);
    expect(screen.getByTestId('job-group-BatchApex')).toBeDefined();
    expect(screen.getByTestId('job-group-Future')).toBeDefined();
  });

  it('should show run count and success rate per group', () => {
    const jobs = [
      createJob({ jobType: 'BatchApex', status: 'Completed' }),
      createJob({ jobType: 'BatchApex', status: 'Failed' }),
    ];
    render(<JobsTable jobs={jobs} />);
    expect(screen.getByText('2 runs')).toBeDefined();
    expect(screen.getByText('50% success')).toBeDefined();
    expect(screen.getByText('1 failed')).toBeDefined();
  });

  it('should expand/collapse groups on click', () => {
    const jobs = [createJob({ id: 'j1', jobType: 'BatchApex' })];
    render(<JobsTable jobs={jobs} />);

    // Initially collapsed
    expect(screen.queryByTestId('group-jobs-BatchApex')).toBeNull();

    // Expand
    fireEvent.click(screen.getByTestId('group-toggle-BatchApex'));
    expect(screen.getByTestId('group-jobs-BatchApex')).toBeDefined();
    expect(screen.getByTestId('job-row-j1')).toBeDefined();

    // Collapse
    fireEvent.click(screen.getByTestId('group-toggle-BatchApex'));
    expect(screen.queryByTestId('group-jobs-BatchApex')).toBeNull();
  });

  it('should filter by running status', () => {
    const jobs = [
      createJob({ id: 'j-run', jobType: 'BatchApex', status: 'Processing' }),
      createJob({ id: 'j-done', jobType: 'BatchApex', status: 'Completed' }),
    ];
    render(<JobsTable jobs={jobs} />);

    fireEvent.click(screen.getByTestId('filter-running'));
    // After filtering, only 1 job should appear — expand and verify the Processing row
    fireEvent.click(screen.getByTestId('group-toggle-BatchApex'));
    expect(screen.getByTestId('job-row-j-run')).toBeDefined();
    expect(screen.queryByTestId('job-row-j-done')).toBeNull();
  });

  it('should filter by failed status', () => {
    const jobs = [
      createJob({ id: 'j-fail', jobType: 'BatchApex', status: 'Failed' }),
      createJob({ id: 'j-ok', jobType: 'BatchApex', status: 'Completed' }),
    ];
    render(<JobsTable jobs={jobs} />);

    fireEvent.click(screen.getByTestId('filter-failed'));
    fireEvent.click(screen.getByTestId('group-toggle-BatchApex'));
    expect(screen.getByTestId('job-row-j-fail')).toBeDefined();
    expect(screen.queryByTestId('job-row-j-ok')).toBeNull();
  });

  it('should show job details in expanded row', () => {
    const jobs = [
      createJob({
        id: 'j1',
        jobType: 'BatchApex',
        status: 'Completed',
        objectType: 'Account',
        totalRecords: 500,
        processedRecords: 500,
        createdBy: 'John',
      }),
    ];
    render(<JobsTable jobs={jobs} />);
    fireEvent.click(screen.getByTestId('group-toggle-BatchApex'));

    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('John')).toBeDefined();
    expect(screen.getByText(/500/)).toBeDefined();
  });

  it('should show error count on failed jobs', () => {
    const jobs = [
      createJob({
        id: 'j1',
        jobType: 'BatchApex',
        status: 'Failed',
        failedRecords: 42,
        totalRecords: 100,
        processedRecords: 58,
      }),
    ];
    render(<JobsTable jobs={jobs} />);
    fireEvent.click(screen.getByTestId('group-toggle-BatchApex'));

    expect(screen.getByText(/42 err/)).toBeDefined();
  });

  it('should show active count in header', () => {
    const jobs = [
      createJob({ status: 'Processing' }),
      createJob({ status: 'Queued' }),
      createJob({ status: 'Completed' }),
    ];
    render(<JobsTable jobs={jobs} />);
    expect(screen.getByText('2 active')).toBeDefined();
  });

  it('should show how many jobs each filter keeps', () => {
    const jobs = [
      createJob({ status: 'Failed' }),
      createJob({ status: 'Failed' }),
      createJob({ status: 'Processing' }),
      createJob({ status: 'Completed' }),
      createJob({ status: 'Completed' }),
      createJob({ status: 'Completed' }),
    ];
    render(<JobsTable jobs={jobs} />);

    expect(screen.getByTestId('filter-count-all').textContent).toBe('6');
    expect(screen.getByTestId('filter-count-running').textContent).toBe('1');
    expect(screen.getByTestId('filter-count-failed').textContent).toBe('2');
    expect(screen.getByTestId('filter-count-completed').textContent).toBe('3');
  });

  it('should keep the filter counts on the full job list, not on the filtered one', () => {
    const jobs = [createJob({ status: 'Failed' }), createJob({ status: 'Completed' })];
    render(<JobsTable jobs={jobs} />);

    fireEvent.click(screen.getByTestId('filter-running'));

    // The list is empty under this filter; the counters must still say why.
    expect(screen.getByTestId('filter-count-running').textContent).toBe('0');
    expect(screen.getByTestId('filter-count-failed').textContent).toBe('1');
    expect(screen.getByTestId('filter-count-all').textContent).toBe('2');
  });

  it('should list groups carrying failures before healthy ones', () => {
    const jobs = [
      createJob({ id: 'a1', jobType: 'AlphaBatch', status: 'Completed' }),
      createJob({ id: 'a2', jobType: 'AlphaBatch', status: 'Completed' }),
      createJob({ id: 'z1', jobType: 'ZuluBatch', status: 'Failed' }),
    ];
    render(<JobsTable jobs={jobs} />);

    const order = Array.from(screen.getByTestId('job-groups').children).map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(order).toEqual(['job-group-ZuluBatch', 'job-group-AlphaBatch']);
  });

  it('should reverse the rows and flip aria-sort when the created column is toggled', () => {
    const jobs = [
      createJob({ id: 'older', jobType: 'BatchApex', createdDate: '2026-02-20T10:00:00Z' }),
      createJob({ id: 'newer', jobType: 'BatchApex', createdDate: '2026-02-24T10:00:00Z' }),
    ];
    render(<JobsTable jobs={jobs} />);
    fireEvent.click(screen.getByTestId('group-toggle-BatchApex'));

    const rowIds = (): Array<string | null> =>
      Array.from(
        screen.getByTestId('group-jobs-BatchApex').querySelectorAll('[data-testid^="job-row-"]'),
      ).map((el) => el.getAttribute('data-testid'));

    expect(rowIds()).toEqual(['job-row-newer', 'job-row-older']);
    expect(screen.getByTestId('jobs-created-header-BatchApex').getAttribute('aria-sort')).toBe(
      'descending',
    );

    fireEvent.click(screen.getByTestId('jobs-created-sort-BatchApex'));

    expect(rowIds()).toEqual(['job-row-older', 'job-row-newer']);
    expect(screen.getByTestId('jobs-created-header-BatchApex').getAttribute('aria-sort')).toBe(
      'ascending',
    );
  });

  it('should give every cell of a job row a named column header, with the sorted Created header over the date', () => {
    render(<JobsTable jobs={[createJob({ id: 'j1', jobType: 'BatchApex' })]} />);
    fireEvent.click(screen.getByTestId('group-toggle-BatchApex'));

    const table = screen.getByTestId('group-jobs-BatchApex');
    const headers = Array.from(table.querySelectorAll('[role="columnheader"]'));
    const cells = Array.from(screen.getByTestId('job-row-j1').querySelectorAll('[role="cell"]'));

    expect(headers).toHaveLength(cells.length);
    for (const header of headers) {
      expect(header.textContent?.trim()).not.toBe('');
    }
    expect(headers[headers.length - 1]).toBe(screen.getByTestId('jobs-created-header-BatchApex'));
    expect(cells[cells.length - 1]).toBe(screen.getByTestId('job-created-j1'));
    expect(headers.filter((h) => h.hasAttribute('aria-sort'))).toHaveLength(1);
  });

  it('should show placeholder rows carrying aria-busy instead of the empty state while loading', () => {
    render(<JobsTable jobs={[]} isLoading />);

    const placeholder = screen.getByTestId('jobs-loading');
    expect(placeholder.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(/No recent jobs/i)).toBeNull();
  });

  it('should keep the empty state during a re-read when the jobs exist but the filter hides them all', () => {
    const jobs = [createJob({ status: 'Completed' })];
    const { rerender } = render(<JobsTable jobs={jobs} />);
    fireEvent.click(screen.getByTestId('filter-failed'));

    rerender(<JobsTable jobs={jobs} isLoading />);

    expect(screen.queryByTestId('jobs-loading')).toBeNull();
    expect(screen.getByText(/No recent jobs/i)).toBeDefined();
  });
});

describe('JobsTable — job times', () => {
  let instance: I18n;

  beforeAll(async () => {
    instance = createInstance();
    await instance.use(initReactI18next).init({
      resources: { en: { translation: en }, fr: { translation: fr } },
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });
  });

  function renderIn(lng: string, createdDate: string): void {
    instance.changeLanguage(lng);
    render(
      <I18nextProvider i18n={instance}>
        <JobsTable jobs={[createJob({ id: 'j1', jobType: 'BatchApex', createdDate })]} />
      </I18nextProvider>,
    );
    fireEvent.click(screen.getByTestId('group-toggle-BatchApex'));
  }

  it('should render the elapsed time in English and keep the exact date as a tooltip', () => {
    const createdDate = new Date(Date.now() - 5 * 60_000).toISOString();
    renderIn('en', createdDate);

    const cell = screen.getByTestId('job-created-j1');
    expect(cell.textContent).toBe('5m ago');
    expect(cell.getAttribute('title')).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(
        new Date(createdDate),
      ),
    );
  });

  it('should render the exact date once a job is more than a day old, where hours stop reading well', () => {
    const createdDate = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    renderIn('en', createdDate);

    const exact = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(createdDate));
    const cell = screen.getByTestId('job-created-j1');
    expect(cell.textContent).toBe(exact);
    expect(cell.getAttribute('title')).toBe(exact);
  });

  it('should still render the elapsed time for a job created a few hours ago', () => {
    renderIn('en', new Date(Date.now() - 3 * 3_600_000 - 60_000).toISOString());

    expect(screen.getByTestId('job-created-j1').textContent).toBe('3h ago');
  });

  it('should render the elapsed time in French when the interface is French', () => {
    renderIn('fr', new Date(Date.now() - 5 * 60_000).toISOString());

    expect(screen.getByTestId('job-created-j1').textContent).toBe('il y a 5min');
  });

  it('says a creation date that is not a date is unknown, in the interface language', () => {
    // Formatting it threw "Invalid time value", and the jobs table did not render.
    renderIn('fr', 'not a date');

    const cell = screen.getByTestId('job-created-j1');
    expect(cell.textContent).toBe('inconnue');
    expect(cell.getAttribute('title')).toBe('inconnue');
  });
});
