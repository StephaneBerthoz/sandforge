/**
 * Unified org type badge color styles. The tint and the border come from the
 * same token as the text, so the three follow the theme together.
 */
export const ORG_TYPE_STYLES: Record<string, string> = {
  Production: 'bg-status-error/10 text-status-error border-status-error/30',
  Sandbox: 'bg-status-info/10 text-status-info border-status-info/30',
  Scratch: 'bg-hue-purple/10 text-hue-purple border-hue-purple/30',
  Developer: 'bg-status-success/10 text-status-success border-status-success/30',
};

/**
 * Default style for unknown org types. The neutral tokens carry no alpha
 * channel, so the tint is mixed from the description foreground in place.
 */
export const ORG_TYPE_STYLE_DEFAULT =
  'bg-[color-mix(in_srgb,var(--sf-text-secondary)_10%,transparent)] text-text-primary border-subtle';
