import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast } from '../test/contrast';
import { DEFAULT_PREF, parsePref, resolveTheme, THEME_COLORS } from './theme';

// Vitest blanks CSS imports, so read the stylesheet as plain text.
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const LIGHT = ":root[data-theme='light']";

/** The declarations in the rule whose selector is exactly `selector`. */
function declarations(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  if (!rule) throw new Error(`No rule for ${selector}`);
  const out: Record<string, string> = {};
  for (const m of rule[1].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const dark = declarations(':root');
const lightOverrides = declarations(LIGHT);
const light = { ...dark, ...lightOverrides };

describe('parsePref', () => {
  it('accepts the three saved values', () => {
    expect(parsePref('light')).toBe('light');
    expect(parsePref('dark')).toBe('dark');
    expect(parsePref('system')).toBe('system');
  });

  it('falls back to the default for anything else', () => {
    for (const raw of [null, undefined, '', 'auto', 'Dark', ' light']) expect(parsePref(raw)).toBe(DEFAULT_PREF);
  });
});

describe('resolveTheme', () => {
  it('follows the device only for System', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
  });

  it('ignores the device for an explicit choice', () => {
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
  });
});

describe('stylesheet tokens', () => {
  it('matches the browser chrome colors to each theme background', () => {
    expect(THEME_COLORS.dark).toBe(dark['--stage']);
    expect(THEME_COLORS.light).toBe(light['--stage']);
  });

  it('only overrides tokens that the dark base declares', () => {
    expect(Object.keys(lightOverrides).filter((k) => !(k in dark))).toEqual([]);
  });

  it('restyles the whole palette in light', () => {
    for (const k of ['--stage', '--panel', '--raised', '--raised-2', '--line', '--text', '--dim', '--accent']) {
      expect(light[k], k).not.toBe(dark[k]);
    }
  });
});

describe.each([
  ['dark', dark],
  ['light', light],
])('%s theme contrast', (_name, t) => {
  it.each(['--stage', '--panel', '--raised', '--raised-2', '--toast-bg', '--seg-on'])('keeps text readable on %s', (surface) => {
    expect(contrast(t['--text'], t[surface])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['--stage', '--panel', '--raised', '--raised-2'])('keeps secondary text readable on %s', (surface) => {
    expect(contrast(t['--dim'], t[surface])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['--stage', '--panel', '--raised'])('keeps accent text readable on %s', (surface) => {
    expect(contrast(t['--accent'], t[surface])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps white text readable on accent buttons', () => {
    expect(contrast('#ffffff', t['--accent-fill'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', t['--accent-press'])).toBeGreaterThanOrEqual(4.5);
  });
});

describe('light theme switch', () => {
  // A switch has no border, so its off track is all that shows its edge and where the thumb is (WCAG 1.4.11: 3:1).
  const thumb = declarations('.switch::after').background;

  it('draws the off track from --switch-off on the sheet', () => {
    expect(declarations('.switch').background).toBe('var(--switch-off)');
    expect(declarations('.sheet').background).toBe('var(--panel)');
  });

  it.each([
    ['the thumb', thumb],
    ['the sheet', light['--panel']],
  ])('keeps the off track 3:1 clear of %s', (_what, color) => {
    expect(color).toMatch(/^#[\da-f]{3}(?:[\da-f]{3})?$/i);
    expect(contrast(light['--switch-off'], color)).toBeGreaterThanOrEqual(3);
  });
});

describe('colors that sit on fixed dark surfaces', () => {
  const tile = declarations('.preset-tile').background;

  it('are the same in both themes', () => {
    for (const k of ['--accent-bright', '--on-media-dim', '--on-media-text']) expect(lightOverrides).not.toHaveProperty(k);
  });

  it.each(['#000000', tile])('stay readable on %s', (surface) => {
    expect(contrast(dark['--on-media-dim'], surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark['--on-media-text'], surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('are used for the text preset tile labels', () => {
    expect(declarations('.preset-tile small').color).toBe('var(--on-media-dim)');
    expect(declarations(".preset-tile[aria-pressed='true'] small").color).toBe('var(--on-media-text)');
  });
});
