import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { OrgDeviceCode } from '@sandforge/shared';
import { dateTimeFormat } from '../../utils/formatters';
import { DeviceCodePanel } from './DeviceCodePanel';

const CODE: OrgDeviceCode = {
  userCode: 'AB12CD34',
  verificationUri: 'https://test.salesforce.com/setup/connect',
  expiresAt: Date.UTC(2026, 8, 23, 10, 10, 0),
};

describe('DeviceCodePanel', () => {
  it('shows the code to type and the Salesforce page to type it on, as a link', () => {
    render(<DeviceCodePanel code={CODE} onCancel={vi.fn()} />);

    expect(screen.getByTestId('org-device-user-code').textContent).toBe('AB12CD34');
    const link = screen.getByRole('link', { name: 'https://test.salesforce.com/setup/connect' });
    expect(link.getAttribute('href')).toBe('https://test.salesforce.com/setup/connect');
    expect(screen.getByText('Enter this code on the Salesforce verification page:')).toBeDefined();
  });

  it('says when the code stops working, in the interface language', () => {
    render(<DeviceCodePanel code={CODE} onCancel={vi.fn()} />);

    const time = dateTimeFormat({ hour: '2-digit', minute: '2-digit' }).format(
      new Date(CODE.expiresAt),
    );
    expect(screen.getByText(`The code expires at ${time}.`)).toBeDefined();
  });

  it('still shows the code when the expiry time it came with is not a time', () => {
    // Formatting it threw "Invalid time value", and the code to enter never showed.
    render(<DeviceCodePanel code={{ ...CODE, expiresAt: Number.NaN }} onCancel={vi.fn()} />);

    expect(screen.getByTestId('org-device-user-code').textContent).toBe('AB12CD34');
    expect(screen.getByText('The code expires at unknown.')).toBeDefined();
  });

  it('moves focus onto the code, since the button that asked for it is gone', () => {
    render(<DeviceCodePanel code={CODE} onCancel={vi.fn()} />);

    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute('role')).toBe('status');
    expect(focused.textContent).toContain('AB12CD34');
  });

  it('stops the sign-in from its cancel button', () => {
    const onCancel = vi.fn();
    render(<DeviceCodePanel code={CODE} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('never makes a page that is not https clickable', () => {
    render(
      <DeviceCodePanel
        code={{ ...CODE, verificationUri: 'javascript:alert(document.cookie)' }}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByTestId('org-device-verification-link')).toBeNull();
  });
});
