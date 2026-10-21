/// <reference types="vite/client" />

/** Build-time version injected by Vite define config. */
declare const __APP_VERSION__: string;

/**
 * The loaders of the English catalogue's namespaces, one module each
 * (`englishCatalogue` in vite.config.ts).
 */
declare module 'virtual:english-catalogue' {
  export const englishNamespaceLoaders: Readonly<
    Record<string, () => Promise<{ default: Record<string, unknown> }>>
  >;
}
