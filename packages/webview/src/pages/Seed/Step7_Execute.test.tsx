import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { Step7Execute } from './Step7_Execute';
import type { ObjectProgress } from './Step7_Execute';

const progress: ObjectProgress[] = [
  { objectApiName: 'Account', total: 500, completed: 500, failed: 0, status: 'done' },
  { objectApiName: 'Contact', total: 1000, completed: 600, failed: 10, status: 'running' },
];

describe('Step7Execute', () => {
  it('should render the step', () => {
    render(
      <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
    );
    expect(screen.getByTestId('step-execute')).toBeDefined();
  });

  it('should show elapsed time', () => {
    render(
      <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
    );
    expect(screen.getByTestId('elapsed-time').textContent).toContain('5.0s');
  });

  it('should show per-object progress', () => {
    render(
      <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
    );
    expect(screen.getByTestId('progress-Account')).toBeDefined();
    expect(screen.getByTestId('progress-Contact')).toBeDefined();
  });

  it('should show status badges', () => {
    render(
      <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
    );
    expect(screen.getByText('done')).toBeDefined();
    expect(screen.getByText('running')).toBeDefined();
  });

  it('should show failed count', () => {
    render(
      <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
    );
    const contactRow = screen.getByTestId('progress-Contact');
    expect(contactRow.textContent).toContain('10');
  });

  it('should show completion counts', () => {
    render(
      <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
    );
    expect(screen.getByTestId('progress-Account').textContent).toContain('500/500');
    expect(screen.getByTestId('progress-Contact').textContent).toContain('600/1000');
  });

  it('should show running label when in progress', () => {
    render(
      <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
    );
    expect(screen.getByText('Seeding data...')).toBeDefined();
  });
});
