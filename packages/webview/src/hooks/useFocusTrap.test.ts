import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { useRef } from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useFocusTrap } from './useFocusTrap';

interface TrapProps {
  testId: string;
  onEscape: () => void;
  initialFocus?: string;
  children?: React.ReactNode;
}

/** A dialog shell whose only job is to host the trap. */
function Trap({ testId, onEscape, initialFocus, children }: TrapProps): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onEscape, initialFocus ? { initialFocus } : undefined);
  return React.createElement(
    'div',
    { ref, role: 'dialog', 'aria-modal': 'true', 'data-testid': testId, tabIndex: -1 },
    children,
  );
}

function button(id: string, extra: Record<string, unknown> = {}): React.ReactElement {
  return React.createElement('button', { key: id, 'data-testid': id, ...extra }, id);
}

function byTestId(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing ${id}`);
  return el;
}

afterEach(() => {
  cleanup();
});

describe('useFocusTrap', () => {
  it('focuses the first focusable control when the trap opens', () => {
    render(
      React.createElement(Trap, { testId: 'dlg', onEscape: vi.fn() }, [button('a'), button('b')]),
    );
    expect(document.activeElement).toBe(byTestId('a'));
  });

  it('focuses the element named by initialFocus instead of the first control', () => {
    render(
      React.createElement(
        Trap,
        { testId: 'dlg', onEscape: vi.fn(), initialFocus: '[data-testid="b"]' },
        [button('a'), button('b')],
      ),
    );
    expect(document.activeElement).toBe(byTestId('b'));
  });

  it('focuses the dialog itself when it holds no focusable control', () => {
    render(React.createElement(Trap, { testId: 'dlg', onEscape: vi.fn() }));
    expect(document.activeElement).toBe(byTestId('dlg'));
  });

  it('wraps Tab from the last control to the first and Shift+Tab back, skipping disabled ones', () => {
    render(
      React.createElement(Trap, { testId: 'dlg', onEscape: vi.fn() }, [
        button('a'),
        button('b'),
        button('c', { disabled: true }),
      ]),
    );
    const a = byTestId('a');
    const b = byTestId('b');

    b.focus();
    fireEvent.keyDown(b, { key: 'Tab' });
    expect(document.activeElement).toBe(a);

    fireEvent.keyDown(a, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(b);
  });

  it('brings focus back inside when Tab is pressed while focus sits outside the dialog', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    render(
      React.createElement(Trap, { testId: 'dlg', onEscape: vi.fn() }, [button('a'), button('b')]),
    );
    outside.focus();
    fireEvent.keyDown(outside, { key: 'Tab' });
    expect(document.activeElement).toBe(byTestId('a'));
    outside.remove();
  });

  it('calls onEscape on Escape', () => {
    const onEscape = vi.fn();
    render(React.createElement(Trap, { testId: 'dlg', onEscape }, [button('a')]));
    fireEvent.keyDown(byTestId('a'), { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it('lets only the most recently opened dialog answer the keyboard', () => {
    const lower = vi.fn();
    const upper = vi.fn();
    render(
      React.createElement(React.Fragment, null, [
        React.createElement(Trap, { key: 'l', testId: 'lower', onEscape: lower }, [button('l1')]),
        React.createElement(Trap, { key: 'u', testId: 'upper', onEscape: upper }, [button('u1')]),
      ]),
    );
    expect(document.activeElement).toBe(byTestId('u1'));
    // With focus inside the upper dialog the lower one would stand aside anyway;
    // only with focus outside both (a click on the backdrop) does the order decide.
    byTestId('u1').blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(upper).toHaveBeenCalledOnce();
    expect(lower).not.toHaveBeenCalled();
  });

  it('ignores keys while focus is inside another modal it does not own', () => {
    const onEscape = vi.fn();
    render(React.createElement(Trap, { testId: 'dlg', onEscape }, [button('a'), button('b')]));
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    other.setAttribute('aria-modal', 'true');
    const input = document.createElement('input');
    other.appendChild(input);
    document.body.appendChild(other);

    input.focus();
    fireEvent.keyDown(input, { key: 'Tab' });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(document.activeElement).toBe(input);
    expect(onEscape).not.toHaveBeenCalled();
    other.remove();
  });

  it('returns focus to the element that had it before the dialog opened', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      React.createElement(Trap, { testId: 'dlg', onEscape: vi.fn() }, [button('a')]),
    );
    expect(document.activeElement).toBe(byTestId('a'));
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('returns focus to the opener when a child took focus through autoFocus', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      React.createElement(Trap, { testId: 'dlg', onEscape: vi.fn() }, [
        button('a'),
        React.createElement('input', { key: 'field', 'data-testid': 'field', autoFocus: true }),
      ]),
    );
    expect(document.activeElement).toBe(byTestId('field'));
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('uses the latest onEscape without moving focus again on re-render', () => {
    // An opener gives a torn-down trap somewhere to send focus back to.
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      React.createElement(Trap, { testId: 'dlg', onEscape: first }, [button('a'), button('b')]),
    );
    byTestId('b').focus();
    rerender(
      React.createElement(Trap, { testId: 'dlg', onEscape: second }, [button('a'), button('b')]),
    );
    expect(document.activeElement).toBe(byTestId('b'));

    fireEvent.keyDown(byTestId('b'), { key: 'Escape' });
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    opener.remove();
  });
});
