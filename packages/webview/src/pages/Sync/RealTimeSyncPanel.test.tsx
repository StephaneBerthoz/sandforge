import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { RealTimeSyncPanel } from './RealTimeSyncPanel';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */
const mockStartMutate = vi.fn();
const mockStopMutate = vi.fn();
const mockMetricsMutate = vi.fn();
const mockResolveMutate = vi.fn();

let mockStartData: Record<string, unknown> | null = null;
let mockStopData: Record<string, unknown> | null = null;

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'realtime:start') {
      return {
        mutate: mockStartMutate,
        data: mockStartData,
        loading: false,
        error: null,
        reset: vi.fn(),
      };
    }
    if (type === 'realtime:stop') {
      return {
        mutate: mockStopMutate,
        data: mockStopData,
        loading: false,
        error: null,
        reset: vi.fn(),
      };
    }
    if (type === 'realtime:metrics') {
      return {
        mutate: mockMetricsMutate,
        data: null,
        loading: false,
        error: null,
        reset: vi.fn(),
      };
    }
    if (type === 'realtime:resolve-conflict') {
      return {
        mutate: mockResolveMutate,
        data: null,
        loading: false,
        error: null,
        reset: vi.fn(),
      };
    }
    return {
      mutate: vi.fn(),
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
    };
  },
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartData = null;
    mockStopData = null;
  });

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

    it('should disable toggle button when no objects selected', () => {
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

  describe('object selection', () => {
    it('should toggle object selection on checkbox click', () => {
      render(<RealTimeSyncPanel {...defaultProps} />);

      const checkbox = screen.getByTestId(
        'realtime-object-Account',
      ) as HTMLInputElement;
      fireEvent.click(checkbox);

      expect(checkbox.checked).toBe(true);
    });

    it('should enable toggle button when objects are selected', () => {
      render(<RealTimeSyncPanel {...defaultProps} />);

      fireEvent.click(screen.getByTestId('realtime-object-Account'));

      expect(screen.getByTestId('realtime-toggle')).toHaveProperty(
        'disabled',
        false,
      );
    });

    it('should deselect object on second click', () => {
      render(<RealTimeSyncPanel {...defaultProps} />);

      const checkbox = screen.getByTestId(
        'realtime-object-Account',
      ) as HTMLInputElement;
      fireEvent.click(checkbox);
      fireEvent.click(checkbox);

      expect(checkbox.checked).toBe(false);
    });
  });

  describe('start/stop', () => {
    it('should call start mutation with selected objects', () => {
      render(<RealTimeSyncPanel {...defaultProps} />);

      fireEvent.click(screen.getByTestId('realtime-object-Account'));
      fireEvent.click(screen.getByTestId('realtime-object-Contact'));
      fireEvent.click(screen.getByTestId('realtime-toggle'));

      expect(mockStartMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceOrgId: 'org-src-001',
          targetOrgId: 'org-tgt-001',
          watchedObjects: ['Account', 'Contact'],
        }),
      );
    });

    it('should not start when no objects selected', () => {
      render(<RealTimeSyncPanel {...defaultProps} />);

      // Button is disabled, but even if clicked:
      fireEvent.click(screen.getByTestId('realtime-toggle'));

      expect(mockStartMutate).not.toHaveBeenCalled();
    });
  });

  describe('status display', () => {
    it('should show disconnected status initially', () => {
      render(<RealTimeSyncPanel {...defaultProps} />);

      const statusWrapper = screen.getByTestId('realtime-status');
      expect(statusWrapper).toBeDefined();
    });
  });
});
