/** Unified org type badge color styles. */
export const ORG_TYPE_STYLES: Record<string, string> = {
  Production: 'bg-red-500/20 text-red-400 border-red-500/30',
  Sandbox: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  Scratch: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  Developer: 'bg-green-500/20 text-green-400 border-green-500/30',
};

/** Default style for unknown org types. */
export const ORG_TYPE_STYLE_DEFAULT = 'bg-gray-500/20 text-gray-400 border-gray-500/30';
