/**
 * The extension, in the editor it ships for.
 *
 * Every other suite in this package runs against a mocked `vscode` module: it
 * proves the code behaves, not that VS Code will load it. This one downloads a
 * real VS Code, installs the built extension into it and asks the questions a
 * user's first minute answers — does it activate, are the commands in the
 * palette, does the panel open.
 *
 * It runs outside `pnpm validate`, since it needs a display and a download.
 *   pnpm --filter sandforge test:smoke
 */
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

/** The identifier the manifest publishes under. */
const EXTENSION_ID = 'StephaneBerthoz.sandforge';

/** Commands the manifest contributes, read back from the installed extension. */
function contributedCommands(extension: vscode.Extension<unknown>): string[] {
  const contributes = extension.packageJSON.contributes as
    { commands?: Array<{ command: string }> } | undefined;
  return (contributes?.commands ?? []).map((entry) => entry.command);
}

suite('SandForge in a real VS Code', () => {
  test('the extension is installed and activates', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in this VS Code`);

    await extension.activate();
    assert.equal(extension.isActive, true, 'activate() resolved but the extension is not active');
  });

  test('every command the manifest contributes is registered', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    await extension.activate();

    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = contributedCommands(extension).filter((id) => !registered.has(id));
    assert.deepEqual(missing, [], 'contributed commands the host never registered');
  });

  test('the command that shows the side panel at startup is one VS Code knows', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    await extension.activate();

    // VS Code generates it from the activity bar's `sandforge` container; a
    // renamed container would leave startup running a command that is not there.
    const registered = new Set(await vscode.commands.getCommands(true));
    assert.ok(
      registered.has('workbench.view.extension.sandforge'),
      'workbench.view.extension.sandforge is not registered',
    );
    await vscode.commands.executeCommand('workbench.view.extension.sandforge');
  });

  test('the panel opens on the page a command names', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    await extension.activate();

    // Each of these creates the panel if it is not there and navigates it.
    // They resolve once the webview exists, so a rejection here is a panel a
    // user could not open at all.
    for (const command of ['sandforge.openMonitor', 'sandforge.openSeed', 'sandforge.openHelp']) {
      await vscode.commands.executeCommand(command);
    }
  });
});
