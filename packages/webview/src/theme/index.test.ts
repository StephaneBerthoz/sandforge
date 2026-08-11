import { describe, it, expect } from 'vitest';
import { cn, vsCodeTokens, safetyTierColors, moduleColors } from './index';

describe('cn', () => {
  it('should merge simple classes', () => {
    expect(cn('px-2', 'py-1')).toBe('px-2 py-1');
  });

  it('should resolve conflicting Tailwind classes', () => {
    const result = cn('px-2', 'px-4');
    expect(result).toBe('px-4');
  });

  it('should handle conditional classes via clsx', () => {
    // `false && 'x'` collapses to `false` — feed the falsy value directly
    // (constant-binary expressions are lint-gated).
    const result = cn('base', false, 'visible');
    expect(result).toBe('base visible');
  });

  it('should handle undefined and null inputs', () => {
    const result = cn('base', undefined, null, 'end');
    expect(result).toBe('base end');
  });

  it('should handle object syntax', () => {
    const result = cn({ 'text-red-500': true, 'text-blue-500': false });
    expect(result).toBe('text-red-500');
  });
});

describe('vsCodeTokens', () => {
  it('should have background tokens', () => {
    expect(vsCodeTokens.bgPrimary).toContain('--vscode-editor-background');
    expect(vsCodeTokens.bgSecondary).toContain('--vscode-sideBar-background');
  });

  it('should have foreground tokens', () => {
    expect(vsCodeTokens.fgPrimary).toContain('--vscode-editor-foreground');
    expect(vsCodeTokens.fgSecondary).toContain('--vscode-descriptionForeground');
  });

  it('should have button tokens', () => {
    expect(vsCodeTokens.btnPrimaryBg).toContain('--vscode-button-background');
  });

  it('should have status tokens', () => {
    expect(vsCodeTokens.error).toContain('--vscode-errorForeground');
    expect(vsCodeTokens.warning).toContain('--vscode-editorWarning-foreground');
  });
});

describe('safetyTierColors', () => {
  it('should define all four tiers', () => {
    expect(Object.keys(safetyTierColors)).toEqual(['critical', 'high', 'medium', 'low']);
  });

  it('should have bg, fg, border, label for each tier', () => {
    for (const tier of Object.values(safetyTierColors)) {
      expect(tier).toHaveProperty('bg');
      expect(tier).toHaveProperty('fg');
      expect(tier).toHaveProperty('border');
      expect(tier).toHaveProperty('label');
    }
  });
});

describe('moduleColors', () => {
  it('should define colors for all seven modules including forge', () => {
    expect(Object.keys(moduleColors)).toEqual([
      'forge',
      'grappe',
      'monitor',
      'compare',
      'dataops',
      'automation',
    ]);
  });

  it('should have hex color values', () => {
    for (const color of Object.values(moduleColors)) {
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
