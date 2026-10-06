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
});
