import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { RealTimeSyncPanel } from './RealTimeSyncPanel';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */
vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: vi.fn(),
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
  }),
}));

vi.mock('../../hooks/useMessageBus', () => ({
  useMessageListener: vi.fn(),
  useSendMessage: vi.fn().mockReturnValue(vi.fn()),
}));

const defaultProps = {
  sourceOrgId: 'org-src-001',
  targetOrgId: 'org-tgt-001',
  availableObjects: ['Account', 'Contact', 'Opportunity'],
};

describe('RealTimeSyncPanel', () => {
  describe('rendering', () => {
    it('should render the panel with test ID', () => {
      render(<RealTimeSyncPanel {...defaultProps} />);

      expect(screen.getByTestId('realtime-sync-panel')).toBeDefined();
    });

    it('should render the status badge', () => {
      render(<RealTimeSyncPanel {...defaultProps} />);

      expect(screen.getByTestId('realtime-status')).toBeDefined();
    });

    it('should render object selection checkboxes', () => {
      render(<RealTimeSyncPanel {...defaultProps} />);

      expect(screen.getByTestId('realtime-object-Account')).toBeDefined();
      expect(screen.getByTestId('realtime-object-Contact')).toBeDefined();
      expect(screen.getByTestId('realtime-object-Opportunity')).toBeDefined();
    });

    it('should render toggle button', () => {
      render(<RealTimeSyncPanel {...defaultProps} />);

      expect(screen.getByTestId('realtime-toggle')).toBeDefined();
    });

    it('should have toggle button disabled (coming soon)', () => {
      render(<RealTimeSyncPanel {...defaultProps} />);

      const button = screen.getByTestId('realtime-toggle');
      expect(button).toHaveProperty('disabled', true);
    });

    it('should render objects card when availableObjects is empty', () => {
      render(
        <RealTimeSyncPanel
          {...defaultProps}
          availableObjects={[]}
        />,
      );

      expect(screen.getByTestId('realtime-objects')).toBeDefined();
    });
  });

  describe('coming soon overlay', () => {
    it('should render "Coming in v2.0" badge text', () => {
      render(<RealTimeSyncPanel {...defaultProps} />);

      expect(screen.getByTestId('realtime-coming-soon')).toBeDefined();
      expect(screen.getByText(/Coming in v2\.0/)).toBeDefined();
    });

    it('should have all checkboxes disabled', () => {
      render(<RealTimeSyncPanel {...defaultProps} />);

      const accountCb = screen.getByTestId('realtime-object-Account') as HTMLInputElement;
      const contactCb = screen.getByTestId('realtime-object-Contact') as HTMLInputElement;
      expect(accountCb.disabled).toBe(true);
      expect(contactCb.disabled).toBe(true);
    });

    it('should have content with pointer-events-none and reduced opacity', () => {
      render(<RealTimeSyncPanel {...defaultProps} />);

      const container = screen.getByTestId('realtime-sync-panel');
      const disabledContent = container.querySelector('.pointer-events-none.opacity-50');
      expect(disabledContent).toBeDefined();
      expect(disabledContent).not.toBeNull();
    });
  });
});
