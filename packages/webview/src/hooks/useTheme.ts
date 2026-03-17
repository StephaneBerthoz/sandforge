import { useState, useEffect } from 'react';

/** VSCode theme kinds exposed to the webview. */
export type ThemeKind = 'dark' | 'light' | 'high-contrast';

/**
 * Read the current VSCode theme kind from the body dataset attribute.
 *
 * VSCode sets `data-vscode-theme-kind` on `<body>` with values like
 * `vscode-dark`, `vscode-light`, `vscode-high-contrast`, or
 * `vscode-high-contrast-light`.
 */
function detectTheme(): ThemeKind {
  const kind = document.body.dataset.vscodeThemeKind ?? 'vscode-dark';

  if (kind.includes('light')) {
    return 'light';
  }
  if (kind.includes('high-contrast')) {
    return 'high-contrast';
  }
  return 'dark';
}

/**
 * Hook that detects the current VSCode theme kind and reactively
 * updates when the user switches themes.
 *
 * Uses a `MutationObserver` on `document.body` to watch for changes
 * to the `data-vscode-theme-kind` attribute.
 */
export function useTheme(): ThemeKind {
  const [theme, setTheme] = useState<ThemeKind>(() => detectTheme());

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(detectTheme());
    });

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-vscode-theme-kind'],
    });

    return () => observer.disconnect();
  }, []);

  return theme;
}
