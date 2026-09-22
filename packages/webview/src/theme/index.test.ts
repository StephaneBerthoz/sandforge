import { describe, it, expect } from 'vitest';
import { cn, vsCodeTokens } from './index';

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
    const result = cn({ 'text-status-error': true, 'text-status-info': false });
    expect(result).toBe('text-status-error');
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
    expect(vsCodeTokens.success).toContain('--vscode-testing-iconPassed');
  });

  it('resolves every colour through a VS Code variable, a hex only as its fallback', () => {
    for (const [name, value] of Object.entries(vsCodeTokens)) {
      expect(value, name).toMatch(/^var\(--vscode-[\w-]+, #[0-9a-fA-F]{3,8}\)$/);
    }
  });
});
