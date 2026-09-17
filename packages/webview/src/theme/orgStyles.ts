/** Unified org type badge color styles. */
export const ORG_TYPE_STYLES: Record<string, string> = {
  Production: 'bg-red-500/10 text-status-error border-red-500/30',
  Sandbox: 'bg-blue-500/10 text-status-info border-blue-500/30',
  Scratch: 'bg-purple-500/10 text-hue-purple border-purple-500/30',
  Developer: 'bg-green-500/10 text-status-success border-green-500/30',
};

/** Default style for unknown org types. */
export const ORG_TYPE_STYLE_DEFAULT = 'bg-gray-500/10 text-text-primary border-gray-500/30';
