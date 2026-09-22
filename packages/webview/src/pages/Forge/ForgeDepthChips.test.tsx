import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { ForgeDepthChips } from './ForgeDepthChips';

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
});
