import { describe, it, expect, vi } from 'vitest';
import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { handleTabListKeyDown, tabForKey } from './tabListKeys';

const IDS = ['plan', 'anonymization', 'gaps', 'controls'] as const;

describe('tabForKey', () => {
  it('moves right and left, wrapping at the ends', () => {
    expect(tabForKey('ArrowRight', IDS, 'plan')).toBe('anonymization');
    expect(tabForKey('ArrowRight', IDS, 'controls')).toBe('plan');
    expect(tabForKey('ArrowLeft', IDS, 'plan')).toBe('controls');
  });

  it('goes to the first and the last tab on Home and End', () => {
    expect(tabForKey('Home', IDS, 'gaps')).toBe('plan');
    expect(tabForKey('End', IDS, 'plan')).toBe('controls');
  });

  it('steps over a disabled tab, and never lands on one', () => {
    const disabled = new Set(['anonymization', 'controls']);
    expect(tabForKey('ArrowRight', IDS, 'plan', disabled)).toBe('gaps');
    expect(tabForKey('ArrowRight', IDS, 'gaps', disabled)).toBe('plan');
    expect(tabForKey('End', IDS, 'plan', disabled)).toBe('gaps');
  });

  it('leaves every other key to the page', () => {
    expect(tabForKey('Enter', IDS, 'plan')).toBeNull();
    expect(tabForKey('Tab', IDS, 'plan')).toBeNull();
  });
});

/** A bar built by hand, as a page builds one, keyed through the helper. */
function Bar({ onSelect }: { onSelect: (id: string) => void }): React.ReactElement {
  const [active, setActive] = useState<string>('plan');
  const select = (id: string): void => {
    setActive(id);
    onSelect(id);
  };
  return (
    <div role="tablist">
      {IDS.map((id) => (
        <button
          key={id}
          role="tab"
          aria-selected={active === id}
          tabIndex={active === id ? 0 : -1}
          onKeyDown={(event) => handleTabListKeyDown(event, IDS, active, select)}
        >
          {id}
        </button>
      ))}
    </div>
  );
}

describe('handleTabListKeyDown', () => {
  it('selects the tab an arrow moves to and hands it the focus', () => {
    const onSelect = vi.fn();
    render(<Bar onSelect={onSelect} />);
    const plan = screen.getByRole('tab', { name: 'plan' });
    plan.focus();
    fireEvent.keyDown(plan, { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenCalledWith('controls');
    const controls = screen.getByRole('tab', { name: 'controls' });
    expect(document.activeElement).toBe(controls);
    expect(controls.getAttribute('aria-selected')).toBe('true');
    expect(controls.tabIndex).toBe(0);
    expect(plan.tabIndex).toBe(-1);
  });

  it('does nothing on a key the pattern does not name', () => {
    const onSelect = vi.fn();
    render(<Bar onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'plan' }), { key: 'a' });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
