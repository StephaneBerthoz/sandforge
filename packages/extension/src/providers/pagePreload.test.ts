import { describe, expect, it } from 'vitest';
import { parsePagePreload } from './pagePreload';

describe('parsePagePreload', () => {
  it("reads each route's files, as the build writes them", () => {
    const list = parsePagePreload(
      JSON.stringify({
        forge: ['assets/chunks/ForgePage-DnH0OoTz.js', 'assets/chunks/Button-CygUF4F5.js'],
        home: [],
      }),
    );

    expect(list.get('forge')).toEqual([
      'assets/chunks/ForgePage-DnH0OoTz.js',
      'assets/chunks/Button-CygUF4F5.js',
    ]);
    expect(list.get('home')).toEqual([]);
  });

  it('reads nothing from a list that is absent, not JSON, or names a file outside the scripts of the build', () => {
    expect(parsePagePreload(undefined).size).toBe(0);
    expect(parsePagePreload('{"forge": [').size).toBe(0);
    expect(parsePagePreload(JSON.stringify({ forge: ['../../extension.js'] })).size).toBe(0);
    expect(parsePagePreload(JSON.stringify({ forge: ['assets/chunks/x.js"><script>'] })).size).toBe(
      0,
    );
    expect(parsePagePreload(JSON.stringify({ forge: ['locales/fr.json'] })).size).toBe(0);
    expect(parsePagePreload(JSON.stringify(['assets/index.js'])).size).toBe(0);
  });
});
