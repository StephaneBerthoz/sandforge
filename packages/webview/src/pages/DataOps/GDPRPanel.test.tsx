import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { GDPRPanel } from './GDPRPanel';
import type { DSRUI, PIIFieldUI, ComplianceSummaryUI } from './GDPRPanel';

const dsrs: DSRUI[] = [
  {
    id: 'dsr-1',
    type: 'erasure',
    subjectEmail: 'john@example.com',
    subjectName: 'John Doe',
    requestDate: '2025-01-01T00:00:00.000Z',
    dueDate: '2025-01-31T00:00:00.000Z',
    status: 'pending',
    recordsFound: 15,
    recordsProcessed: 0,
    notes: '',
  },
  {
    id: 'dsr-2',
    type: 'access',
    subjectEmail: 'jane@example.com',
    subjectName: 'Jane Doe',
    requestDate: '2025-01-15T00:00:00.000Z',
    dueDate: '2025-02-14T00:00:00.000Z',
    status: 'completed',
    recordsFound: 8,
    recordsProcessed: 8,
    notes: '',
  },
];

const piiFields: PIIFieldUI[] = [
  { objectApiName: 'Contact', fieldApiName: 'Email', piiCategory: 'email', recordCount: 1500 },
  { objectApiName: 'Contact', fieldApiName: 'Phone', piiCategory: 'phone', recordCount: 1200 },
];

const summary: ComplianceSummaryUI = {
  total: 5,
  pending: 2,
  inProgress: 1,
  completed: 2,
  overdue: 1,
  averageResolutionDays: 12,
};

describe('GDPRPanel', () => {
  it('should render the panel', () => {
    render(<GDPRPanel />);
    expect(screen.getByTestId('gdpr-panel')).toBeDefined();
  });

  it('should show empty state when no DSRs', () => {
    render(<GDPRPanel />);
    expect(screen.getByTestId('no-dsrs')).toBeDefined();
  });

  it('should render DSR list', () => {
    render(<GDPRPanel dsrs={dsrs} />);
    expect(screen.getByTestId('dsr-dsr-1')).toBeDefined();
    expect(screen.getByTestId('dsr-dsr-2')).toBeDefined();
  });

  it('should show DSR type badge', () => {
    render(<GDPRPanel dsrs={dsrs} />);
    expect(screen.getByTestId('dsr-type-dsr-1').textContent).toContain('erasure');
  });

  it('should show DSR status badge', () => {
    render(<GDPRPanel dsrs={dsrs} />);
    expect(screen.getByTestId('dsr-status-dsr-1').textContent).toContain('pending');
    expect(screen.getByTestId('dsr-status-dsr-2').textContent).toContain('completed');
  });

  it('should show process button for pending DSRs', () => {
    const onProcess = vi.fn();
    render(<GDPRPanel dsrs={dsrs} onProcessDSR={onProcess} />);
    const btn = screen.getByTestId('process-dsr-dsr-1');
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(onProcess).toHaveBeenCalledWith('dsr-1');
  });

  it('should not show process button for completed DSRs', () => {
    render(<GDPRPanel dsrs={dsrs} onProcessDSR={vi.fn()} />);
    expect(screen.queryByTestId('process-dsr-dsr-2')).toBeNull();
  });

  it('should render compliance summary', () => {
    render(<GDPRPanel complianceSummary={summary} />);
    expect(screen.getByTestId('compliance-summary')).toBeDefined();
    expect(screen.getByTestId('summary-total').textContent).toContain('5');
    expect(screen.getByTestId('summary-pending').textContent).toContain('2');
    expect(screen.getByTestId('summary-overdue').textContent).toContain('1');
  });

  it('should show average resolution days', () => {
    render(<GDPRPanel complianceSummary={summary} />);
    expect(screen.getByTestId('avg-resolution').textContent).toContain('12');
  });

  it('should render PII scan results', () => {
    render(<GDPRPanel piiFields={piiFields} />);
    expect(screen.getByTestId('pii-results')).toBeDefined();
    expect(screen.getByTestId('pii-field-0')).toBeDefined();
    expect(screen.getByTestId('pii-field-1')).toBeDefined();
  });

  it('should show PII category badge', () => {
    render(<GDPRPanel piiFields={piiFields} />);
    const field0 = screen.getByTestId('pii-field-0');
    expect(field0.textContent).toContain('email');
  });

  it('should show no-PII message when empty', () => {
    render(<GDPRPanel />);
    expect(screen.getByTestId('no-pii')).toBeDefined();
  });

  it('should render scan PII button', () => {
    const onScan = vi.fn();
    render(<GDPRPanel onScanPII={onScan} />);
    const btn = screen.getByTestId('scan-pii-btn');
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(onScan).toHaveBeenCalled();
  });

  it('should disable scan button when scanning', () => {
    render(<GDPRPanel onScanPII={vi.fn()} isScanning />);
    const btn = screen.getByTestId('scan-pii-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('should render create DSR form', () => {
    render(<GDPRPanel onCreateDSR={vi.fn()} />);
    expect(screen.getByTestId('create-dsr-form')).toBeDefined();
    expect(screen.getByTestId('dsr-type-select')).toBeDefined();
    expect(screen.getByTestId('dsr-email-input')).toBeDefined();
    expect(screen.getByTestId('dsr-name-input')).toBeDefined();
    expect(screen.getByTestId('create-dsr-btn')).toBeDefined();
  });

  it('should call onCreateDSR with form values', () => {
    const onCreate = vi.fn();
    render(<GDPRPanel onCreateDSR={onCreate} />);

    fireEvent.change(screen.getByTestId('dsr-email-input'), {
      target: { value: 'test@example.com' },
    });
    fireEvent.change(screen.getByTestId('dsr-name-input'), { target: { value: 'Test User' } });
    fireEvent.click(screen.getByTestId('create-dsr-btn'));

    expect(onCreate).toHaveBeenCalledWith('erasure', 'test@example.com', 'Test User');
  });

  it('should show overdue warning when DSRs are overdue', () => {
    const overdueDSRs: DSRUI[] = [
      {
        id: 'dsr-overdue',
        type: 'erasure',
        subjectEmail: 'old@test.com',
        subjectName: 'Old Request',
        requestDate: '2020-01-01T00:00:00.000Z',
        dueDate: '2020-02-01T00:00:00.000Z',
        status: 'pending',
        recordsFound: 0,
        recordsProcessed: 0,
        notes: '',
      },
    ];
    render(<GDPRPanel dsrs={overdueDSRs} />);
    expect(screen.getByTestId('overdue-warning')).toBeDefined();
  });
});
