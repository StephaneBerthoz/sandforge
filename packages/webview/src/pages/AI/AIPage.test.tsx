import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { AIPage } from './AIPage';

describe('AIPage', () => {
  it('should render the AI chat panel', () => {
    render(<AIPage />);
    expect(screen.getByTestId('ai-chat-panel')).toBeDefined();
  });

  it('should show new conversation button', () => {
    render(<AIPage />);
    expect(screen.getByTestId('new-conversation-btn')).toBeDefined();
  });

  it('should show empty conversations initially', () => {
    render(<AIPage />);
    expect(screen.getByTestId('no-conversations')).toBeDefined();
  });

  it('should show empty state when no conversation selected', () => {
    render(<AIPage />);
    expect(screen.getByText(/Select or create a conversation/i)).toBeDefined();
  });
});
