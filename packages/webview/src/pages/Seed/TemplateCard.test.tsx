import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { MINIMAL_DEMO } from '@sandforge/shared';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ptBR from '../../i18n/locales/pt-BR.json';
import ja from '../../i18n/locales/ja.json';
import { TemplateCard } from './TemplateCard';
import type { TemplateGalleryItem } from './useTemplateGallery';

const mockItem: TemplateGalleryItem = {
  id: 'prebuilt-sales-cloud-starter',
  name: 'seed.templates.salesCloudStarter.name',
  description: 'seed.templates.salesCloudStarter.description',
  objectCount: 7,
  totalRecords: 7601,
  tags: ['prebuilt', 'sales'],
  isPrebuilt: true,
  recommended: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
  template: null,
};

const savedItem: TemplateGalleryItem = {
  id: 'saved-1',
  name: 'My Custom Template',
  description: 'A custom template for testing',
  objectCount: 3,
  totalRecords: 500,
  tags: ['custom'],
  isPrebuilt: false,
  recommended: false,
  updatedAt: '2026-02-01T00:00:00.000Z',
  template: null,
};

describe('TemplateCard', () => {
  it('renders template name and description', () => {
    render(<TemplateCard item={mockItem} onUseThis={vi.fn()} />);

    expect(screen.getByText('Sales Cloud Starter')).toBeDefined();
    expect(screen.getByText(/products priced in the standard price book/)).toBeDefined();
  });

  it('displays correct object count and record count', () => {
    render(<TemplateCard item={mockItem} onUseThis={vi.fn()} />);

    expect(screen.getByText('7 objects')).toBeDefined();
    expect(screen.getByText('7601 records')).toBeDefined();
  });

  it('names its button after the template, as the visible words start it', () => {
    // Every card's button read "Use This": a list of buttons could not tell them apart.
    render(<TemplateCard item={mockItem} onUseThis={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Use this: Sales Cloud Starter' })).toBe(
      screen.getByTestId('btn-use-template'),
    );
    expect(screen.getByTestId('btn-use-template').textContent).toBe('Use this');
  });

  it('calls onUseThis with the item when Use This is clicked', () => {
    const onUseThis = vi.fn();
    render(<TemplateCard item={mockItem} onUseThis={onUseThis} />);

    fireEvent.click(screen.getByTestId('btn-use-template'));

    expect(onUseThis).toHaveBeenCalledTimes(1);
    expect(onUseThis).toHaveBeenCalledWith(mockItem);
  });

  it('renders saved template name as plain text', () => {
    render(<TemplateCard item={savedItem} onUseThis={vi.fn()} />);

    expect(screen.getByText('My Custom Template')).toBeDefined();
    expect(screen.getByText('A custom template for testing')).toBeDefined();
  });

  it('marks the template a first seed starts from, and no other', () => {
    const { unmount } = render(
      <TemplateCard item={{ ...mockItem, recommended: true }} onUseThis={vi.fn()} />,
    );
    expect(screen.getByTestId('template-recommended').textContent).toBe('Start here');
    unmount();

    render(<TemplateCard item={mockItem} onUseThis={vi.fn()} />);
    expect(screen.queryByTestId('template-recommended')).toBeNull();
  });

  it('shows the tags that tell a template apart, and not the one every built-in carries', () => {
    // Every card of the gallery said "prebuilt", which told none apart.
    render(<TemplateCard item={mockItem} onUseThis={vi.fn()} />);

    expect(screen.queryByText('prebuilt')).toBeNull();
    expect(screen.getByText('sales')).toBeDefined();
  });

  it('describes Minimal Demo by what it writes, in every language, as the other cards are', () => {
    // "Lightweight demo template ... Perfect for quick demos": it writes 350
    // records, more than CRM Starter, sized for a Developer Edition.
    const total = MINIMAL_DEMO.objects.reduce((sum, object) => sum + object.recordCount, 0);
    const accounts = MINIMAL_DEMO.objects.find((o) => o.objectApiName === 'Account')?.recordCount;
    const perAccount = (MINIMAL_DEMO.relations ?? []).map((relation) =>
      relation.distribution.mode === 'perParent' ? relation.distribution.count : undefined,
    );
    expect([total, accounts, perAccount]).toEqual([350, 50, [2, 4]]);

    for (const [language, catalogue] of Object.entries({ en, fr, de, es, 'pt-BR': ptBR, ja })) {
      const description = catalogue.seed.templates.minimalDemo.description;
      for (const figure of [String(total), String(accounts), '2', '4', '1 M']) {
        expect(description, `${language}: ${figure}`).toContain(figure);
      }
    }
    render(
      <TemplateCard
        item={{
          ...mockItem,
          id: MINIMAL_DEMO.id,
          name: MINIMAL_DEMO.name,
          description: MINIMAL_DEMO.description,
        }}
        onUseThis={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        '50 accounts, each with 2 contacts and 4 opportunities: 350 records, under 1 MB.',
      ),
    ).toBeDefined();
  });

  it('keeps the tags of a saved template', () => {
    render(<TemplateCard item={savedItem} onUseThis={vi.fn()} />);

    expect(screen.getByText('custom')).toBeDefined();
  });
});
