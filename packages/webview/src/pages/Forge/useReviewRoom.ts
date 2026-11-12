import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * How much of the window Review's parts may take, beside the rows, for every
 * row of Review, Controls and Execute to stay in sight.
 *
 * Measured, not set: the rows and the column are as tall as their words, and
 * their words are not as long in every language. At 1280 by 800 the column of
 * the run ran 90 pixels past the window in French, German, Spanish and
 * Portuguese, Controls under the foot that holds Execute; and on the eleven
 * gaps the trap org gave a clone, the Gaps row pushed Metadata and Automation
 * under the fold in every language.
 */
export interface ReviewRoom {
  /**
   * The column's height: from where it stands in the window — where the page
   * puts it, or where it sticks once the page is scrolled — to the window's
   * bottom.
   */
  column?: number;
  /**
   * The Gaps row's height, while it is the one row open: what the window
   * holds at the top of the page once the rest of Review, down to its last
   * row, is in it.
   */
  gaps?: number;
}

/** Where the column sticks once the page is scrolled: its `top-3`. */
const STICKY_TOP = 12;

/** Pixels kept between the last row and the bottom of the window. */
const ROWS_MARGIN = 8;

/** The least the column takes, however short the window: below it, it runs past the window. */
export const COLUMN_FLOOR = 320;

/** The least the gaps take, however short the window: the heading of the gravest, a gap and its decision. */
export const GAPS_FLOOR = 120;

/** What the window shows of what scrolls the page: its top, in the window, and its height. */
export interface ScrollView {
  top: number;
  height: number;
}

/**
 * {@link ReviewRoom.column} for a column whose top is at `columnTop` in the
 * window: where the page puts it, until the page scrolls it to where it sticks.
 * Down to the window's bottom, where the foot that holds Execute stood when it
 * stuck there.
 */
export function columnRoom(view: ScrollView, columnTop: number): number {
  const top = Math.max(columnTop, view.top + STICKY_TOP);
  return Math.max(COLUMN_FLOOR, Math.floor(view.top + view.height - top));
}

/**
 * {@link ReviewRoom.gaps} for rows whose bottom is `rowsBottom` pixels down
 * the page, its top, the Gaps row taking `gapsHeight` of them: the rest stays
 * as tall whatever the Gaps row is given.
 */
export function gapsRoom(viewHeight: number, rowsBottom: number, gapsHeight: number): number {
  return Math.max(GAPS_FLOOR, Math.floor(viewHeight - (rowsBottom - gapsHeight) - ROWS_MARGIN));
}

/** What scrolls `element`: its nearest ancestor that scrolls, or the document. */
export function scrollerOf(element: Element): Element {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === 'auto' || overflowY === 'scroll') return at;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** Whether `scroller` is the document's own scrolling, which the window scrolls. */
function isDocument(scroller: Element): boolean {
  return scroller === document.scrollingElement || scroller === document.documentElement;
}

/** What the window shows of `scroller`. */
function viewOf(scroller: Element): ScrollView {
  if (isDocument(scroller)) return { top: 0, height: window.innerHeight };
  return {
    top: scroller.getBoundingClientRect().top + scroller.clientTop,
    height: scroller.clientHeight,
  };
}

/** The parts of Review measured. */
export interface ReviewParts {
  /** What holds the rows and the column: the column starts where it does. */
  review: RefObject<HTMLElement | null>;
  /** The rows. */
  rows: RefObject<HTMLElement | null>;
  /** What the Gaps row shows when open. */
  gaps: RefObject<HTMLElement | null>;
}

/**
 * {@link ReviewRoom} of Review's parts, measured again as the window, the page
 * or the rows change size, and as the page scrolls.
 *
 * @param boundGaps - Whether the Gaps row is open alone: with another row
 *   open, the rows run past the window whatever the gaps take, and theirs is
 *   left as tall as it is.
 */
export function useReviewRoom(parts: ReviewParts, boundGaps: boolean): ReviewRoom {
  const [room, setRoom] = useState<ReviewRoom>({});
  const { review: reviewRef, rows: rowsRef, gaps: gapsRef } = parts;
  useLayoutEffect(() => {
    const review = reviewRef.current;
    if (!review) return undefined;
    const scroller = scrollerOf(review);
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const view = viewOf(scroller);
      const column = columnRoom(view, review.getBoundingClientRect().top);
      const rows = rowsRef.current;
      const body = gapsRef.current;
      let gaps: number | undefined;
      if (boundGaps && rows && body) {
        const scrolled = isDocument(scroller) ? window.scrollY : scroller.scrollTop;
        const rowsBottom = rows.getBoundingClientRect().bottom - view.top + scrolled;
        gaps = gapsRoom(view.height, rowsBottom, body.getBoundingClientRect().height);
      }
      setRoom((was) =>
        was.column === column && was.gaps === gaps
          ? was
          : { column, ...(gaps !== undefined ? { gaps } : {}) },
      );
    };
    const later = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    // What is above Review — the How to opened, a notice — moves it down
    // without changing its size: the page it is in changes size.
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => later());
    for (const element of [review, rowsRef.current, scroller.firstElementChild]) {
      if (element) observer?.observe(element);
    }
    const scrolling: EventTarget = isDocument(scroller) ? window : scroller;
    scrolling.addEventListener('scroll', later, { passive: true });
    window.addEventListener('resize', later);
    return () => {
      observer?.disconnect();
      scrolling.removeEventListener('scroll', later);
      window.removeEventListener('resize', later);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [reviewRef, rowsRef, gapsRef, boundGaps]);
  return room;
}
