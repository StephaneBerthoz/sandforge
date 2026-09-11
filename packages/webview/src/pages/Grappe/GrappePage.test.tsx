import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import en from '../../i18n/locales/en.json';
import { useAppStore } from '../../stores/useAppStore';
import { useGrappeStore } from '../../stores/useGrappeStore';
import { GrappePage } from './GrappePage';

describe('GrappePage empty state', () => {
  beforeEach(() => {
    useAppStore.setState({ currentRoute: 'grappe' });
    useGrappeStore.setState({
      active: false,
      totalPartitions: 0,
      totalRecords: 0,
      partitions: new Map(),
      totalProcessed: 0,
      totalFailed: 0,
    });
  });

  it('sends the user to a module whose runs can actually populate this page', () => {
    // Only Seed, Sync and Autopilot emit grappe:* events. The CTA used to open
    // Forge, which emits none — following it could never fill the dashboard it
    // was offered from.
    render(<GrappePage />);
    fireEvent.click(screen.getByTestId('grappe-settings'));
    expect(useAppStore.getState().currentRoute).toBe('seed');
  });

  it('should label the call to action as a module action, not a settings one', () => {
    render(<GrappePage />);
    expect(screen.getByTestId('grappe-settings').textContent).toBe(en.grappe.openSeed);
  });

  it('names only settings that exist, and offers no settings screen of its own', () => {
    // The empty state used to read "Configure threshold in Settings" under a
    // "Configure Threshold" button, for a screen this webview does not have.
    // An earlier fix answered that by banning the word, which also banned the
    // honest sentence: `sandforge.grappe.autoActivateThreshold` is a real
    // setting, and telling the reader what turns Grappe on is the point of an
    // empty state. So the check is what it was written for — every
    // `sandforge.*` this page names is contributed by the manifest, and the
    // only action offered is the module one.
    render(<GrappePage />);
    const page = screen.getByTestId('grappe-page');
    expect(page.textContent).not.toMatch(/configure threshold/i);
    expect(screen.getByTestId('grappe-settings').textContent).toBe(en.grappe.openSeed);

    // Resolved from the working directory, not from `import.meta.url`: the
    // webview is transformed for a browser, where that URL has no file scheme.
    const manifestPath = ['../extension/package.json', 'packages/extension/package.json']
      .map((candidate) => resolve(process.cwd(), candidate))
      .find((candidate) => existsSync(candidate));
    expect(manifestPath, 'the extension manifest is not where this test looks').toBeDefined();
    const manifest = JSON.parse(readFileSync(manifestPath as string, 'utf8')) as {
      contributes: { configuration: { properties: Record<string, unknown> } };
    };
    const contributed = Object.keys(manifest.contributes.configuration.properties);
    expect(contributed.length).toBeGreaterThan(0);
    // `[\w.]*\w` so a full stop ending the sentence is not read as part of the id.
    for (const named of page.textContent?.match(/sandforge\.[\w.]*\w/g) ?? []) {
      expect(contributed).toContain(named);
    }
    expect(screen.getByText(en.grappe.emptyDesc)).toBeDefined();
  });
});
