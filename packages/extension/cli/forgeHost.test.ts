import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Under Vitest the module runner resolves `vscode` before Node's loader is
// asked: it is handed what the host stood in for the editor's, as `tsx` hands
// it through the loader's hooks.
vi.mock(
  'vscode',
  () =>
    (globalThis as Record<symbol, Record<string, unknown>>)[
      Symbol.for('sandforge.forgeHost.vscode')
    ],
);

import { createForgeHost, goOn, hostVscode, type HostQuestion } from './forgeHost.js';

describe('hostVscode', () => {
  it('asks the caller what a modal asks, and logs the rest', async () => {
    const lines: string[] = [];
    const asked: HostQuestion[] = [];
    const vscode = hostVscode(() => ({
      answer: (question) => {
        asked.push(question);
        return question.buttons[0];
      },
      log: (line) => lines.push(line),
    }));

    const chosen = await vscode.window.showWarningMessage(
      'SandForge: confirm this clone',
      { modal: true, detail: 'Writes 3 records.' },
      'Execute',
      'Copy the command',
    );
    const told = await vscode.window.showInformationMessage('SandForge: Forge completed');

    expect(chosen).toBe('Execute');
    expect(asked).toEqual([
      {
        title: 'SandForge: confirm this clone',
        detail: 'Writes 3 records.',
        buttons: ['Execute', 'Copy the command'],
      },
    ]);
    expect(told).toBeUndefined();
    expect(lines).toEqual([
      '  question: SandForge: confirm this clone -> Execute',
      '  notification (info): SandForge: Forge completed',
    ]);
    expect(vscode.l10n.t('{0} records of {1}', 3, 'Contact')).toBe('3 records of Contact');
    expect(vscode.workspace.workspaceFolders).toBeUndefined();
  });

  it('goes on with the first button, never the one that copies a command and cancels', () => {
    expect(goOn({ title: 't', buttons: ['Execute', 'Copy the command'] })).toBe('Execute');
    expect(goOn({ title: 't', buttons: [] })).toBeUndefined();
  });
});

describe('createForgeHost', () => {
  it("boots Forge's composition and answers the Forge page's requests through the extension's routing", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-forge-host-test-'));
    try {
      const host = await createForgeHost({ storeDir: dir, log: () => undefined, waitMs: 5_000 });
      expect(host.storagePath).toBe(join(dir, 'storage'));

      const history = await host.request({ type: 'forge:history:list' });
      expect(history.outcome).toBe('answered');
      expect(history.message?.payload).toMatchObject({ history: [] });

      // The orchestrator is in: a discovery runs, where a host without it is
      // refused as not initialized. Of an org nobody registered, it reads nothing.
      const discovery = await host.request({
        type: 'forge:discover',
        payload: {
          config: {
            inputMode: 'soql',
            soqlQuery: 'SELECT Id FROM Contact',
            depth: 'direct',
            sourceOrgId: '00D000000000009AAA',
            targetOrgId: '00D000000000008AAA',
            anonymizePII: false,
            skipEmpty: true,
            batchSize: 'auto',
          },
        },
      });
      expect(discovery.outcome).toBe('answered');
      expect(discovery.message?.payload).toHaveProperty('graph');

      // A removal of a run the history does not hold: the handler's own refusal.
      const removal = await host.request({
        type: 'forge:undo',
        payload: { forgeId: 'forge-none' },
      });
      expect(removal.outcome).toBe('failed');
      expect(removal.message?.payload).toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
