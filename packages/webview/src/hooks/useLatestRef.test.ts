import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEffect } from 'react';
import { useLatestRef } from './useLatestRef';

describe('useLatestRef', () => {
  it('keeps the same ref object across renders', () => {
    const { result, rerender } = renderHook(({ value }) => useLatestRef(value), {
      initialProps: { value: 'a' },
    });
    const first = result.current;

    rerender({ value: 'b' });

    // The identity is what makes the ref safe to list as a dependency: a new
    // object every render would re-run every effect that names it.
    expect(result.current).toBe(first);
  });

  it('exposes the latest value after a re-render', () => {
    const { result, rerender } = renderHook(({ value }) => useLatestRef(value), {
      initialProps: { value: 1 },
    });

    rerender({ value: 2 });

    expect(result.current.current).toBe(2);
  });

  it('is already current when an effect declared below it runs', () => {
    // The whole point: an effect that fires on one trigger reads everything
    // else through the ref, and must see the values of the commit that fired
    // it — not the ones captured when the effect was first set up.
    const seen: string[] = [];

    function useSubject({ trigger, label }: { trigger: number; label: string }): void {
      const latestLabel = useLatestRef(label);
      useEffect(() => {
        seen.push(latestLabel.current);
      }, [trigger, latestLabel]);
    }

    const { rerender } = renderHook((props) => useSubject(props), {
      initialProps: { trigger: 0, label: 'first' },
    });

    // A render that changes only the label must not fire the effect…
    rerender({ trigger: 0, label: 'second' });
    expect(seen).toEqual(['first']);

    // …and when the trigger does change, the body sees the current label.
    rerender({ trigger: 1, label: 'third' });
    expect(seen).toEqual(['first', 'third']);
  });

  it('holds a callback whose identity changes on every render', () => {
    const calls: number[] = [];
    const { rerender } = renderHook(
      ({ trigger, n }: { trigger: number; n: number }) => {
        const onTrigger = useLatestRef(() => calls.push(n));
        useEffect(() => {
          if (trigger === 0) return;
          onTrigger.current();
        }, [trigger, onTrigger]);
      },
      { initialProps: { trigger: 0, n: 0 } },
    );

    rerender({ trigger: 1, n: 42 });

    expect(calls).toEqual([42]);
  });

  it('does not re-render on its own when the value changes', () => {
    const render = vi.fn();
    const { rerender } = renderHook(
      ({ value }: { value: number }) => {
        render();
        return useLatestRef(value);
      },
      { initialProps: { value: 0 } },
    );

    act(() => {
      rerender({ value: 1 });
    });

    expect(render).toHaveBeenCalledTimes(2);
  });
});
