import type * as vscode from 'vscode';
import { ConfigStore } from '../core/storage/ConfigStore';
import { MementoConfigStoreBackend } from '../core/storage/MementoConfigStoreBackend';
import { SecretVault } from '../core/storage/SecretVault';
import { OrgManager } from '../core/connection/OrgManager';
import { OrgRegistry } from '../core/connection/OrgRegistry';
import { AuthProvider } from '../core/connection/AuthProvider';
import { SfdxBridge } from '../core/connection/SfdxBridge';
import { OnboardingService } from '../core/onboarding/OnboardingService';
import { HintTracker } from '../core/onboarding/HintTracker';
import type { Services } from '../services.js';

/** Inputs required to build the core service layer. */
export interface CoreCompositionDeps {
  context: vscode.ExtensionContext;
  services: Services;
}

/**
 * Core services built eagerly at activation. All constructors are cheap
 * (no dynamic imports, no network IO) so they stay on the activation path.
 */
export interface CoreComposition {
  configStore: ConfigStore;
  secretVault: SecretVault;
  orgManager: OrgManager;
  orgRegistry: OrgRegistry;
  authProvider: AuthProvider;
  sfdxBridge: SfdxBridge;
  onboardingService: OnboardingService;
  hintTracker: HintTracker;
}

/**
 * Build the core service layer: config, secrets, orgs, auth, onboarding.
 * Extracted from `activate()` — behaviour unchanged, ordering preserved.
 */
export function createCoreComposition(deps: CoreCompositionDeps): CoreComposition {
  const { context, services } = deps;

  // ConfigStore (backed by VSCode globalState)
  const configBackend = new MementoConfigStoreBackend(context.globalState);
  const configStore = new ConfigStore(configBackend);
  configStore.initialize();
  // Plumb into services bundle so orchestrators (Monitor v2 etc.) can pick
  // it up via deps.services?.configStore. Mutating here because createServices
  // ran before ConfigStore was constructed (legacy ordering).
  services.configStore = configStore;

  // SecretVault (wrapping VSCode SecretStorage)
  const secretVault = new SecretVault({
    get: (key: string) => Promise.resolve(context.secrets.get(key)),
    store: (key: string, value: string) => Promise.resolve(context.secrets.store(key, value)),
    delete: (key: string) => Promise.resolve(context.secrets.delete(key)),
  });

  // OrgManager + OrgRegistry
  const orgManager = new OrgManager();
  const orgRegistry = new OrgRegistry(configStore, secretVault, orgManager);

  // AuthProvider + SfdxBridge
  const sfdxBridge = new SfdxBridge();
  const authProvider = new AuthProvider();
  authProvider.setSfdxBridge(sfdxBridge);

  // Onboarding + HintTracker
  const onboardingService = new OnboardingService(context.globalState);
  const hintTracker = new HintTracker(context.globalState);

  return {
    configStore,
    secretVault,
    orgManager,
    orgRegistry,
    authProvider,
    sfdxBridge,
    onboardingService,
    hintTracker,
  };
}
