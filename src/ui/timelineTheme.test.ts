import { describe, expect, it } from 'vitest';
import { THEME_COLORS } from '../state/theme';
import type { Theme } from '../state/theme';
import { contrast } from '../test/contrast';
import { TIMELINE_PALETTES } from './timelineTheme';

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
    expect(contrast('#ffffff', pal.accent)).toBeGreaterThanOrEqual(3);
  });

  it('keeps transition markers legible', () => {
    const m = pal.marker;
    expect(contrast(m.ink, m.fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(m.onInk, m.onFill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(m.stroke, stage)).toBeGreaterThanOrEqual(1.5);
  });
});
