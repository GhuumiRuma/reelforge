import { describe, expect, it } from 'vitest';
import { contrast, parseHex, toHex, toHsl, toRgb } from '../lib/color';
import { declarations } from '../test/css';
import {
  ACCENTS,
  accentName,
  accentSet,
  brightAccent,
  CORNERS,
  cornerScale,
  dangerFor,
  DEFAULT_ACCENT,
  DEFAULT_LOOK,
  INVERSE,
  isDefaultLook,
  type Look,
  lookBackground,
  lookCss,
  mergeLook,
  parseLook,
  serializeLook,
  sharedTokens,
  STYLE_IDS,
  STYLES,
  type Surfaces,
  SURFACE_TOKENS,
  themeTokens,
} from './appearance';
import { THEME_COLORS, type Theme } from './theme';

const THEMES: Theme[] = ['dark', 'light'];
const hex = (v: string) => toHex(toRgb(v));

const rootRule = declarations(':root');
const lightRule = declarations(":root[data-theme='light']");
const sheet: Record<Theme, Record<string, string>> = { dark: rootRule, light: { ...rootRule, ...lightRule } };

/** A stylesheet value as #rrggbb, following `var(--other)` references. */
function resolve(theme: Theme, token: string): string {
  const value = sheet[theme][token];
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref ? resolve(theme, ref[1]) : hex(value);
}

/** Awkward picks for a custom color: the extremes, grays, the page colors, and fully saturated primaries. */
const CUSTOM = [
  '#000000', '#ffffff', '#808080', '#7f7f7f', '#010101', '#fefefe', '#ffff00', '#ff0000', '#00ff00', '#0000ff',
  '#00ffff', '#ff00ff', '#000080', '#0b0b0f', '#f4f4f8', '#fffff0', '#123456', '#abcdef', '#8a2be2', '#ffd700',
]; // prettier-ignore
const PICKS = [...ACCENTS.map((a) => a.value), ...CUSTOM];

const TEXT_SURFACES = ['stage', 'panel', 'raised', 'dialog'] as const;
const SHAPE_SURFACES = ['raised2', 'toast', 'segOn'] as const;

