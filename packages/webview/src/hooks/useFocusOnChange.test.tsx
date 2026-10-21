import { describe, it, expect, afterEach } from 'vitest';
import React, { StrictMode, useRef } from 'react';
import { cleanup, render } from '@testing-library/react';
import { useFocusOnChange } from './useFocusOnChange';

interface ScreenProps {
  phase: string;
  onMount?: boolean;
}

/** A screen that draws one phase at a time, each with its control and its heading. */
function Screen({ phase, onMount }: ScreenProps): React.ReactElement {
  const scope = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusOnChange(heading, phase, { scope, onMount });
  return (
    <>
      <button data-testid="outside">outside</button>
      <div ref={scope} data-testid="scope">
        <h2 ref={heading} tabIndex={-1} data-testid="heading">
          {phase}
        </h2>
        <button key={phase} data-testid={`control-${phase}`}>
          {phase}
        </button>
        <button data-testid="kept">kept</button>
      </div>
    </>
  );
}

function byTestId(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing ${id}`);
  return el;
}

afterEach(() => {
  cleanup();
});

describe('useFocusOnChange', () => {
  it('leaves the focus alone on the first render', () => {
    render(<Screen phase="confirm" />);
    expect(document.activeElement).toBe(document.body);
  });

  it('takes the focus on the first render when asked to, once under StrictMode', () => {
    render(
      <StrictMode>
        <Screen phase="confirm" onMount />
      </StrictMode>,
    );
    expect(document.activeElement).toBe(byTestId('heading'));
  });

  it('hands the target the focus the control that changed the phase dropped', () => {
    const { rerender } = render(<Screen phase="confirm" />);
    byTestId('control-confirm').focus();
    rerender(<Screen phase="executing" />);
    expect(document.activeElement).toBe(byTestId('heading'));
  });

  it('takes the focus from a control inside the screen that stayed', () => {
    const { rerender } = render(<Screen phase="confirm" />);
    byTestId('kept').focus();
    rerender(<Screen phase="results" />);
    expect(document.activeElement).toBe(byTestId('heading'));
  });

  it('leaves the focus on a control outside the screen', () => {
    const { rerender } = render(<Screen phase="confirm" />);
    byTestId('outside').focus();
    rerender(<Screen phase="results" />);
    expect(document.activeElement).toBe(byTestId('outside'));
  });

  it('does nothing when the key did not change', () => {
    const { rerender } = render(<Screen phase="confirm" />);
    byTestId('kept').focus();
    rerender(<Screen phase="confirm" />);
    expect(document.activeElement).toBe(byTestId('kept'));
  });
});
