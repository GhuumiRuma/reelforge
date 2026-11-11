import { describe, expect, it } from 'vitest';
import { ACCENTS, DEFAULT_LOOK, STYLES, STYLE_IDS, cornerScale } from '../state/appearance';
import type { Look } from '../state/appearance';
import { THEME_COLORS } from '../state/theme';
import type { Theme } from '../state/theme';
import { contrast } from '../test/contrast';
import { TIMELINE_PALETTES, timelinePalette } from './timelineTheme';

const themes: Theme[] = ['dark', 'light'];

describe.each(themes)('%s timeline palette', (theme) => {
  const pal = TIMELINE_PALETTES[theme];
  // The canvas is transparent over the page background.
  const stage = THEME_COLORS[theme];
  const audio = Object.entries(pal.audio);

  it('keeps clip labels readable', () => {
    expect(contrast(pal.text.ink, pal.text.fill)).toBeGreaterThanOrEqual(4.5);
    for (const [role, t] of audio) expect(contrast(t.ink, t.fill), role).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps waveforms visible on their clip', () => {
    for (const [role, t] of audio) expect(contrast(t.wave, t.fill), role).toBeGreaterThanOrEqual(3);
  });

  it('keeps ruler labels and add hints readable', () => {
    expect(contrast(pal.dim, stage)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(pal.dim, pal.raised)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the playhead and selection visible', () => {
    expect(contrast(pal.playhead, stage)).toBeGreaterThanOrEqual(3);
    expect(contrast(pal.accent, stage)).toBeGreaterThanOrEqual(3);
    expect(contrast(pal.grip, pal.accent)).toBeGreaterThanOrEqual(3);
  });

  it('keeps transition markers legible', () => {
    const m = pal.marker;
    expect(contrast(m.ink, m.fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(m.onInk, m.onFill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(m.stroke, stage)).toBeGreaterThanOrEqual(1.5);
  });
});

describe('the default look', () => {
  it.each(themes)('draws with the %s palette above as it is', (theme) => {
    expect(timelinePalette(theme, DEFAULT_LOOK)).toBe(TIMELINE_PALETTES[theme]);
    expect(TIMELINE_PALETTES[theme].rs).toBe(1);
    expect(TIMELINE_PALETTES[theme].grip).toBe('#fff');
  });

  it.each(themes)('has the ticks, clip color and ruler text of the %s Standard style', (theme) => {
    // The Standard style is what the other styles' canvas colors are measured against.
    const std = STYLES.standard[theme];
    const pal = TIMELINE_PALETTES[theme];
    expect(pal.tick).toBe(std.tick);
    expect(pal.raised).toBe(std.clip);
    expect(pal.dim).toBe(std.dim);
  });
});

describe('timelinePalette', () => {
  const look: Look = { style: 'warm', accent: '#00b2ff', corners: 'round' };

  it('keeps the derived palette until the theme or look changes', () => {
    const pal = timelinePalette('dark', look);
    expect(timelinePalette('dark', { ...look })).toBe(pal);
    expect(timelinePalette('light', look)).not.toBe(pal);
    expect(timelinePalette('dark', { ...look, accent: '#ff8a00' })).not.toBe(pal);
  });

  it.each(themes)('scales corners with the Corners setting in the %s theme', (theme) => {
    for (const corners of ['sharp', 'standard', 'round'] as const) {
      expect(timelinePalette(theme, { ...DEFAULT_LOOK, corners }).rs).toBe(cornerScale(corners));
    }
    expect(cornerScale('sharp')).toBeLessThan(1);
    expect(cornerScale('round')).toBeGreaterThan(1);
  });

  it.each(themes)('changes only the accent in the Standard style with another accent (%s)', (theme) => {
    const base = TIMELINE_PALETTES[theme];
    const pal = timelinePalette(theme, { ...DEFAULT_LOOK, accent: '#00b2ff' });
    expect(pal.accent).not.toBe(base.accent);
    expect({ ...pal, accent: base.accent, grip: base.grip }).toEqual(base);
  });

  it.each(themes)('takes its ruler, clip, playhead and marker colors from the style (%s)', (theme) => {
    for (const style of STYLE_IDS.filter((s) => s !== 'standard')) {
      const p = STYLES[style][theme];
      const pal = timelinePalette(theme, { ...DEFAULT_LOOK, style });
      expect(pal.dim, style).toBe(p.dim);
      expect(pal.raised, style).toBe(p.clip);
      expect(pal.tick, style).toBe(p.tick);
      expect(pal.playhead, style).toBe(p.text);
      expect(pal.marker.fill, style).toBe(p.raised2);
      expect(pal.drop, style).toBe(p.text);
    }
  });

  it('leaves the clip tints and the halo alone in every style', () => {
    for (const theme of themes) {
      const base = TIMELINE_PALETTES[theme];
      for (const style of STYLE_IDS) {
        const pal = timelinePalette(theme, { ...DEFAULT_LOOK, style });
        expect(pal.text, style).toEqual(base.text);
        expect(pal.audio, style).toEqual(base.audio);
        expect(pal.playheadHalo, style).toBe(base.playheadHalo);
        expect(pal.dropShadow, style).toBe(base.dropShadow);
      }
    }
  });
});

// Presets plus colors that are hard to read text on, or hard to see on a dark or a light page.
const accents = [
  ...ACCENTS.map((a) => a.value),
  '#000000',
  '#ffffff',
  '#808080',
  '#ffff00',
  '#0000ff',
  '#00ff00',
  '#ff00ff',
  '#123456',
];

describe.each(STYLE_IDS)('%s style timeline palette', (style) => {
  const min = STYLES[style].minContrast;

  describe.each(themes)('%s', (theme) => {
    // The canvas is transparent over the page, so the style's own background is what it is drawn on.
    const stage = STYLES[style][theme].stage;

    it('stays legible for every accent', () => {
      for (const accent of accents) {
        const pal = timelinePalette(theme, { style, accent, corners: 'standard' });
        const why = (what: string) => `${what} with ${accent}`;
        expect(contrast(pal.accent, stage), why('accent on stage')).toBeGreaterThanOrEqual(min);
        expect(contrast(pal.accent, pal.raised), why('selection outline on clip')).toBeGreaterThanOrEqual(3);
        expect(contrast(pal.grip, pal.accent), why('handle grips')).toBeGreaterThanOrEqual(3);
        expect(contrast(pal.dim, stage), why('ruler text')).toBeGreaterThanOrEqual(min);
        expect(contrast(pal.dim, pal.raised), why('hint text')).toBeGreaterThanOrEqual(min);
        expect(contrast(pal.playhead, stage), why('playhead')).toBeGreaterThanOrEqual(3);
        expect(contrast(pal.drop, stage), why('drop bar')).toBeGreaterThanOrEqual(3);
      }
    });

    it('keeps clip labels, waveforms and transition markers legible', () => {
      const pal = timelinePalette(theme, { style, accent: '#ff3d6e', corners: 'standard' });
      expect(contrast(pal.text.ink, pal.text.fill)).toBeGreaterThanOrEqual(min);
      for (const [role, t] of Object.entries(pal.audio)) {
        expect(contrast(t.ink, t.fill), role).toBeGreaterThanOrEqual(min);
        expect(contrast(t.wave, t.fill), role).toBeGreaterThanOrEqual(3);
      }
      const m = pal.marker;
      expect(contrast(m.ink, m.fill)).toBeGreaterThanOrEqual(min);
      expect(contrast(m.onInk, m.onFill)).toBeGreaterThanOrEqual(min);
      expect(contrast(m.stroke, stage)).toBeGreaterThanOrEqual(1.5);
    });
  });
});