describe('style palettes', () => {
  it('has a definition for every style id', () => {
    expect(Object.keys(STYLES).sort()).toEqual([...STYLE_IDS].sort());
    for (const id of STYLE_IDS) expect(STYLES[id].id).toBe(id);
  });

  describe.each(STYLE_IDS)('%s', (id) => {
    const def = STYLES[id];

    describe.each(THEMES)('%s', (theme) => {
      const p = def[theme];

      it('is made of lowercase #rrggbb colors', () => {
        for (const [key, value] of Object.entries(p)) expect(parseHex(value), key).toBe(value);
      });

      it('is dark in dark and light in light', () => {
        const l = toHsl(p.stage)[2];
        if (theme === 'dark') expect(l).toBeLessThan(0.15);
        else expect(l).toBeGreaterThan(0.85);
      });

      it.each(['stage', 'panel', 'raised', 'raised2', 'dialog', 'toast', 'segOn'] as const)('keeps text readable on %s', (surface) => {
        expect(contrast(p.text, p[surface])).toBeGreaterThanOrEqual(def.minContrast);
      });

      it.each(['stage', 'panel', 'raised', 'raised2', 'dialog'] as const)('keeps secondary text readable on %s', (surface) => {
        expect(contrast(p.dim, p[surface])).toBeGreaterThanOrEqual(def.minContrast);
      });

      it('keeps the surfaces apart from one another', () => {
        // Panels and fields have to read as different layers of the same screen.
        expect(contrast(p.raised, p.panel)).toBeGreaterThan(1.05);
        expect(contrast(p.raised2, p.raised)).toBeGreaterThan(1.05);
      });
    });
  });

  it('draws high contrast borders only in High contrast', () => {
    for (const theme of THEMES) {
      const p = STYLES.contrast[theme];
      for (const surface of ['stage', 'panel', 'raised'] as const) expect(contrast(p.line, p[surface])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('asks for more contrast in High contrast than anywhere else', () => {
    for (const id of STYLE_IDS) expect(STYLES[id].minContrast).toBe(id === 'contrast' ? 7 : 4.5);
  });
});

describe('light switch off track', () => {
  // A switch has no border, so its off track is all that shows its edge and where the thumb is (WCAG 1.4.11: 3:1).
  const thumb = declarations('.switch::after').background;

  it('is drawn on the sheet panel, under a white thumb', () => {
    expect(declarations('.switch').background).toBe('var(--switch-off)');
    expect(declarations('.sheet').background).toBe('var(--panel)');
    expect(hex(thumb)).toBe('#ffffff');
  });

  it.each(STYLE_IDS)('keeps the %s off track 3:1 clear of the thumb and its own panel', (id) => {
    const p = STYLES[id].light;
    expect(contrast(p.switchOff, thumb), 'thumb').toBeGreaterThanOrEqual(3);
    expect(contrast(p.switchOff, p.panel), 'panel').toBeGreaterThanOrEqual(3);
  });
});

describe('Standard style', () => {
  it.each(THEMES)('repeats the %s stylesheet', (theme) => {
    const p: Surfaces = STYLES.standard[theme];
    for (const [key, token] of Object.entries(SURFACE_TOKENS)) {
      expect(p[key as keyof typeof SURFACE_TOKENS], token).toBe(resolve(theme, token));
    }
  });

  it('matches the page background used for the browser chrome', () => {
    for (const theme of THEMES) expect(lookBackground(DEFAULT_LOOK, theme)).toBe(THEME_COLORS[theme]);
  });

  it('names each surface token that the stylesheet declares', () => {
    for (const token of Object.values(SURFACE_TOKENS)) expect(rootRule, token).toHaveProperty(token);
  });
});

describe('accentSet', () => {
  it.each(THEMES)('reproduces the stylesheet exactly for the default accent in %s', (theme) => {
    const a = accentSet('standard', DEFAULT_ACCENT, theme);
    expect(a.accent).toBe(resolve(theme, '--accent'));
    expect(a.fill).toBe(resolve(theme, '--accent-fill'));
    expect(a.press).toBe(resolve(theme, '--accent-press'));
    expect(a.onAccent).toBe(resolve(theme, '--on-accent'));
    expect(a.onInverse).toBe(resolve(theme, '--accent-on-inverse'));
  });

  it('uses the dark accent as the default accent', () => {
    expect(DEFAULT_ACCENT).toBe(rootRule['--accent']);
    expect(DEFAULT_ACCENT).toBe(rootRule['--accent-bright']);
  });

  it.each(THEMES)('uses the stylesheet\'s --inverse in %s', (theme) => {
    expect(INVERSE[theme]).toBe(resolve(theme, '--inverse'));
  });

  describe.each(STYLE_IDS)('%s', (id) => {
    describe.each(THEMES)('%s', (theme) => {
      const def = STYLES[id];
      const p = def[theme];

      it('keeps accent text and shapes readable for every preset and an awkward pick', () => {
        for (const pick of PICKS) {
          const a = accentSet(id, pick, theme);
          for (const s of TEXT_SURFACES) expect(contrast(a.accent, p[s]), `${pick} on ${s}`).toBeGreaterThanOrEqual(def.minContrast);
          for (const s of SHAPE_SURFACES) expect(contrast(a.accent, p[s]), `${pick} on ${s}`).toBeGreaterThanOrEqual(3);
        }
      });

      it('keeps text on filled buttons readable, and the fill visible', () => {
        for (const pick of PICKS) {
          const a = accentSet(id, pick, theme);
          expect(contrast(a.onAccent, a.fill), `${pick} text on fill`).toBeGreaterThanOrEqual(def.minContrast);
          expect(contrast(a.onAccent, a.press), `${pick} text on pressed fill`).toBeGreaterThanOrEqual(def.minContrast);
          for (const s of TEXT_SURFACES) expect(contrast(a.fill, p[s]), `${pick} fill on ${s}`).toBeGreaterThanOrEqual(3);
        }
      });

      it('keeps the recording button visible on its inverse disc', () => {
        for (const pick of PICKS) expect(contrast(accentSet(id, pick, theme).onInverse, INVERSE[theme]), pick).toBeGreaterThanOrEqual(3);
      });

      it('returns only #rrggbb colors', () => {
        for (const pick of PICKS) for (const v of Object.values(accentSet(id, pick, theme))) expect(parseHex(v), `${pick} ${v}`).toBe(v);
      });

      it('leaves a pick alone when it already reads well', () => {
        const sky = accentSet(id, '#00b2ff', theme);
        const ok = TEXT_SURFACES.every((s) => contrast('#00b2ff', p[s]) >= def.minContrast) && SHAPE_SURFACES.every((s) => contrast('#00b2ff', p[s]) >= 3);
        if (ok) expect(sky.accent).toBe('#00b2ff');
      });

      it('keeps the hue of a colorful pick', () => {
        for (const { value } of ACCENTS) {
          const [h0, s0] = toHsl(value);
          if (s0 < 0.4) continue;
          const [h] = toHsl(accentSet(id, value, theme).accent);
          const d = Math.abs(h - h0);
          expect(Math.min(d, 360 - d), value).toBeLessThan(6);
        }
      });
    });
  });

  it('asks for more of a pick in High contrast', () => {
    // The default pink is 6.1:1 on black: enough for AA, not for AAA.
    expect(accentSet('standard', DEFAULT_ACCENT, 'dark').accent).toBe(DEFAULT_ACCENT);
    expect(accentSet('contrast', DEFAULT_ACCENT, 'dark').accent).not.toBe(DEFAULT_ACCENT);
  });

  it('darkens bright picks in light and lightens dark picks in dark', () => {
    expect(toHsl(accentSet('standard', '#ffc400', 'light').accent)[2]).toBeLessThan(toHsl('#ffc400')[2]);
    expect(toHsl(accentSet('standard', '#000080', 'dark').accent)[2]).toBeGreaterThan(toHsl('#000080')[2]);
  });

  it('puts dark text on a light accent when that needs the smaller change', () => {
    expect(accentSet('standard', '#ffc400', 'dark').onAccent).toBe('#0b0b0f');
    expect(accentSet('standard', '#3f6bff', 'dark').onAccent).toBe('#ffffff');
  });
});

describe('brightAccent', () => {
  it('keeps the default pink under Standard, so nothing is overridden', () => {
    expect(brightAccent('standard', DEFAULT_ACCENT)).toBe(DEFAULT_ACCENT);
  });

  it.each(STYLE_IDS)('reads on black in %s', (id) => {
    for (const pick of PICKS) expect(contrast(brightAccent(id, pick), '#000000'), pick).toBeGreaterThanOrEqual(STYLES[id].minContrast);
  });
});

describe('dangerFor', () => {
  it.each(THEMES)('is the stylesheet\'s --danger under Standard in %s', (theme) => {
    expect(dangerFor('standard', theme)).toBe(resolve(theme, '--danger'));
  });

  it.each(STYLE_IDS)('reads on every surface of %s', (id) => {
    for (const theme of THEMES) {
      const p = STYLES[id][theme];
      const c = dangerFor(id, theme);
      for (const s of TEXT_SURFACES) expect(contrast(c, p[s]), `${theme} ${s}`).toBeGreaterThanOrEqual(STYLES[id].minContrast);
      for (const s of SHAPE_SURFACES) expect(contrast(c, p[s]), `${theme} ${s}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('does not follow the accent', () => {
    const pink = themeTokens({ style: 'warm', accent: DEFAULT_ACCENT, corners: 'standard' }, 'dark')['--danger'];
    const green = themeTokens({ style: 'warm', accent: '#34d058', corners: 'standard' }, 'dark')['--danger'];
    expect(green).toBe(pink);
  });
});

describe('parseLook', () => {
  const save = (o: object) => JSON.stringify({ v: 1, ...o });

  it('gives the default for nothing saved', () => {
    expect(parseLook(null)).toEqual(DEFAULT_LOOK);
    expect(parseLook(undefined)).toEqual(DEFAULT_LOOK);
    expect(parseLook('')).toEqual(DEFAULT_LOOK);
  });

  it('gives the default for anything that is not a saved look', () => {
    for (const raw of ['{', 'nope', 'null', '12', '"pure"', '[]', '[1,2]', '{}', '{"v":2,"style":"pure"}', '{"v":"1","style":"pure"}', '{"style":"pure"}']) {
      expect(parseLook(raw), raw).toEqual(DEFAULT_LOOK);
    }
  });

  it('reads a good look', () => {
    expect(parseLook(save({ style: 'slate', accent: '#00b2ff', corners: 'round' }))).toEqual({ style: 'slate', accent: '#00b2ff', corners: 'round' });
  });

  it('normalizes the accent to lowercase', () => {
    expect(parseLook(save({ accent: '#00B2FF' })).accent).toBe('#00b2ff');
  });

  it('falls back one field at a time', () => {
    expect(parseLook(save({ style: 'neon', accent: '#00b2ff', corners: 'round' }))).toEqual({ style: 'standard', accent: '#00b2ff', corners: 'round' });
    expect(parseLook(save({ style: 'pure', accent: 'blue', corners: 'round' }))).toEqual({ style: 'pure', accent: DEFAULT_ACCENT, corners: 'round' });
    expect(parseLook(save({ style: 'pure', accent: '#00b2ff', corners: 'pointy' }))).toEqual({ style: 'pure', accent: '#00b2ff', corners: 'standard' });
  });

  it('rejects colors that are not a plain #rrggbb', () => {
    for (const accent of ['#fff', '#00b2ff00', 'rgb(0,178,255)', '#00b2ff; background: red', 'url(x)', ' #00b2ff', 12, null, {}, ['#00b2ff']]) {
      expect(parseLook(save({ accent })).accent, String(accent)).toBe(DEFAULT_ACCENT);
    }
  });

  it('rejects ids that only exist on every object', () => {
    for (const style of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) expect(parseLook(save({ style })).style, style).toBe('standard');
    for (const corners of ['__proto__', 'constructor', 'toString']) expect(parseLook(save({ corners })).corners, corners).toBe('standard');
  });

  it('ignores the cached css and page colors', () => {
    const look = { style: 'pure', accent: '#00b2ff', corners: 'sharp' };
    expect(parseLook(save({ ...look, css: 'body{display:none}', bg: { dark: 'red', light: 'red' } }))).toEqual(look);
  });
});

describe('mergeLook', () => {
  const base: Look = { style: 'warm', accent: '#00b2ff', corners: 'round' };

  it('applies valid changes and keeps the rest', () => {
    expect(mergeLook(base, { style: 'pure' })).toEqual({ ...base, style: 'pure' });
    expect(mergeLook(base, { accent: '#34D058' })).toEqual({ ...base, accent: '#34d058' });
    expect(mergeLook(base, { corners: 'sharp' })).toEqual({ ...base, corners: 'sharp' });
    expect(mergeLook(base, {})).toEqual(base);
  });

  it('ignores invalid changes', () => {
    expect(mergeLook(base, { style: 'neon' as Look['style'], accent: 'blue', corners: 'pointy' as Look['corners'] })).toEqual(base);
    expect(mergeLook(base, { style: '__proto__' as Look['style'] })).toEqual(base);
  });

  it('does not change the look it was given', () => {
    const copy = { ...base };
    mergeLook(base, { style: 'pure' });
    expect(base).toEqual(copy);
  });
});

describe('serializeLook', () => {
  const looks: Look[] = [
    DEFAULT_LOOK,
    { style: 'pure', accent: '#00b2ff', corners: 'round' },
    { style: 'contrast', accent: DEFAULT_ACCENT, corners: 'standard' },
    { style: 'standard', accent: '#a67cff', corners: 'sharp' },
    { style: 'warm', accent: '#ffc400', corners: 'standard' },
  ];

  it.each(looks)('round-trips through parseLook', (look) => {
    expect(parseLook(serializeLook(look))).toEqual(look);
  });

  it.each(looks)('saves the css and page colors for the pre-paint script', (look) => {
    const saved = JSON.parse(serializeLook(look));
    expect(saved.v).toBe(1);
    expect(saved.css).toBe(lookCss(look));
    expect(saved.bg).toEqual({ dark: lookBackground(look, 'dark'), light: lookBackground(look, 'light') });
  });
});

describe('lookCss', () => {
  it('is empty for the default look', () => {
    expect(lookCss(DEFAULT_LOOK)).toBe('');
    expect(isDefaultLook(DEFAULT_LOOK)).toBe(true);
  });

  it('only sets --rs for a corners-only change', () => {
    expect(lookCss({ ...DEFAULT_LOOK, corners: 'round' })).toBe('html:root{--rs:1.5}');
    expect(lookCss({ ...DEFAULT_LOOK, corners: 'sharp' })).toBe('html:root{--rs:0.25}');
  });

  it('leaves the Standard surfaces to the stylesheet when only the accent changes', () => {
    for (const theme of THEMES) {
      expect(Object.keys(themeTokens({ ...DEFAULT_LOOK, accent: '#00b2ff' }, theme)).sort()).toEqual(
        ['--accent', '--accent-fill', '--accent-on-inverse', '--accent-press', '--on-accent'],
      );
    }
  });

  it('sets every surface token and --danger for the other styles', () => {
    for (const style of STYLE_IDS.filter((s) => s !== 'standard')) {
      for (const theme of THEMES) {
        const t = themeTokens({ ...DEFAULT_LOOK, style }, theme);
        for (const token of Object.values(SURFACE_TOKENS)) expect(t, `${style} ${theme}`).toHaveProperty(token);
        expect(t).toHaveProperty('--danger');
      }
    }
  });

  it('declares a different look for each theme', () => {
    const css = lookCss({ style: 'warm', accent: '#00b2ff', corners: 'round' });
    expect(css).toContain("html:root[data-theme='dark']{");
    expect(css).toContain("html:root[data-theme='light']{");
    expect(css).toContain('--stage:#12100d');
    expect(css).toContain('--stage:#f6f0e6');
  });

  const everyLook: Look[] = STYLE_IDS.flatMap((style) =>
    CORNERS.flatMap((c) => [...PICKS, DEFAULT_ACCENT].map((accent) => ({ style, accent, corners: c.id }))),
  );

  it('only has rules that out-rank the stylesheet for :root', () => {
    for (const look of everyLook) {
      for (const line of lookCss(look).split('\n').filter(Boolean)) {
        expect(line, JSON.stringify(look)).toMatch(/^html:root(\[data-theme='(dark|light)'\])?\{[^{}]*\}$/);
      }
    }
  });

  it('only uses characters that index.html accepts from storage', () => {
    for (const look of everyLook) expect(lookCss(look), JSON.stringify(look)).toMatch(/^[\w\s#.,:;{}'[\]=-]*$/);
  });

  it('only sets custom properties that styles.css declares', () => {
    const names = new Set<string>();
    for (const look of everyLook) {
      for (const t of [sharedTokens(look), themeTokens(look, 'dark'), themeTokens(look, 'light')]) for (const n of Object.keys(t)) names.add(n);
    }
    expect(names.size).toBeGreaterThan(15);
    for (const n of names) expect(rootRule, n).toHaveProperty(n);
  });

  it('only sets values that are plain colors or numbers', () => {
    for (const look of everyLook) {
      for (const t of [sharedTokens(look), themeTokens(look, 'dark'), themeTokens(look, 'light')]) {
        for (const [n, v] of Object.entries(t)) expect(v, n).toMatch(/^(#[0-9a-f]{6}|\d+(\.\d+)?)$/);
      }
    }
  });
});

describe('accent presets', () => {
  it('lead with the default', () => {
    expect(ACCENTS[0]).toEqual({ name: 'Pink', value: DEFAULT_ACCENT });
  });

  it('are distinct, named, valid colors', () => {
    expect(new Set(ACCENTS.map((a) => a.value)).size).toBe(ACCENTS.length);
    expect(new Set(ACCENTS.map((a) => a.name)).size).toBe(ACCENTS.length);
    for (const a of ACCENTS) expect(parseHex(a.value)).toBe(a.value);
  });

  it('names a preset or calls the color Custom', () => {
    expect(accentName('#00b2ff')).toBe('Sky');
    expect(accentName('#00B2FF')).toBe('Sky');
    expect(accentName('#123456')).toBe('Custom');
  });
});

describe('corners', () => {
  it('scales from tight to round around the standard', () => {
    expect(CORNERS.map((c) => c.id)).toEqual(['sharp', 'standard', 'round']);
    expect(cornerScale('standard')).toBe(1);
    expect(cornerScale('sharp')).toBeLessThan(1);
    expect(cornerScale('round')).toBeGreaterThan(1);
  });

  it('matches the stylesheet default', () => {
    expect(rootRule['--rs']).toBe(String(cornerScale('standard')));
  });
});
