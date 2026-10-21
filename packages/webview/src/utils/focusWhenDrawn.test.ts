import { describe, it, expect, afterEach, vi } from 'vitest';
import { focusWhenDrawn } from './focusWhenDrawn';

/** A root to draw into, attached to the document. */
function root(): HTMLElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

function button(id: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.dataset.testid = id;
  return element;
}

const find = (container: HTMLElement) => (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-testid="target"]');

/** Let the MutationObserver's callbacks run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('focusWhenDrawn', () => {
  it('focuses a control already drawn', () => {
    const container = root();
    const target = button('target');
    container.appendChild(target);
    focusWhenDrawn(container, find(container));
    expect(document.activeElement).toBe(target);
  });

  it('waits for a control drawn later, then focuses it', async () => {
    const container = root();
    focusWhenDrawn(container, find(container));
    const target = button('target');
    container.appendChild(target);
    await settle();
    expect(document.activeElement).toBe(target);
  });

  it('leaves the focus where the user put it while it waited', async () => {
    const container = root();
    const elsewhere = button('elsewhere');
    document.body.appendChild(elsewhere);
    focusWhenDrawn(container, find(container));
    elsewhere.focus();
    container.appendChild(button('target'));
    await settle();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('gives up after its wait, and focuses nothing drawn after it', async () => {
    vi.useFakeTimers();
    const container = root();
    focusWhenDrawn(container, find(container), 1000);
    vi.advanceTimersByTime(1001);
    vi.useRealTimers();
    container.appendChild(button('target'));
    await settle();
    expect(document.activeElement).toBe(document.body);
  });

  it('stops waiting when told to', async () => {
    const container = root();
    const stop = focusWhenDrawn(container, find(container));
    stop();
    container.appendChild(button('target'));
    await settle();
    expect(document.activeElement).toBe(document.body);
  });
});
