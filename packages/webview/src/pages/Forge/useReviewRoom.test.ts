import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  COLUMN_FLOOR,
  GAPS_FLOOR,
  columnRoom,
  gapsRoom,
  scrollerOf,
  useReviewRoom,
} from './useReviewRoom';

describe('columnRoom', () => {
  const view = { top: 0, height: 800 };

  it('gives the column what the window holds below where the page puts it', () => {
    // Beside the sentence, 230 pixels down: held to the window's height less
    // 24 pixels, it ran 206 pixels past the window's bottom.
    expect(columnRoom(view, 230)).toBe(570);
  });

  it('gives it the window less its top once the page has scrolled it to where it sticks', () => {
    expect(columnRoom(view, -400)).toBe(788);
    expect(columnRoom({ top: 40, height: 760 }, 0)).toBe(748);
  });

  it('gives it its floor in a window too short for it', () => {
    expect(columnRoom({ top: 0, height: 400 }, 230)).toBe(COLUMN_FLOOR);
  });
});

describe('gapsRoom', () => {
  it('gives the Gaps row what is left once the rest of Review, down to its last row, is in the window', () => {
    // The rows end 1010 pixels down the page with the Gaps row 400 high: the
    // rest takes 610, and the window holds 800.
    expect(gapsRoom(800, 1010, 400)).toBe(182);
    // As much however tall the Gaps row is now.
    expect(gapsRoom(800, 792, 182)).toBe(182);
  });

  it('gives it its floor when the rest already fills the window', () => {
    expect(gapsRoom(800, 900, 50)).toBe(GAPS_FLOOR);
  });
});

describe('scrollerOf', () => {
  it('finds the nearest ancestor that scrolls, or the document', () => {
    const panel = document.createElement('main');
    panel.style.overflowY = 'auto';
    const inner = document.createElement('div');
    const element = document.createElement('div');
    inner.append(element);
    panel.append(inner);
    document.body.append(panel);

    expect(scrollerOf(element)).toBe(panel);
    panel.style.overflowY = 'visible';
    expect(scrollerOf(element)).toBe(document.scrollingElement ?? document.documentElement);
    panel.remove();
  });
});

describe('useReviewRoom', () => {
  /** An element whose box is `top` to `bottom` in the window. */
  function boxed(top: number, bottom: number): HTMLDivElement {
    const element = document.createElement('div');
    element.getBoundingClientRect = () =>
      ({ top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect;
    document.body.append(element);
    return element;
  }

  it('measures the column, and the Gaps row only while it is bounded', () => {
    const review = { current: boxed(230, 1100) };
    const rows = { current: boxed(400, 1010) };
    const gaps = { current: boxed(450, 850) };
    const height = window.innerHeight;

    const bounded = renderHook(() => useReviewRoom({ review, rows, gaps }, true));
    expect(bounded.result.current).toEqual({
      column: height - 230,
      gaps: Math.max(GAPS_FLOOR, height - (1010 - 400) - 8),
    });

    const open = renderHook(() => useReviewRoom({ review, rows, gaps }, false));
    expect(open.result.current).toEqual({ column: height - 230 });
  });
});
