import * as vscode from 'vscode';
import type { WebviewPanelManager } from '../providers/WebviewPanelManager';
import type { OrgRegistry } from '../core/connection/OrgRegistry';
import type { OrgManager } from '../core/connection/OrgManager';
import type { WebviewStateSync } from '../bridge/WebviewStateSync';
import type { OnboardingService } from '../core/onboarding/OnboardingService';
import { MODULE_COMMANDS } from './moduleCommands';
import { intentMessageFor } from './moduleIntent';

/** Inputs required to register the module-open commands. */
export interface ModuleCommandsDeps {
  context: vscode.ExtensionContext;
  panelManager: WebviewPanelManager;
  orgRegistry: OrgRegistry;
  orgManager: OrgManager;
  stateSync: WebviewStateSync;
  onboardingService: OnboardingService;
  /**
   * Whether the user wants the What's New panel after an upgrade: the
   * `sandforge.showWhatsNew` setting. Absent, they do.
   */
  whatsNewWanted?: () => boolean;
}

/**
 * Register the `sandforge.open*` module commands (each opens a webview panel)
 * plus the `sandforge.cheers` easter egg. All registrations are pushed to
 * `context.subscriptions` by this function.
 *
 * The first panel open of an activation shows "what's new" after an upgrade,
 * once. It used to show the welcome wizard to whoever had not finished it: a
 * second first-run script over the walkthrough VS Code opens on install,
 * covering the page the walkthrough had just sent them to, and back at its
 * first step every session until it was completed. The walkthrough is the one
 * first-run script; Help → Start Guided Tour still opens the wizard.
 */
export function registerModuleCommands(deps: ModuleCommandsDeps): void {
  const { context, panelManager, orgRegistry, orgManager, stateSync, onboardingService } = deps;

  // The command list lives in ./moduleCommands.ts — shared with the sidebar
  // route map so both stay in sync.
  const currentVersion = (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
  let onboardingTriggered = false;

  for (const { command, moduleId, title } of MODULE_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, (argument?: unknown) => {
        const viewType = `sandforge.${moduleId}`;
        // Distinguish reveal (panel already alive, webview bundle loaded and
        // listening) from create (bundle still parsing — any message posted
        // now would be lost before the listeners attach).
        const isReveal = panelManager.hasPanel(viewType);
        const panel = panelManager.openPanel({
          viewType,
          title: `SandForge: ${title}`,
          moduleId,
        });
        orgRegistry.loadAll();
        const orgs = orgManager.getAllOrgs();
        stateSync.updateState({
          orgs: orgs as unknown as Record<string, unknown>[],
          extensionReady: true,
        });

        // What the page was asked to start, by the launcher's first card.
        const intent = intentMessageFor(moduleId, argument, `intent-${Date.now()}`);

        // What's new on the first panel open after an upgrade
        let whatsNew: Record<string, unknown> | undefined;
        if (!onboardingTriggered) {
          onboardingTriggered = true;
          if (onboardingService.isFirstLaunch()) {
            // Nothing to tell about a version never run before; recorded, so
            // the next upgrade is the one What's New shows.
            onboardingService.markVersionSeen(currentVersion).catch(() => undefined);
          } else if (onboardingService.shouldShowWhatsNew(currentVersion)) {
            if (deps.whatsNewWanted?.() === false) {
              // Turned off: the upgrade is still recorded, so turning it back
              // on shows the next one, not this one late.
              onboardingService.markVersionSeen(currentVersion).catch(() => undefined);
            } else {
              whatsNew = {
                type: 'whats-new:show',
                id: `whatsnew-${Date.now()}`,
                timestamp: Date.now(),
                payload: { version: currentVersion },
              };
            }
          }
        }

        const messages = [intent, whatsNew].filter(
          (message): message is Record<string, unknown> => message !== undefined,
        );
        if (messages.length === 0) return;
        // Posted to the TRIGGERING panel only — the what's-new overlay must
        // not pop in every open panel (postToAllPanels broadcasts by design,
        // e.g. org:selected).
        const post = (): void => {
          for (const message of messages) void panel.webview.postMessage(message);
          if (whatsNew) onboardingService.markVersionSeen(currentVersion).catch(() => undefined);
        };
        if (isReveal) {
          // Live panel: the bundle is already loaded — post now.
          post();
        } else {
          // New panel: posting now would race the bundle parse — the message
          // would be lost while markVersionSeen still recorded it as shown
          // (what's-new never appears). Arm a one-shot listener: the FIRST
          // incoming webview message proves the bundle is up, then post
          // exactly once and mark seen. The listener is also released if the
          // panel closes before ever posting — no orphan disposable left behind.
          const readyListener = panel.webview.onDidReceiveMessage(() => {
            readyListener.dispose();
            post();
          });
          const disposeListener = panel.onDidDispose(() => readyListener.dispose());
          context.subscriptions.push(readyListener, disposeListener);
        }
      }),
    );
  }

  // Easter egg command (discoverable via Command Palette but not in menus)
  context.subscriptions.push(
    vscode.commands.registerCommand('sandforge.cheers', () => {
      panelManager.postToAllPanels({ type: 'easter-egg:show' });
    }),
  );
}
