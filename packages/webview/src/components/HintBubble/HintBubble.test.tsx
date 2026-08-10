import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { HintBubble, isHintDismissed } from './HintBubble';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn() },
  }),
}));

/* In-memory mock of the webview state persistence layer. */
const mockPersistedState = vi.hoisted(() => {
  const store: Record<string, string> = {};
  return {
    store,
    reset(): void {
      for (const key of Object.keys(store)) {
        delete store[key];
      }
    },
  };
});

vi.mock('../../utils/webviewStorage', () => ({
  getPersistedItem: (key: string): string | null => mockPersistedState.store[key] ?? null,
  setPersistedItem: (key: string, value: string): void => {
    mockPersistedState.store[key] = value;
  },
  removePersistedItem: (key: string): void => {
    delete mockPersistedState.store[key];
  },
}));

describe('HintBubble', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockPersistedState.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not render immediately (waits for delay)', () => {
    render(<HintBubble hintId="test" message="Hello" onDismiss={vi.fn()} />);
    expect(screen.queryByTestId('hint-test')).toBeNull();
  });

  it('should render after the 500ms delay', () => {
    render(<HintBubble hintId="test" message="Hello" onDismiss={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByTestId('hint-test')).toBeDefined();
  });

  it('should display the hint message', () => {
    render(<HintBubble hintId="tip" message="Try this feature" onDismiss={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByText('Try this feature')).toBeDefined();
  });

  it('should render the dismiss button with translated text', () => {
    render(<HintBubble hintId="tip" message="Hint" onDismiss={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByTestId('hint-dismiss-tip')).toBeDefined();
    expect(screen.getByText('hints.gotIt')).toBeDefined();
  });

  it('should call onDismiss with the hintId when dismiss is clicked', () => {
    const onDismiss = vi.fn();
    render(<HintBubble hintId="my-hint" message="Msg" onDismiss={onDismiss} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.click(screen.getByTestId('hint-dismiss-my-hint'));
    expect(onDismiss).toHaveBeenCalledWith('my-hint');
  });

  it('should not render when seen is true', () => {
    render(<HintBubble hintId="old" message="Old hint" onDismiss={vi.fn()} seen />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByTestId('hint-old')).toBeNull();
  });

  it('should hide after dismiss is clicked', () => {
    render(<HintBubble hintId="vanish" message="Gone" onDismiss={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.click(screen.getByTestId('hint-dismiss-vanish'));
    expect(screen.queryByTestId('hint-vanish')).toBeNull();
  });

  it('should default to bottom position', () => {
    render(<HintBubble hintId="pos" message="Position test" onDismiss={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const bubble = screen.getByTestId('hint-pos');
    expect(bubble.className).toContain('top-full');
  });

  it('should render documentation link when docUrl is provided', () => {
    render(
      <HintBubble
        hintId="doc"
        message="Check docs"
        onDismiss={vi.fn()}
        docUrl="https://developer.salesforce.com/docs"
      />,
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const link = screen.getByTestId('hint-doc-link-doc');
    expect(link).toBeDefined();
    expect(link.getAttribute('href')).toBe('https://developer.salesforce.com/docs');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('should not render documentation link when docUrl is not provided', () => {
    render(<HintBubble hintId="nodoc" message="No docs" onDismiss={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByTestId('hint-doc-link-nodoc')).toBeNull();
  });

  it('should render example values when examples are provided', () => {
    render(
      <HintBubble
        hintId="ex"
        message="Examples"
        onDismiss={vi.fn()}
        examples={['Account', 'Contact', 'Lead']}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const examplesContainer = screen.getByTestId('hint-examples-ex');
    expect(examplesContainer).toBeDefined();
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('Contact')).toBeDefined();
    expect(screen.getByText('Lead')).toBeDefined();
  });

  it('should not render examples when not provided', () => {
    render(<HintBubble hintId="noex" message="No examples" onDismiss={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByTestId('hint-examples-noex')).toBeNull();
  });

  it('should render the dont-show-again checkbox', () => {
    render(<HintBubble hintId="perm" message="Persistent" onDismiss={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByTestId('hint-dont-show-perm')).toBeDefined();
    expect(screen.getByText('hints.dontShowHint')).toBeDefined();
  });

  it('should persist dismissal in the webview state when dont-show-again is checked', () => {
    render(<HintBubble hintId="persist" message="Persist" onDismiss={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // Check the checkbox
    fireEvent.click(screen.getByTestId('hint-dont-show-persist'));
    // Dismiss
    fireEvent.click(screen.getByTestId('hint-dismiss-persist'));
    expect(mockPersistedState.store['sandforge-hint-dismissed-persist']).toBe('true');
  });

  it('should not persist dismissal when dont-show-again is not checked', () => {
    render(<HintBubble hintId="nopersist" message="No persist" onDismiss={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.click(screen.getByTestId('hint-dismiss-nopersist'));
    expect(mockPersistedState.store['sandforge-hint-dismissed-nopersist']).toBeUndefined();
  });

  it('should not show hint if it was permanently dismissed', () => {
    mockPersistedState.store['sandforge-hint-dismissed-hidden'] = 'true';
    render(<HintBubble hintId="hidden" message="Hidden" onDismiss={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByTestId('hint-hidden')).toBeNull();
  });
});

describe('isHintDismissed', () => {
  beforeEach(() => {
    mockPersistedState.reset();
  });

  it('should return false for non-dismissed hints', () => {
    expect(isHintDismissed('new-hint')).toBe(false);
  });

  it('should return true for dismissed hints', () => {
    mockPersistedState.store['sandforge-hint-dismissed-old-hint'] = 'true';
    expect(isHintDismissed('old-hint')).toBe(true);
  });
});
