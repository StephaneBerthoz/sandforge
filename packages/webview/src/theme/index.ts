import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes with clsx, resolving conflicts via tailwind-merge. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * VSCode CSS variable tokens mapped for Tailwind consumption.
 * Used as CSS custom properties: `var(--sf-bg-primary)`.
 */
export const vsCodeTokens = {
  // Backgrounds
  bgPrimary: 'var(--vscode-editor-background, #1e1e1e)',
  bgSecondary: 'var(--vscode-sideBar-background, #252526)',
  bgTertiary: 'var(--vscode-editorGroupHeader-tabsBackground, #2d2d2d)',
  bgInput: 'var(--vscode-input-background, #3c3c3c)',
  bgHover: 'var(--vscode-list-hoverBackground, #2a2d2e)',
  bgActive: 'var(--vscode-list-activeSelectionBackground, #094771)',
  bgBadge: 'var(--vscode-badge-background, #4d4d4d)',

  // Foregrounds
  fgPrimary: 'var(--vscode-editor-foreground, #d4d4d4)',
  fgSecondary: 'var(--vscode-descriptionForeground, #868686)',
  fgMuted: 'var(--vscode-disabledForeground, #6b6b6b)',
  fgLink: 'var(--vscode-textLink-foreground, #3794ff)',
  fgBadge: 'var(--vscode-badge-foreground, #ffffff)',
  fgActive: 'var(--vscode-list-activeSelectionForeground, #ffffff)',

  // Borders
  border: 'var(--vscode-panel-border, #3c3c3c)',
  borderFocused: 'var(--vscode-focusBorder, #007fd4)',
  borderInput: 'var(--vscode-input-border, #3c3c3c)',

  // Buttons
  btnPrimaryBg: 'var(--vscode-button-background, #0e639c)',
  btnPrimaryFg: 'var(--vscode-button-foreground, #ffffff)',
  btnPrimaryHoverBg: 'var(--vscode-button-hoverBackground, #1177bb)',
  btnSecondaryBg: 'var(--vscode-button-secondaryBackground, #3a3d41)',
  btnSecondaryFg: 'var(--vscode-button-secondaryForeground, #ffffff)',
  btnSecondaryHoverBg: 'var(--vscode-button-secondaryHoverBackground, #45494e)',

  // Status colors
  error: 'var(--vscode-errorForeground, #f48771)',
  errorBg: 'var(--vscode-inputValidation-errorBackground, #5a1d1d)',
  warning: 'var(--vscode-editorWarning-foreground, #cca700)',
  warningBg: 'var(--vscode-inputValidation-warningBackground, #352a05)',
  info: 'var(--vscode-editorInfo-foreground, #3794ff)',
  infoBg: 'var(--vscode-inputValidation-infoBackground, #063b49)',
  // VS Code names no success background, so there is no successBg to follow.
  success: 'var(--vscode-testing-iconPassed, #4ec9b0)',
} as const;
