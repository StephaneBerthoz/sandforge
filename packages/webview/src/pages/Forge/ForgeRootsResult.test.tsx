import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ForgeReadRecords, ForgeRunRoots } from '@sandforge/shared';
import i18n from '../../i18n';
import { ForgeRootsResult } from './ForgeRootsResult';

const ROOTS: ForgeRunRoots = {
  objectApiName: 'Account',
  from: 'query',
  query: { where: "Industry = 'Energy'" },
  cap: 200,
  asked: 37,
  read: 37,
  gone: [],
  written: 37,
  linked: 0,
  failed: [],
  sha256: 'a'.repeat(64),
  readAt: 'not a date',
};

const READ: ForgeReadRecords[] = [
  { objectApiName: 'Account', read: 41, origin: { roots: 37, under: 0, named: 4 } },
  {
    objectApiName: 'Case',
    read: 120,
    origin: { roots: 0, under: 120, named: 0 },
    readUnder: ['Account', 'Contact'],
  },
  // Read by a run that kept no origin of it: nothing said of it here.
  { objectApiName: 'Task', read: 3 },
];

describe('ForgeRootsResult', () => {
  it('says the records the query chose, how many of them were written, and what reading what they reach sent the source', () => {
    render(
      <ForgeRootsResult
        roots={ROOTS}
        reads={{ source: 84 }}
        readByObject={READ}
        simulated={false}
        source="SRC"
      />,
    );

    expect(screen.getByTestId('forge-roots-result-chosen').textContent).toBe(
      i18n.t('forgeRun.rootsResult.fromQuery', {
        count: 37,
        formatted: '37',
        object: 'Account',
        cap: '200',
        at: 'not a date',
      }),
    );
    expect(screen.getByTestId('forge-roots-result-written').textContent).toBe(
      i18n.t('forgeRun.rootsResult.written', { written: '37', read: '37' }),
    );
    expect(screen.getByTestId('forge-roots-result-reads').textContent).toBe(
      i18n.t('forgeRun.rootsResult.reads', { count: 84, formatted: '84', source: 'SRC' }),
    );
    expect(screen.queryByTestId('forge-roots-result-failed')).toBeNull();
    expect(screen.queryByTestId('forge-roots-result-gone')).toBeNull();
  });

  it('says per object how its records came in, and the objects a parent read by id brought them under', () => {
    render(<ForgeRootsResult roots={ROOTS} readByObject={READ} simulated={false} source="SRC" />);

    const lines = [...screen.getByTestId('forge-roots-result-objects').querySelectorAll('li')].map(
      (li) => li.textContent,
    );
    expect(lines).toEqual([
      'Account: 41 read, 37 chosen by the query, 4 named by the clone’s records.',
      'Case: 120 read, 120 under the clone’s records. Read under Account, Contact: a parent read by id brings its other children, as the clone of one record does.',
    ]);
  });

  it('says the roots refused with their reason, the roots gone from the source apart, and those linked', () => {
    render(
      <ForgeRootsResult
        roots={{
          ...ROOTS,
          asked: 40,
          read: 38,
          written: 35,
          linked: 1,
          gone: ['001S00000000039AAA', '001S00000000040AAA'],
          failed: [{ id: '001S00000000038AAA', reason: 'REQUIRED_FIELD_MISSING' }],
        }}
        simulated={false}
        source="SRC"
      />,
    );

    expect(screen.getByTestId('forge-roots-result-written').className).toContain('status-warning');
    expect(screen.getByTestId('forge-roots-result-written').textContent).toContain(
      i18n.t('forgeRun.rootsResult.linked', { count: 1, formatted: '1' }),
    );
    expect(screen.getByTestId('forge-roots-result-gone').textContent).toBe(
      i18n.t('forgeRun.rootsResult.gone', { count: 2, formatted: '2', source: 'SRC' }),
    );
    expect(screen.getByTestId('forge-roots-result-failed').textContent).toContain(
      '001S00000000038AAA: REQUIRED_FIELD_MISSING',
    );
  });

  it('says a simulation would write them, and that it wrote nothing', () => {
    render(<ForgeRootsResult roots={ROOTS} simulated source="SRC" />);

    expect(screen.getByTestId('forge-roots-result-written').textContent).toBe(
      i18n.t('forgeRun.rootsResult.wouldWrite', { written: '37', read: '37' }),
    );
  });

  it('says the run wrote the roots its simulation chose, and read the query again when they were a day old', () => {
    const { rerender } = render(
      <ForgeRootsResult roots={{ ...ROOTS, from: 'plan' }} simulated={false} source="SRC" />,
    );
    expect(screen.getByTestId('forge-roots-result-chosen').textContent).toContain(
      'its simulation chose',
    );

    rerender(
      <ForgeRootsResult
        roots={{ ...ROOTS, read: 39, readAgain: { roots: 37, readAt: 'then' } }}
        simulated={false}
        source="SRC"
      />,
    );
    expect(screen.getByTestId('forge-roots-result-read-again').textContent).toBe(
      i18n.t('forgeRun.rootsResult.readAgain', {
        count: 37,
        formatted: '37',
        read: '39',
        at: 'then',
      }),
    );
  });

  it('says the roots are those the run retried wrote under, when a retry took them up', () => {
    render(
      <ForgeRootsResult
        roots={{ ...ROOTS, from: 'plan', ofTheRunRetried: true }}
        simulated={false}
        source="SRC"
      />,
    );

    expect(screen.getByTestId('forge-roots-result-chosen').textContent).toBe(
      i18n.t('forgeRun.rootsResult.fromRetried', {
        count: 37,
        formatted: '37',
        object: 'Account',
        cap: '200',
        at: 'not a date',
      }),
    );
  });

  it('offers the roots with their copies as a file only when it is handed the export', () => {
    const { rerender } = render(<ForgeRootsResult roots={ROOTS} simulated={false} source="SRC" />);
    expect(screen.queryByTestId('forge-roots-result-export')).toBeNull();

    const onExport = vi.fn();
    rerender(<ForgeRootsResult roots={ROOTS} simulated={false} source="SRC" onExport={onExport} />);
    fireEvent.click(screen.getByTestId('forge-roots-result-export'));

    expect(onExport).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('forge-roots-result-export').textContent).toBe(
      i18n.t('forgeRun.rootsResult.export'),
    );
  });
});
