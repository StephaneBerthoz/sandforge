/**
 * The key a finished welcome tour was recorded under, which nothing read: the
 * walkthrough VS Code opens on install is the one first-run script, and the
 * tour opens only from Help. Cleared where an earlier version left it.
 */
const RETIRED_ONBOARDING_KEY = 'sandforge.onboardingCompleted';

/**
 * OnboardingService tracks whether the "What's New" panel should be shown
 * after an update.
 */
export class OnboardingService {
  private static VERSION_KEY = 'sandforge.lastVersion';

  private readonly globalStateGet: (key: string) => string | undefined;
  private readonly globalStateUpdate: (key: string, value: string | undefined) => Thenable<void>;

  constructor(globalState: {
    get: (key: string) => string | undefined;
    update: (key: string, value: string | undefined) => Thenable<void>;
  }) {
    this.globalStateGet = (key: string) => globalState.get(key);
    this.globalStateUpdate = (key: string, value: string | undefined) =>
      globalState.update(key, value);
  }

  /** Returns true if the extension version changed since last launch. */
  shouldShowWhatsNew(currentVersion: string): boolean {
    const lastVersion = this.globalStateGet(OnboardingService.VERSION_KEY);
    return lastVersion !== undefined && lastVersion !== currentVersion;
  }

  /** Returns true if this is the very first activation (no version stored). */
  isFirstLaunch(): boolean {
    return this.globalStateGet(OnboardingService.VERSION_KEY) === undefined;
  }

  /** Store the current version as last seen version. */
  async markVersionSeen(version: string): Promise<void> {
    await this.globalStateUpdate(OnboardingService.VERSION_KEY, version);
  }

  /**
   * Remove what an earlier version kept and nothing reads: the finished tour's
   * flag. Writes nothing when it is not there.
   */
  async dropRetiredState(): Promise<void> {
    if (this.globalStateGet(RETIRED_ONBOARDING_KEY) === undefined) return;
    await this.globalStateUpdate(RETIRED_ONBOARDING_KEY, undefined);
  }
}
