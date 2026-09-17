/**
 * The stylesheet VS Code prepends to the head of every webview document, as
 * `<style id="_defaultStyles">`: src/vs/workbench/contrib/webview/browser/pre/index.html
 * in microsoft/vscode, read from main on 2026-09-17 (last changed 2026-09-02).
 *
 * Its rules sit in a cascade layer, so any unlayered rule of the panel wins over
 * them property by property, but a property the panel never sets is painted by
 * VS Code: Tailwind's preflight gives `<code>` a font and no background, so a
 * `<code>` shows `textPreformat.background` behind whatever colour the panel
 * gives its text. The `--vscode-*` colours it reads are listed with the others in
 * src/styles/testing/vscodeThemes.ts.
 */
export const VSCODE_DEFAULT_STYLES = `
@layer vscode-default {
	html {
		scrollbar-color: var(--vscode-scrollbarSlider-background) var(--vscode-editor-background);
	}

	body {
		overscroll-behavior-x: none;
		background-color: transparent;
		color: var(--vscode-editor-foreground);
		font-family: var(--vscode-font-family);
		font-weight: var(--vscode-font-weight);
		font-size: var(--vscode-font-size);
		margin: 0;
		padding: 0 20px;
	}

	img, video {
		max-width: 100%;
		max-height: 100%;
	}

	a, a code {
		color: var(--vscode-textLink-foreground);
	}

	p > a {
		text-decoration: var(--text-link-decoration);
	}

	a:hover {
		color: var(--vscode-textLink-activeForeground);
	}

	a:focus,
	input:focus,
	select:focus,
	textarea:focus {
		outline: 1px solid -webkit-focus-ring-color;
		outline-offset: -1px;
	}

	code {
		font-family: var(--monaco-monospace-font);
		color: var(--vscode-textPreformat-foreground);
		background-color: var(--vscode-textPreformat-background);
		padding: 1px 3px;
		border-radius: 4px;
	}

	pre code {
		padding: 0;
	}

	blockquote {
		background: var(--vscode-textBlockQuote-background);
		border-color: var(--vscode-textBlockQuote-border);
	}

	kbd {
		background-color: var(--vscode-keybindingLabel-background);
		color: var(--vscode-keybindingLabel-foreground);
		border-style: solid;
		border-width: 1px;
		border-radius: 3px;
		border-color: var(--vscode-keybindingLabel-border);
		border-bottom-color: var(--vscode-keybindingLabel-bottomBorder);
		box-shadow: inset 0 -1px 0 var(--vscode-widget-shadow);
		vertical-align: middle;
		padding: 1px 3px;
	}

	::-webkit-scrollbar {
		width: 10px;
		height: 10px;
	}

	::-webkit-scrollbar-corner {
		background-color: var(--vscode-editor-background);
	}

	::-webkit-scrollbar-thumb {
		background-color: var(--vscode-scrollbarSlider-background);
	}
	::-webkit-scrollbar-thumb:hover {
		background-color: var(--vscode-scrollbarSlider-hoverBackground);
	}
	::-webkit-scrollbar-thumb:active {
		background-color: var(--vscode-scrollbarSlider-activeBackground);
	}
	::highlight(find-highlight) {
		background-color: var(--vscode-editor-findMatchHighlightBackground);
	}
	::highlight(current-find-highlight) {
		background-color: var(--vscode-editor-findMatchBackground);
	}
}`;
