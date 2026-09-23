import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { DiffGroupAccordion } from './DiffGroupAccordion';
import type { EnrichedDiff } from '@sandforge/shared';

/* jsdom gives every element a zero height, so the real virtualizer would report
   an empty window and render nothing. Same stand-in as VirtualList.test.tsx. */
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number; overscan: number }) => {
    const rowHeight = opts.estimateSize();
    const overscan = opts.overscan ?? 5;
    const visibleCount = Math.min(opts.count, 10 + overscan * 2);
    const items: Array<{ index: number; start: number; size: number }> = [];
    for (let i = 0; i < visibleCount; i++) {
      items.push({ index: i, start: i * rowHeight, size: rowHeight });
    }
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * rowHeight,
    };
  },
}));

function createDiff(overrides: Partial<EnrichedDiff> = {}): EnrichedDiff {
  return {
    category: 'ApexClass',
    changeType: 'modified',
    name: 'AccountController',
    riskLevel: 'medium',
    riskReasons: ['breaking'],
    group: 'Apex Code',
    dependencies: ['ApexTrigger', 'Flow'],
    ...overrides,
  };
}

describe('DiffGroupAccordion', () => {
  it('should render empty state when no diffs', () => {
    render(<DiffGroupAccordion diffs={[]} />);
    expect(screen.getByTestId('no-diffs')).toBeDefined();
  });

  it('says nothing differs when a comparison found no difference, not that none has run', () => {
    // The accordion is only mounted once a comparison has answered.
    render(<DiffGroupAccordion diffs={[]} />);
    const text = screen.getByTestId('no-diffs').textContent ?? '';
    expect(text).toMatch(/^Nothing differs: both orgs hold the same components/);
    expect(text).not.toMatch(/yet/i);
  });

  it('should render groups from diffs', () => {
    const diffs = [
      createDiff({ group: 'Apex Code' }),
      createDiff({ group: 'Data Model', category: 'CustomField', name: 'Account.Field__c' }),
    ];
    render(<DiffGroupAccordion diffs={diffs} />);
    expect(screen.getByTestId('diff-group-Apex Code')).toBeDefined();
    expect(screen.getByTestId('diff-group-Data Model')).toBeDefined();
  });

  it('should sort groups by highest risk first', () => {
    const diffs = [
      createDiff({ group: 'Configuration', riskLevel: 'low' }),
      createDiff({ group: 'Apex Code', riskLevel: 'critical' }),
    ];
    render(<DiffGroupAccordion diffs={diffs} />);
    const groups = screen.getByTestId('diff-groups');
    // Use toggle buttons to identify group order (they have unique testids)
    const toggleButtons = groups.querySelectorAll('[data-testid^="diff-group-toggle-"]');
    expect(toggleButtons[0].getAttribute('data-testid')).toBe('diff-group-toggle-Apex Code');
    expect(toggleButtons[1].getAttribute('data-testid')).toBe('diff-group-toggle-Configuration');
  });

  it('should show group change counts', () => {
    const diffs = [
      createDiff({ group: 'Apex Code', changeType: 'added' }),
      createDiff({ group: 'Apex Code', changeType: 'removed', name: 'OldClass' }),
      createDiff({ group: 'Apex Code', changeType: 'removed', name: 'OtherClass' }),
      createDiff({ group: 'Apex Code', changeType: 'modified', name: 'ModClass' }),
    ];
    render(<DiffGroupAccordion diffs={diffs} />);
    expect(screen.getByText('4 changes')).toBeDefined();
    expect(screen.getByText('2+')).toBeDefined();
    expect(screen.getByText('1-')).toBeDefined();
    expect(screen.getByText('1~')).toBeDefined();
  });

  it('counts what only the source holds as additions, in green, ahead of what only the target holds', () => {
    // `removed` is only in the source: a deployment creates it. The header
    // counted it under a red minus, and what only the target holds under a
    // green plus.
    const diffs = [
      createDiff({ group: 'G', changeType: 'removed', name: 'SourceOnly' }),
      createDiff({ group: 'G', changeType: 'removed', name: 'SourceOnlyToo' }),
      createDiff({ group: 'G', changeType: 'added', name: 'TargetOnly' }),
      createDiff({ group: 'G', changeType: 'modified', name: 'Both' }),
    ];
    render(<DiffGroupAccordion diffs={diffs} />);

    const header = screen.getByTestId('diff-group-toggle-G');
    const counts = Array.from(header.querySelectorAll('span[class*="bg-status-"]')).map((badge) => [
      badge.textContent,
      badge.className.match(/bg-status-(\w+)/)?.[1],
    ]);
    expect(counts.slice(0, 3)).toEqual([
      ['2+', 'success'],
      ['1-', 'error'],
      ['1~', 'warning'],
    ]);
  });

  it('should show max risk badge for group', () => {
    const diffs = [
      createDiff({ group: 'Apex Code', riskLevel: 'low' }),
      createDiff({ group: 'Apex Code', riskLevel: 'high', name: 'HighRisk' }),
    ];
    render(<DiffGroupAccordion diffs={diffs} />);
    // The group header should show the max risk level
    const groupHeader = screen.getByTestId('diff-group-toggle-Apex Code');
    expect(groupHeader.textContent).toContain('High risk');
  });

  it('should expand and collapse groups', () => {
    const diffs = [createDiff({ name: 'TestClass' })];
    render(<DiffGroupAccordion diffs={diffs} />);

    // Initially collapsed
    expect(screen.queryByTestId('diff-group-items-Apex Code')).toBeNull();

    // Expand
    fireEvent.click(screen.getByTestId('diff-group-toggle-Apex Code'));
    expect(screen.getByTestId('diff-group-items-Apex Code')).toBeDefined();
    expect(screen.getByTestId('diff-item-TestClass')).toBeDefined();

    // Collapse
    fireEvent.click(screen.getByTestId('diff-group-toggle-Apex Code'));
    expect(screen.queryByTestId('diff-group-items-Apex Code')).toBeNull();
  });

  it('should display diff item details when expanded', () => {
    const diffs = [
      createDiff({
        name: 'AccountController',
        category: 'ApexClass',
        changeType: 'modified',
        riskLevel: 'medium',
        dependencies: ['ApexTrigger', 'Flow'],
      }),
    ];
    render(<DiffGroupAccordion diffs={diffs} />);

    fireEvent.click(screen.getByTestId('diff-group-toggle-Apex Code'));
    expect(screen.getByText('AccountController')).toBeDefined();
    // Category, change type, risk level, and deps appear in diff item
    const diffItem = screen.getByTestId('diff-item-AccountController');
    expect(diffItem.textContent).toContain('ApexClass');
    expect(diffItem.textContent).toContain('Modified');
    expect(diffItem.textContent).toContain('Medium risk');
    expect(diffItem.textContent).toContain('2 dependencies');
  });

  it('should call onSelectDiff when diff item is clicked', () => {
    const onSelect = vi.fn();
    const diff = createDiff({ name: 'TestClass' });
    render(<DiffGroupAccordion diffs={[diff]} onSelectDiff={onSelect} />);

    fireEvent.click(screen.getByTestId('diff-group-toggle-Apex Code'));
    fireEvent.click(screen.getByTestId('diff-item-TestClass'));
    expect(onSelect).toHaveBeenCalledWith(diff);
  });

  it('should show change type symbols', () => {
    const diffs = [
      createDiff({ name: 'Added', changeType: 'added', group: 'G' }),
      createDiff({ name: 'Removed', changeType: 'removed', group: 'G' }),
      createDiff({ name: 'Modified', changeType: 'modified', group: 'G' }),
    ];
    render(<DiffGroupAccordion diffs={diffs} />);

    fireEvent.click(screen.getByTestId('diff-group-toggle-G'));
    expect(screen.getByText('+')).toBeDefined();
    expect(screen.getByText('-')).toBeDefined();
    expect(screen.getByText('~')).toBeDefined();
  });

  it('names a change once to a screen reader, and paints its symbol in the severity token', () => {
    const diffs = [
      createDiff({ name: 'Added', changeType: 'added', group: 'G' }),
      createDiff({ name: 'Removed', changeType: 'removed', group: 'G' }),
      createDiff({ name: 'Modified', changeType: 'modified', group: 'G' }),
    ];
    render(<DiffGroupAccordion diffs={diffs} />);
    fireEvent.click(screen.getByTestId('diff-group-toggle-G'));

    // The badge beside the symbol already names the change: the symbol is not read out.
    const row = screen.getByTestId('diff-item-Added');
    expect(row.textContent).toContain('Only in the target');
    // Read as a deployment would: what only the source holds (`removed`) is
    // what it adds, what only the target holds (`added`) what it leaves.
    for (const [name, symbol, token, badge] of [
      ['Removed', '+', 'text-status-success', 'bg-status-success'],
      ['Added', '-', 'text-status-error', 'bg-status-error'],
      ['Modified', '~', 'text-status-warning', 'bg-status-warning'],
    ]) {
      const item = screen.getByTestId(`diff-item-${name}`);
      const glyph = item.querySelector('[aria-hidden="true"]') as HTMLElement;
      expect(glyph.textContent).toBe(symbol);
      // The raw theme colour read 1.8:1 on a light editor; the token is sized for AA.
      expect(glyph.classList.contains(token)).toBe(true);
      expect(glyph.style.color).toBe('');
      expect(item.querySelector(`.${badge}`)).not.toBeNull();
    }
  });

  it('names each change and its risk in the language of the page', async () => {
    // Both badges wrote the codes as they are, "removed" and "critical", in
    // English whatever the language.
    i18n.addResourceBundle('fr', 'translation', fr);
    await i18n.changeLanguage('fr');
    try {
      render(
        <DiffGroupAccordion
          diffs={[
            createDiff({ name: 'SourceOnly', changeType: 'removed', riskLevel: 'low' }),
            createDiff({ name: 'TargetOnly', changeType: 'added', riskLevel: 'critical' }),
          ]}
        />,
      );
      const header = screen.getByTestId('diff-group-toggle-Apex Code');
      expect(header.textContent).toContain('Risque critique');
      fireEvent.click(header);
      const sourceOnly = screen.getByTestId('diff-item-SourceOnly').textContent;
      const targetOnly = screen.getByTestId('diff-item-TargetOnly').textContent;
      expect(sourceOnly).toContain('Seulement dans la source');
      expect(sourceOnly).toContain('Risque faible');
      expect(targetOnly).toContain('Seulement dans la cible');
      expect(targetOnly).toContain('Risque critique');
      expect(`${sourceOnly} ${targetOnly}`).not.toMatch(/removed|added|low|critical/);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('should virtualize a large group instead of mounting every diff row', () => {
    const diffs = Array.from({ length: 500 }, (_, i) =>
      createDiff({ name: `Class${i}`, group: 'Apex Code' }),
    );
    render(<DiffGroupAccordion diffs={diffs} />);

    fireEvent.click(screen.getByTestId('diff-group-toggle-Apex Code'));

    // The header still accounts for all 500, but only a window of rows is mounted.
    expect(screen.getByText('500 changes')).toBeDefined();
    const rows = screen
      .getByTestId('diff-group-items-Apex Code')
      .querySelectorAll('[data-testid^="diff-item-"]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(50);
  });

  it('should render multiple groups independently', () => {
    const diffs = [
      createDiff({ name: 'ApexItem', group: 'Apex Code' }),
      createDiff({ name: 'FieldItem', group: 'Data Model', category: 'CustomField' }),
    ];
    render(<DiffGroupAccordion diffs={diffs} />);

    // Expand only Apex Code
    fireEvent.click(screen.getByTestId('diff-group-toggle-Apex Code'));
    expect(screen.getByTestId('diff-group-items-Apex Code')).toBeDefined();
    expect(screen.queryByTestId('diff-group-items-Data Model')).toBeNull();

    // Expand Data Model too
    fireEvent.click(screen.getByTestId('diff-group-toggle-Data Model'));
    expect(screen.getByTestId('diff-group-items-Data Model')).toBeDefined();
    expect(screen.getByTestId('diff-group-items-Apex Code')).toBeDefined();
  });
});
