import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { forgeConfigSchema } from '@sandforge/shared';
import '../../i18n';
import { ForgeDepthChips, MAX_CUSTOM_DEPTH } from './ForgeDepthChips';

/** The chips with a custom depth of 3, and the spy that receives a typed depth. */
function renderCustom(onCustomDepthChange = vi.fn()) {
  render(
    <ForgeDepthChips
      depth="custom"
      customDepth={3}
      onDepthChange={vi.fn()}
      onCustomDepthChange={onCustomDepthChange}
      onDepthKeyDown={vi.fn()}
      depthRefs={{ current: {} }}
    />,
  );
  return onCustomDepthChange;
}

describe('ForgeDepthChips', () => {
  it('names the five-level depth by what it is, not a full tree a custom depth goes past', () => {
    // "Full tree" meant 5 levels, while Custom depth goes up to 10.
    render(
      <ForgeDepthChips
        depth="direct"
        customDepth={3}
        onDepthChange={vi.fn()}
        onCustomDepthChange={vi.fn()}
        onDepthKeyDown={vi.fn()}
        depthRefs={{ current: {} }}
      />,
    );
    expect(screen.getByTestId('forge-depth-full').textContent).toBe('Deep (5 levels)');
    expect(MAX_CUSTOM_DEPTH).toBeGreaterThan(5);
  });

  it('names the custom depth field', () => {
    // A number box with no label: a screen reader announced "spin button, 3".
    render(
      <ForgeDepthChips
        depth="custom"
        customDepth={3}
        onDepthChange={vi.fn()}
        onCustomDepthChange={vi.fn()}
        onDepthKeyDown={vi.fn()}
        depthRefs={{ current: {} }}
      />,
    );
    expect(screen.getByRole('spinbutton', { name: 'Custom depth' })).toBe(
      screen.getByTestId('forge-depth-custom-input'),
    );
  });

  it('caps a typed depth at the 10 levels discovery accepts', () => {
    // The field went up to 20, and discovery refused anything past 10.
    expect(forgeConfigSchema.shape.customDepth.safeParse(MAX_CUSTOM_DEPTH).success).toBe(true);
    expect(forgeConfigSchema.shape.customDepth.safeParse(MAX_CUSTOM_DEPTH + 1).success).toBe(false);

    const onCustomDepthChange = renderCustom();
    const input = screen.getByTestId('forge-depth-custom-input');
    expect(input.getAttribute('max')).toBe('10');

    fireEvent.change(input, { target: { value: '15' } });
    expect(onCustomDepthChange).toHaveBeenLastCalledWith(10);
    fireEvent.change(input, { target: { value: '7' } });
    expect(onCustomDepthChange).toHaveBeenLastCalledWith(7);
  });

  it('refuses 0, a decimal, a negative number and nothing, as the schema does, and says so', () => {
    // 0 and 2.5 were passed on as they were, and discovery refused them.
    for (const typed of ['0', '2.5', '-1', '']) {
      expect(forgeConfigSchema.shape.customDepth.safeParse(Number(typed)).success).toBe(false);
    }

    const onCustomDepthChange = renderCustom();
    const input = screen.getByTestId('forge-depth-custom-input') as HTMLInputElement;
    expect(input.getAttribute('step')).toBe('1');
    for (const typed of ['0', '2.5', '-1', '']) {
      fireEvent.change(input, { target: { value: typed } });
      expect({ typed, invalid: input.getAttribute('aria-invalid') }).toEqual({
        typed,
        invalid: 'true',
      });
      const error = screen.getByTestId('forge-depth-custom-error');
      expect(error.textContent).toBe('Enter a whole number from 1 to 10.');
      expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(error.id);
    }
    expect(onCustomDepthChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '4' } });
    expect(onCustomDepthChange).toHaveBeenLastCalledWith(4);
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(screen.queryByTestId('forge-depth-custom-error')).toBeNull();
  });

  it('shows the depth the run will use again once a refused value is left', () => {
    renderCustom();
    const input = screen.getByTestId('forge-depth-custom-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });
    expect(input.value).toBe('0');

    fireEvent.blur(input);
    expect(input.value).toBe('3');
    expect(screen.queryByTestId('forge-depth-custom-error')).toBeNull();
  });

  it('says under the field why the depth stops at 10', () => {
    renderCustom();
    const hint = screen.getByTestId('forge-depth-custom-hint');
    expect(hint.textContent).toContain('10');
    expect(hint.textContent).toContain('API');
    expect(screen.getByTestId('forge-depth-custom-input').getAttribute('aria-describedby')).toBe(
      hint.id,
    );
  });

  it('shows no hint when the depth is not custom', () => {
    render(
      <ForgeDepthChips
        depth="direct"
        customDepth={3}
        onDepthChange={vi.fn()}
        onCustomDepthChange={vi.fn()}
        onDepthKeyDown={vi.fn()}
        depthRefs={{ current: {} }}
      />,
    );
    expect(screen.queryByTestId('forge-depth-custom-hint')).toBeNull();
  });

  describe('ALL', () => {
    /** The chips with the given depth picked, and the spy that receives a picked depth. */
    function renderAt(depth: 'direct' | 'all', onDepthChange = vi.fn()) {
      render(
        <ForgeDepthChips
          depth={depth}
          customDepth={3}
          onDepthChange={onDepthChange}
          onCustomDepthChange={vi.fn()}
          onDepthKeyDown={vi.fn()}
          depthRefs={{ current: {} }}
        />,
      );
      return onDepthChange;
    }

    it('comes fourth, after Custom depth, named ALL, and says on hover what it copies', () => {
      const onDepthChange = renderAt('direct');

      const chips = screen.getAllByRole('radio');
      expect(chips.map((chip) => chip.getAttribute('data-testid'))).toEqual([
        'forge-depth-direct',
        'forge-depth-full',
        'forge-depth-custom',
        'forge-depth-all',
      ]);
      const all = screen.getByTestId('forge-depth-all');
      expect(all.textContent).toBe('ALL');
      expect(all.getAttribute('title')).toBe(
        'Every record of every object the source org lets Forge read and the target lets it create, files and emails included',
      );
      expect(all.getAttribute('aria-checked')).toBe('false');
      fireEvent.click(all);
      expect(onDepthChange).toHaveBeenCalledWith('all');
    });

    it('says under the chips, once picked, what it copies and what it leaves out', () => {
      renderAt('all');

      const hint = screen.getByTestId('forge-depth-all-hint');
      expect(hint.textContent).toBe(
        'ALL copies the whole source org: every object the target can create, every record of each, with no cap. Objects Salesforce does not let an API create are left out, and Review names them.',
      );
      const all = screen.getByTestId('forge-depth-all');
      expect(all.getAttribute('aria-checked')).toBe('true');
      expect(all.getAttribute('aria-describedby')).toBe(hint.id);
      // No number to type: ALL walks no relationship.
      expect(screen.queryByTestId('forge-depth-custom-input')).toBeNull();
    });

    it('says nothing of it while another depth is picked', () => {
      renderAt('direct');

      expect(screen.queryByTestId('forge-depth-all-hint')).toBeNull();
      expect(screen.getByTestId('forge-depth-all').hasAttribute('aria-describedby')).toBe(false);
    });
  });
});
