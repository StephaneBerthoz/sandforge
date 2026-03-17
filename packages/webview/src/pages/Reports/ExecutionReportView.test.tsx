import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ExecutionReportView } from './ExecutionReportView';
import type { GeneratedReport } from '@sandforge/shared';

const reports: GeneratedReport[] = [
  {
    id: 'rpt-1',
    definitionId: 'def-1',
    type: 'seed_execution',
    title: 'Seed Report - Dev1',
    summary: 'Seeded 500 records into Dev1',
    sections: [
      { title: 'Summary', type: 'summary', content: { records: 500, duration: '12s' }, order: 0 },
      {
        title: 'Details',
        type: 'table',
        content: { rows: [{ object: 'Account', count: 200 }, { object: 'Contact', count: 300 }] },
        order: 1,
      },
    ],
    metadata: { module: 'seed', duration: 12000, recordCount: 500 },
    generatedAt: '2026-02-20T10:00:00Z',
  },
  {
    id: 'rpt-2',
    definitionId: 'def-2',
    type: 'sync_execution',
    title: 'Sync Report - UAT',
    summary: 'Synced 1000 records',
    sections: [
      { title: 'Text Section', type: 'text', content: { text: 'Sync completed successfully' }, order: 0 },
    ],
    metadata: { module: 'sync', recordCount: 1000 },
    generatedAt: '2026-02-20T11:00:00Z',
  },
];

describe('ExecutionReportView', () => {
  it('should render the view', () => {
    render(<ExecutionReportView />);
    expect(screen.getByTestId('execution-report-view')).toBeDefined();
  });

  it('should show empty state when no reports', () => {
    render(<ExecutionReportView />);
    expect(screen.getByText('No reports generated yet')).toBeDefined();
  });

  it('should show report cards', () => {
    render(<ExecutionReportView reports={reports} />);
    expect(screen.getByTestId('report-rpt-1')).toBeDefined();
    expect(screen.getByTestId('report-rpt-2')).toBeDefined();
  });

  it('should show report titles', () => {
    render(<ExecutionReportView reports={reports} />);
    expect(screen.getByText('Seed Report - Dev1')).toBeDefined();
    expect(screen.getByText('Sync Report - UAT')).toBeDefined();
  });

  it('should show report type badges', () => {
    render(<ExecutionReportView reports={reports} />);
    expect(screen.getByText('Seed Execution')).toBeDefined();
    expect(screen.getByText('Sync Execution')).toBeDefined();
  });

  it('should call onSelectReport when clicked', () => {
    const onSelect = vi.fn();
    render(<ExecutionReportView reports={reports} onSelectReport={onSelect} />);
    const wrapper = screen.getByTestId('report-rpt-1');
    fireEvent.click(wrapper.querySelector('[role="button"]')!);
    expect(onSelect).toHaveBeenCalledWith('rpt-1');
  });

  it('should show report detail when selected', () => {
    render(<ExecutionReportView reports={reports} selectedReportId="rpt-1" />);
    expect(screen.getByTestId('report-detail')).toBeDefined();
  });

  it('should show summary section badges', () => {
    render(<ExecutionReportView reports={reports} selectedReportId="rpt-1" />);
    expect(screen.getByText(/records: 500/)).toBeDefined();
  });

  it('should show table section data', () => {
    render(<ExecutionReportView reports={reports} selectedReportId="rpt-1" />);
    expect(screen.getByTestId('report-table')).toBeDefined();
  });

  it('should show text section', () => {
    render(<ExecutionReportView reports={reports} selectedReportId="rpt-2" />);
    expect(screen.getByText('Sync completed successfully')).toBeDefined();
  });

  it('should call onExport when export clicked', () => {
    const onExport = vi.fn();
    render(<ExecutionReportView reports={reports} selectedReportId="rpt-1" onExport={onExport} />);
    fireEvent.click(screen.getByTestId('export-report-btn'));
    expect(onExport).toHaveBeenCalledWith('rpt-1');
  });

  it('should show metadata', () => {
    render(<ExecutionReportView reports={reports} selectedReportId="rpt-1" />);
    expect(screen.getByText('seed')).toBeDefined();
    expect(screen.getByText('12.0s')).toBeDefined();
  });
});
