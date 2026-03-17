import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { AIPage } from './AIPage';
import { useAppStore } from '../../stores/useAppStore';

// Mock useSendMessage to avoid side effects
vi.mock('../../hooks/useMessageBus', () => ({
  useSendMessage: () => vi.fn(),
  useMessageListener: vi.fn(),
}));

vi.mock('../../bridge/messageHelpers', () => ({
  buildMessage: vi.fn((type: string, payload: unknown) => ({ type, payload })),
}));

describe('AIPage', () => {
  beforeEach(() => {
    useAppStore.setState({ aiAvailable: false });
  });

  describe('when AI is not configured', () => {
    it('should show not-configured guidance', () => {
      render(<AIPage />);
      expect(screen.getByTestId('ai-not-configured')).toBeDefined();
    });

    it('should show guidance title', () => {
      render(<AIPage />);
      expect(screen.getByText(/AI Assistant Not Configured/i)).toBeDefined();
    });

    it('should show guidance description', () => {
      render(<AIPage />);
      expect(screen.getByText(/configure your API key in Settings/i)).toBeDefined();
    });

    it('should show a button to navigate to settings', () => {
      render(<AIPage />);
      const button = screen.getByTestId('empty-action-button');
      expect(button).toBeDefined();
      expect(button.textContent).toMatch(/Go to Settings/i);
    });

    it('should navigate to settings when button is clicked', () => {
      const navigateSpy = vi.fn();
      useAppStore.setState({ aiAvailable: false, navigate: navigateSpy });
      render(<AIPage />);
      const button = screen.getByTestId('empty-action-button');
      fireEvent.click(button);
      expect(navigateSpy).toHaveBeenCalledWith('settings');
    });

    it('should not show the chat panel', () => {
      render(<AIPage />);
      expect(screen.queryByTestId('ai-chat-panel')).toBeNull();
    });
  });

  describe('when AI is configured', () => {
    beforeEach(() => {
      useAppStore.setState({ aiAvailable: true });
    });

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

    it('should not show the not-configured guidance', () => {
      render(<AIPage />);
      expect(screen.queryByTestId('ai-not-configured')).toBeNull();
    });
  });
});
