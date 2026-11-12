import { describe, it, expect } from 'vitest';
import i18n from '../../i18n';
import { moduleName, namesModule } from './moduleName';

describe('moduleName', () => {
  it('names a module as the navigation does', () => {
    expect(moduleName(i18n.t, 'frozen')).toBe('Frozen Dataset');
    expect(moduleName(i18n.t, 'dataops')).toBe('DataOps');
    expect(moduleName(i18n.t, 'checkpoint')).toBe('Checkpoints');
  });

  it('shows an id the navigation has no name for as it is', () => {
    expect(moduleName(i18n.t, 'cli')).toBe('cli');
  });
});

describe('namesModule', () => {
  it('reads a module named in an action label, whatever its case', () => {
    expect(namesModule('Forge clone', 'Forge')).toBe(true);
    expect(namesModule('Exécution seed', 'Seed')).toBe(true);
    expect(namesModule('Chargement du jeu de données figé', 'Jeu de données figé')).toBe(true);
  });

  it('does not read one the label leaves out', () => {
    expect(namesModule('Cleanup delete', 'Frozen Dataset')).toBe(false);
    expect(namesModule('Backup Restore', 'DataOps')).toBe(false);
  });
});
