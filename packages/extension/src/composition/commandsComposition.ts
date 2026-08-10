import * as vscode from 'vscode';
import type { WebviewPanelManager } from '../providers/WebviewPanelManager';
import type { OrgRegistry } from '../core/connection/OrgRegistry';
import type { OrgManager } from '../core/connection/OrgManager';
import type { WebviewStateSync } from '../bridge/WebviewStateSync';
import type { OnboardingService } from '../core/onboarding/OnboardingService';
import { MODULE_COMMANDS } from './moduleCommands';

/** Inputs required to register the module-open commands. */
export interface ModuleCommandsDeps {
  context: vscode.ExtensionContext;
  panelManager: WebviewPanelManager;
  orgRegistry: OrgRegistry;
  orgManager: OrgManager;
  stateSync: WebviewStateSync;
  onboardingService: OnboardingService;
}

/**
 * Register the `sandforge.open*` module commands (each opens a webview panel)
 * plus the `sandforge.cheers` easter egg. All registrations are pushed to
 * `context.subscriptions` by this function.
 *
 * First panel open triggers onboarding (or "what's new") exactly once per
 * activation. Extracted from `activate()` — behaviour unchanged.
 */
export function registerModuleCommands(deps: ModuleCommandsDeps): void {
  const { context, panelManager, orgRegistry, orgManager, stateSync, onboardingService } = deps;

  // The command list lives in ./moduleCommands.ts — shared with the sidebar
  // route map so both stay in sync.
  const currentVersion = (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
  let onboardingTriggered = false;

  for (const { command, moduleId, title } of MODULE_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        panelManager.openPanel({
          viewType: `sandforge.${moduleId}`,
          title: `SandForge: ${title}`,
          moduleId,
        });
        orgRegistry.loadAll();
        const orgs = orgManager.getAllOrgs();
        stateSync.updateState({
          orgs: orgs as unknown as Record<string, unknown>[],
          extensionReady: true,
        });

        // Trigger onboarding or what's new on first panel open
        if (!onboardingTriggered) {
          onboardingTriggered = true;
          if (onboardingService.shouldShowOnboarding()) {
            panelManager.postToActivePanel({
              type: 'onboarding:show',
              id: `onboarding-${Date.now()}`,
              timestamp: Date.now(),
              payload: {},
            });
            onboardingService.markVersionSeen(currentVersion).catch(() => undefined);
          } else if (onboardingService.shouldShowWhatsNew(currentVersion)) {
            panelManager.postToActivePanel({
              type: 'whats-new:show',
              id: `whatsnew-${Date.now()}`,
              timestamp: Date.now(),
              payload: { version: currentVersion },
            });
            onboardingService.markVersionSeen(currentVersion).catch(() => undefined);
          }
        }
      }),
    );
  }

  // Easter egg command (discoverable via Command Palette but not in menus)
  context.subscriptions.push(
    vscode.commands.registerCommand('sandforge.cheers', () => {
      panelManager.postToActivePanel({ type: 'easter-egg:show' });
    }),
  );
}
