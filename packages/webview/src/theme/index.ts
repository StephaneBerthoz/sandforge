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
  success: '#4ec9b0',
  successBg: '#1a3a2a',
} as const;

/** Safety tier color configuration for org indicators. */
export const safetyTierColors = {
  critical: { bg: '#991b1b', fg: '#fecaca', border: '#f87171', label: '#ef4444' },
  high: { bg: '#92400e', fg: '#fef3c7', border: '#f59e0b', label: '#f59e0b' },
  medium: { bg: '#1e40af', fg: '#dbeafe', border: '#3b82f6', label: '#3b82f6' },
  low: { bg: '#065f46', fg: '#d1fae5', border: '#10b981', label: '#10b981' },
} as const;

/** Module color map for consistent UI theming per module. */
export const moduleColors = {
  forge: '#F97316',
  grappe: '#6366F1',
  monitor: '#EAB308',
  compare: '#A855F7',
  dataops: '#06B6D4',
  automation: '#F43F5E',
} as const;
