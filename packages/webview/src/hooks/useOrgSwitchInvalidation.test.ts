import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOrgSwitchInvalidation } from './useOrgSwitchInvalidation';

// Track postMessage calls
const mockPostMessage = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue: string) => defaultValue,
  }),
}));

vi.mock('./useMessageBus', () => ({
  useSendMessage: () => mockPostMessage,
}));

vi.mock('../bridge/messageHelpers', () => ({
  buildMessage: (type: string) => ({ id: 'test-id', type, timestamp: Date.now() }),
}));

// Create a minimal reactive store mock
let currentOrgId: string | null = null;

const mockAddNotification = vi.fn();
vi.mock('../stores/useNotificationStore', () => ({
  useNotificationStore: (
    selector: (state: { addNotification: typeof mockAddNotification }) => unknown,
  ) => selector({ addNotification: mockAddNotification }),
}));

vi.mock('../stores/useOrgStore', () => ({
  useOrgStore: (selector: (state: { selectedOrgId: string | null }) => unknown) => {
    // This is a simplified mock -- the actual hook re-renders via React
    return selector({ selectedOrgId: currentOrgId });
  },
}));

describe('useOrgSwitchInvalidation', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    mockAddNotification.mockClear();
    currentOrgId = null;
  });

  it('should not send message on initial mount with null org', () => {
    currentOrgId = null;
    renderHook(() => useOrgSwitchInvalidation());

    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockAddNotification).not.toHaveBeenCalled();
  });

  it('should not send message when first org is selected (prev was null)', () => {
    currentOrgId = null;
    const { rerender } = renderHook(() => useOrgSwitchInvalidation());

    currentOrgId = 'org-1';
    rerender();

    // Previous was null, so no invalidation
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('should send cache:invalidate-all when org changes from one to another', () => {
    currentOrgId = 'org-1';
    const { rerender } = renderHook(() => useOrgSwitchInvalidation());

    // Now switch to org-2
    currentOrgId = 'org-2';
    rerender();

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cache:invalidate-all' }),
    );
  });

  it('should show a notification on org switch', () => {
    currentOrgId = 'org-1';
    const { rerender } = renderHook(() => useOrgSwitchInvalidation());

    currentOrgId = 'org-2';
    rerender();

    expect(mockAddNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        autoDismissMs: 2000,
      }),
    );
  });

  it('should not send message when org stays the same', () => {
    currentOrgId = 'org-1';
    const { rerender } = renderHook(() => useOrgSwitchInvalidation());

    // Re-render with same org
    rerender();

    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});
