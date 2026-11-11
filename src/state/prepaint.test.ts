import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ACCENTS, DEFAULT_LOOK, STYLE_IDS, lookBackground, lookCss, serializeLook } from './appearance';
import type { Look } from './appearance';
import { DEFAULT_PREF, LOOK_KEY, LOOK_STYLE_ID, THEME_COLORS, THEME_KEY, parsePref, resolveTheme } from './theme';
import type { Theme } from './theme';

// index.html applies the saved mode and look before the app loads. This runs that very script against a
// stand-in page, and checks it agrees with theme.ts and appearance.ts, which can't share code with it.

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
if (!script) throw new Error('index.html has no inline script');

const DEFAULT_META = { 'theme-color': '#0b0b0f', 'color-scheme': 'dark' };

interface Page {
  theme: string | undefined;
  meta: Record<string, string>;
  /** the <style> elements the script added to <head> */
  styles: { id: string; textContent: string }[];
}

function runScript(opts: { storage?: Record<string, string>; systemLight?: boolean; blocked?: boolean; noMatchMedia?: boolean }): Page {
  const page: Page = { theme: undefined, meta: { ...DEFAULT_META }, styles: [] };
  const dataset: Record<string, string> = {};
  const document = {
    documentElement: { dataset },
    head: { appendChild: (el: { id: string; textContent: string }) => page.styles.push(el) },
    createElement: () => ({ id: '', textContent: '' }),
    querySelector: (selector: string) => {
      const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1];
      return name ? { setAttribute: (_: string, value: string) => (page.meta[name] = value) } : null;
    },
  };
  const localStorage = {
    getItem: (key: string) => {
      if (opts.blocked) throw new Error('storage is blocked');
      return opts.storage?.[key] ?? null;
    },
  };
  const matchMedia = (query: string) => ({ matches: query.includes('light') && !!opts.systemLight });
  const window = opts.noMatchMedia ? {} : { matchMedia };
  runInNewContext(script as string, { document, localStorage, window, ...(opts.noMatchMedia ? {} : { matchMedia }) });
  page.theme = dataset.theme;
  return page;
}

const themes: Theme[] = ['dark', 'light'];

describe('the first-paint script and the mode', () => {
  it.each([null, 'system', 'light', 'dark', 'sepia', ''])('resolves a saved %j like theme.ts does', (raw) => {
    for (const systemLight of [false, true]) {
      const storage: Record<string, string> = raw === null ? {} : { [THEME_KEY]: raw };
      const page = runScript({ storage, systemLight });
      const theme = resolveTheme(parsePref(raw), systemLight);
      expect(page.theme, `system ${systemLight ? 'light' : 'dark'}`).toBe(theme);
      expect(page.meta['theme-color']).toBe(THEME_COLORS[theme]);
      expect(page.meta['color-scheme']).toBe(theme);
    }
  });

  it('follows the device when nothing is saved, as theme.ts does by default', () => {
    expect(DEFAULT_PREF).toBe('system');
    expect(runScript({ systemLight: true }).theme).toBe('light');
    expect(runScript({ systemLight: false }).theme).toBe('dark');
  });

  it('adds nothing to the page for the default look', () => {
    const saved: Record<string, string>[] = [{}, { [LOOK_KEY]: serializeLook(DEFAULT_LOOK) }];
    for (const storage of saved) {
      const page = runScript({ storage });
      expect(page.styles).toEqual([]);
      expect(page.meta).toEqual(DEFAULT_META);
    }
  });

  it('gets by without storage or matchMedia', () => {
    expect(runScript({ blocked: true, systemLight: true }).theme).toBe('light');
    expect(runScript({ noMatchMedia: true }).theme).toBe('dark');
    expect(runScript({ blocked: true }).styles).toEqual([]);
  });
});

describe('the first-paint script and a saved look', () => {
  // A spread of looks: every style and corner setting, with the presets and a few awkward custom colors.
  const looks: Look[] = [];
  for (const style of STYLE_IDS) {
    for (const corners of ['sharp', 'standard', 'round'] as const) looks.push({ style, accent: '#ff3d6e', corners });
    for (const accent of [...ACCENTS.map((a) => a.value), '#000000', '#ffffff', '#ffff00', '#123456']) {
      looks.push({ style, accent, corners: 'standard' });
    }
  }

  it('applies the CSS and page color the app saved, in either theme', () => {
    let applied = 0;
    for (const look of looks) {
      const storage = { [LOOK_KEY]: serializeLook(look) };
      for (const theme of themes) {
        const page = runScript({ storage, systemLight: theme === 'light' });
        const label = `${look.style} ${look.accent} ${look.corners} ${theme}`;
        expect(page.theme, label).toBe(theme);
        expect(page.meta['theme-color'], label).toBe(lookBackground(look, theme));
        expect(page.meta['color-scheme'], label).toBe(theme);
        const css = lookCss(look);
        if (css) {
          expect(page.styles, label).toEqual([{ id: LOOK_STYLE_ID, textContent: css }]);
          applied++;
        } else {
          expect(page.styles, label).toEqual([]);
        }
      }
    }
    expect(applied).toBeGreaterThan(looks.length);
  });

  it('applies a look together with a saved mode', () => {
    const look: Look = { style: 'slate', accent: '#33c98a', corners: 'round' };
    const storage = { [THEME_KEY]: 'light', [LOOK_KEY]: serializeLook(look) };
    const page = runScript({ storage, systemLight: false });
    expect(page.theme).toBe('light');
    expect(page.meta['theme-color']).toBe(lookBackground(look, 'light'));
    expect(page.styles).toHaveLength(1);
  });

  const good = lookCss({ style: 'warm', accent: '#ff8a00', corners: 'round' });
  const bg = { dark: '#12100d', light: '#f6f0e6' };
  const save = (data: unknown) => ({ [LOOK_KEY]: typeof data === 'string' ? data : JSON.stringify(data) });

  it.each([
    ['not JSON', save('{"v":1,')],
    ['not an object', save('7')],
    ['null', save('null')],
    ['another version', save({ v: 2, css: good, bg })],
    ['no version', save({ css: good, bg })],
    ['CSS that is not text', save({ v: 1, css: { a: 1 }, bg })],
    ['no CSS', save({ v: 1, bg })],
    ['CSS that closes the element', save({ v: 1, css: `${good}</style><script>1</script>`, bg })],
    ['CSS that loads something', save({ v: 1, css: "html{background:url('x')}", bg })],
    ['CSS with an escape', save({ v: 1, css: 'html{content:"\\41"}', bg })],
  ])('ignores a saved look that is %s', (_, storage) => {
    const page = runScript({ storage });
    expect(page.styles).toEqual([]);
    expect(page.meta).toEqual(DEFAULT_META);
  });

  it.each([
    ['missing', undefined],
    ['not a color', { dark: 'red', light: 'red' }],
    ['a function', { dark: 'url(x)', light: 'url(x)' }],
    ['a number', { dark: 1, light: 2 }],
    ['a short hex', { dark: '#123', light: '#123' }],
  ])('keeps the default page color when the saved one is %s', (_, badBg) => {
    for (const systemLight of [false, true]) {
      const page = runScript({ storage: save({ v: 1, css: good, bg: badBg }), systemLight });
      expect(page.styles).toHaveLength(1);
      expect(page.meta['theme-color']).toBe(THEME_COLORS[systemLight ? 'light' : 'dark']);
    }
  });
});
