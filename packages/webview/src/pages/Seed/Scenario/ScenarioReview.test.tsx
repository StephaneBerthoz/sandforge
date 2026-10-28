import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RETAIL_ORDERS_PACK } from '@sandforge/shared';
import '../../../i18n';
import { ScenarioReview, type ScenarioReviewProps } from './ScenarioReview';

function renderReview(props: Partial<ScenarioReviewProps> = {}) {
  const handlers = {
    onEdit: vi.fn(),
    onSave: vi.fn(),
    onContinue: vi.fn(),
    onBack: vi.fn(),
  };
  render(
    <ScenarioReview
      pack={RETAIL_ORDERS_PACK}
      source={{ kind: 'built-in' }}
      mustSave={false}
      saving={false}
      saved={null}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('ScenarioReview', () => {
  it('shows each topic with its article, what an answer must say and what customers say', () => {
    renderReview();

    const topics = screen.getByTestId('scenario-review-topics');
    const first = RETAIL_ORDERS_PACK.topics[0];
    expect(topics.textContent).toContain(`${first.label}: ${first.article.title}`);
    expect(topics.textContent).toContain(first.article.facts[0]);
    expect(topics.textContent).toContain(first.utterances[0].expectedOutcome);
    expect(screen.getByTestId('scenario-review').textContent).toContain(
      'Shipped with SandForge, its content in English',
    );
  });

  it('names the field an edit breaks, and keeps the pack as it was', () => {
    const { onEdit } = renderReview();
    fireEvent.click(screen.getByTestId('btn-scenario-edit'));
    const broken = { ...RETAIL_ORDERS_PACK, id: 'Not A Key' };
    fireEvent.change(screen.getByTestId('scenario-review-text'), {
      target: { value: JSON.stringify(broken) },
    });

    fireEvent.click(screen.getByTestId('btn-scenario-apply'));

    expect(screen.getByTestId('scenario-review-problems').textContent).toMatch(/^.*id: /);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('takes an edit that holds', () => {
    const { onEdit } = renderReview();
    fireEvent.click(screen.getByTestId('btn-scenario-edit'));
    const edited = { ...RETAIL_ORDERS_PACK, name: 'Our shop' };
    fireEvent.change(screen.getByTestId('scenario-review-text'), {
      target: { value: JSON.stringify(edited) },
    });

    fireEvent.click(screen.getByTestId('btn-scenario-apply'));

    expect(onEdit).toHaveBeenCalledWith(edited);
  });

  it('keeps a pack drafted or edited from its seed until it is saved, saying why', () => {
    const { onContinue } = renderReview({ mustSave: true, source: { kind: 'draft' } });

    const next = screen.getByTestId('btn-scenario-continue') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(next.getAttribute('aria-describedby')).toBe('scenario-review-must-save');
    expect(screen.getByText(/Save the scenario in the workspace first/)).toBeTruthy();
    fireEvent.click(next);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('offers to write over a file of the pack’s name only once one is there', () => {
    const { onSave } = renderReview({
      saved: {
        kind: 'exists',
        path: '/ws/retail-orders.sandforge-scenario.json',
        relativePath: 'retail-orders.sandforge-scenario.json',
      },
    });

    expect(screen.getByTestId('scenario-review-saved').textContent).toBe(
      'retail-orders.sandforge-scenario.json is there already.',
    );
    fireEvent.click(screen.getByTestId('btn-scenario-overwrite'));
    expect(onSave).toHaveBeenCalledWith(true);
  });
});
