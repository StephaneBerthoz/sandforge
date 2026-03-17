import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { OrgConnectDialog } from './OrgConnectDialog';

// jsdom doesn't implement dialog.showModal/close natively
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  });
});

describe('OrgConnectDialog', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onConnect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render when open', () => {
    render(<OrgConnectDialog {...defaultProps} />);
    expect(screen.getAllByText('Connect Org').length).toBeGreaterThan(0);
  });

  it('should render auth method select', () => {
    render(<OrgConnectDialog {...defaultProps} />);
    expect(screen.getByText('Auth Method')).toBeDefined();
  });

  it('should show sfdx hint for sfdx_import (default)', () => {
    render(<OrgConnectDialog {...defaultProps} />);
    expect(screen.getByText(/imported automatically/)).toBeDefined();
  });

  it('should call onConnect for sfdx_import without alias', () => {
    const onConnect = vi.fn();
    render(<OrgConnectDialog {...defaultProps} onConnect={onConnect} />);
    // Default method is sfdx_import — click Import All button
    const buttons = screen.getAllByText('Import All from SF CLI');
    fireEvent.click(buttons[buttons.length - 1]);
    expect(onConnect).toHaveBeenCalledWith({
      alias: '',
      authMethod: 'sfdx_import',
      loginUrl: 'https://login.salesforce.com',
    });
  });

  it('should show username/password fields when method is usernamePassword', () => {
    render(<OrgConnectDialog {...defaultProps} />);
    // Switch auth method to usernamePassword
    const selects = document.querySelectorAll('select');
    const authSelect = selects[0];
    fireEvent.change(authSelect, { target: { value: 'usernamePassword' } });

    expect(screen.getByPlaceholderText('my-sandbox')).toBeDefined();
    expect(screen.getByPlaceholderText('admin@example.com')).toBeDefined();
  });

  it('should call onConnect with credentials for usernamePassword', () => {
    const onConnect = vi.fn();
    render(<OrgConnectDialog {...defaultProps} onConnect={onConnect} />);

    // Switch to usernamePassword
    const selects = document.querySelectorAll('select');
    fireEvent.change(selects[0], { target: { value: 'usernamePassword' } });

    fireEvent.change(screen.getByPlaceholderText('my-sandbox'), { target: { value: 'my-dev' } });
    fireEvent.change(screen.getByPlaceholderText('admin@example.com'), { target: { value: 'admin@test.com' } });
    fireEvent.change(screen.getByTestId('password-input'), { target: { value: 'secret' } });

    const buttons = screen.getAllByText('Connect Org');
    fireEvent.click(buttons[buttons.length - 1]);

    expect(onConnect).toHaveBeenCalledWith({
      alias: 'my-dev',
      authMethod: 'usernamePassword',
      loginUrl: 'https://login.salesforce.com',
      username: 'admin@test.com',
      password: 'secret',
      securityToken: '',
    });
  });

  it('should show alias field for oauth_web', () => {
    render(<OrgConnectDialog {...defaultProps} />);
    const selects = document.querySelectorAll('select');
    fireEvent.change(selects[0], { target: { value: 'oauth_web' } });

    expect(screen.getByPlaceholderText('my-sandbox')).toBeDefined();
    expect(screen.getByText('Open Browser')).toBeDefined();
  });

  it('should show not-supported message for jwt', () => {
    render(<OrgConnectDialog {...defaultProps} />);
    const selects = document.querySelectorAll('select');
    fireEvent.change(selects[0], { target: { value: 'jwt' } });

    expect(screen.getByText(/not yet supported/)).toBeDefined();
  });

  it('should call onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(<OrgConnectDialog {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });
});
