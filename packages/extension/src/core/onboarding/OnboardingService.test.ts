import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OnboardingService } from './OnboardingService';

describe('OnboardingService', () => {
  let service: OnboardingService;
  let store: Map<string, string>;
  const mockUpdate = vi.fn<(key: string, value: string | undefined) => Promise<void>>();

  beforeEach(() => {
    store = new Map();
    mockUpdate.mockClear();
    mockUpdate.mockImplementation(async (key: string, value: string | undefined) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    });
    service = new OnboardingService({
      get: (key: string) => store.get(key),
      update: mockUpdate,
    });
  });

  describe('shouldShowWhatsNew', () => {
    it('should return false when no previous version is stored', () => {
      expect(service.shouldShowWhatsNew('1.0.0')).toBe(false);
    });

    it('should return false when version matches stored version', async () => {
      await service.markVersionSeen('1.0.0');
      expect(service.shouldShowWhatsNew('1.0.0')).toBe(false);
    });

    it('should return true when version differs from stored version', async () => {
      await service.markVersionSeen('0.9.0');
      expect(service.shouldShowWhatsNew('1.0.0')).toBe(true);
    });
  });

  describe('isFirstLaunch', () => {
    it('should return true when no version has ever been stored', () => {
      expect(service.isFirstLaunch()).toBe(true);
    });

    it('should return false after a version has been seen', async () => {
      await service.markVersionSeen('1.0.0');
      expect(service.isFirstLaunch()).toBe(false);
    });
  });

  describe('markVersionSeen', () => {
    it('should persist the version string', async () => {
      await service.markVersionSeen('2.1.0');
      expect(mockUpdate).toHaveBeenCalledWith('sandforge.lastVersion', '2.1.0');
    });
  });

  describe('dropRetiredState', () => {
    it('removes the finished tour flag an earlier version wrote, which nothing reads', async () => {
      store.set('sandforge.onboardingCompleted', 'true');

      await service.dropRetiredState();

      expect(store.has('sandforge.onboardingCompleted')).toBe(false);
      expect(mockUpdate).toHaveBeenCalledWith('sandforge.onboardingCompleted', undefined);
    });

    it('writes nothing when the flag is not there', async () => {
      await service.dropRetiredState();

      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('keeps the version What’s New is told from', async () => {
      store.set('sandforge.lastVersion', '1.0.0');
      store.set('sandforge.onboardingCompleted', 'true');

      await service.dropRetiredState();

      expect(store.get('sandforge.lastVersion')).toBe('1.0.0');
    });
  });
});
