import { describe, it, expect } from 'vitest';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ja from '../../i18n/locales/ja.json';
import ptBR from '../../i18n/locales/pt-BR.json';

/** The six bundles, for what Help says a Sync run's removal does. */
const LOCALES = { en, fr, de, es, ja, 'pt-BR': ptBR };

describe('what Help says a Sync run’s removal takes back', () => {
  it('no longer says the records a run updated keep their new values', () => {
    // Since 1.64 a removal gives them back their values from before the run.
    expect(en.help.syncContent).not.toContain('keep their new values');
    expect(en.help.faqContent).not.toContain('The records it updated keep their new values');
    expect(en.help.syncContent).toContain('gives the records it wrote over');
    expect(en.help.faqContent).toContain('gives the records it updated their values from before');
  });

  it('names, in every language, the retention the values from before are kept for, and the Real-Time tab as not removable', () => {
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      for (const text of [bundle.help.syncContent, bundle.help.faqContent]) {
        expect(text, lng).toContain('sandforge.backup.maxAgeDays');
        expect(text, lng).toContain(bundle.sync.tabs.realtime);
      }
    }
  });
});
