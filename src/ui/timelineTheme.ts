import type { AudioItem } from '../types';
import type { Theme } from '../state/theme';
import { STYLES, accentSet, cornerScale, isDefaultLook } from '../state/appearance';
import type { Look } from '../state/appearance';
import { ratio, luminance } from '../lib/color';

/**
 * The timeline is drawn on a canvas, which can't read the stylesheet's colors, so each theme has its
 * own palette here. Dark is the original look; light pairs pale clip fills with dark ink.
 * timelinePalette() starts from these and applies the user's look (surface style, accent, corners).
 */
interface Tint {
  fill: string;
  ink: string;
}

export interface TimelinePalette {
  /** selection outline and handles, the keyframe at the playhead */
  accent: string;
  /** the grip lines on the accent-colored handles */
  grip: string;
  /** ruler labels and the add-text / add-audio hints */
  dim: string;
  /** a clip's background until its thumbnails load, and the hint chips */
  raised: string;
  /** the small ticks between ruler labels */
  tick: string;
  playhead: string;
  playheadHalo: string;
  text: Tint;
  audio: Record<AudioItem['role'], Tint & { wave: string }>;
  /** the transition button between two clips */
  marker: { fill: string; stroke: string; ink: string; onFill: string; onInk: string };
  /** the drop bar and dragged clip outline while reordering */
  drop: string;
  dropShadow: string;
  /** the Corners setting, which multiplies the larger corner radii as it does in styles.css */
  rs: number;
}

export const TIMELINE_PALETTES: Record<Theme, TimelinePalette> = {
  dark: {
    accent: '#ff3d6e',
    grip: '#fff',
    dim: '#9a9aa8',
    raised: '#1d1d26',
    tick: '#4a4a58',
    playhead: '#fff',
    playheadHalo: 'rgba(0, 0, 0, 0.35)',
    text: { fill: '#3a2a12', ink: '#ffd89a' },
    audio: {
      music: { fill: '#12304a', ink: '#a9d8ff', wave: '#3f9cff' },
      voice: { fill: '#0f3a2b', ink: '#9ff0c8', wave: '#33c98a' },
      sfx: { fill: '#33204a', ink: '#dcc2ff', wave: '#a67cff' },
      extracted: { fill: '#2c2c3a', ink: '#d0d0e0', wave: '#8d8da3' },
    },
    marker: { fill: '#262632', stroke: '#4a4a58', ink: '#fff', onFill: '#fff', onInk: '#16161d' },
    drop: '#fff',
    dropShadow: 'rgba(0, 0, 0, 0.6)',
    rs: 1,
  },
  light: {
    accent: '#ca1250',
    grip: '#fff',
    dim: '#5f5f6c',
    raised: '#e2e2ea',
    tick: '#a0a0b0',
    playhead: '#14141a',
    playheadHalo: 'rgba(255, 255, 255, 0.7)',
    text: { fill: '#f7d9a3', ink: '#4d3000' },
    audio: {
      music: { fill: '#bcdcf7', ink: '#0b3a63', wave: '#1f6fb8' },
      voice: { fill: '#b5e8d0', ink: '#07472f', wave: '#17825a' },
      sfx: { fill: '#dac8f7', ink: '#3d1f73', wave: '#7648c9' },
      extracted: { fill: '#d0d0dc', ink: '#2e2e3c', wave: '#6a6a82' },
    },
    marker: { fill: '#fff', stroke: '#9a9aab', ink: '#14141a', onFill: '#14141a', onInk: '#fff' },
    drop: '#14141a',
    dropShadow: 'rgba(20, 20, 40, 0.35)',
    rs: 1,
  },
};

/** White lines on the handles, or near-black ones when the accent is too bright for white to show. */
const gripFor = (accent: string): string => (ratio(luminance(accent), 1) >= 3 ? '#ffffff' : '#0b0b0f');

function derive(theme: Theme, look: Look): TimelinePalette {
  const base = TIMELINE_PALETTES[theme];
  const accent = accentSet(look.style, look.accent, theme).accent;
  const pal: TimelinePalette = { ...base, accent, grip: gripFor(accent), rs: cornerScale(look.corners) };
  if (look.style === 'standard') return pal;
  // The tints of text and audio clips, and the halo and shadow, suit every style. The rest follow its surfaces.
  const p = STYLES[look.style][theme];
  return {
    ...pal,
    dim: p.dim,
    raised: p.clip,
    tick: p.tick,
    playhead: p.text,
    marker: { fill: p.raised2, stroke: p.tick, ink: p.text, onFill: p.text, onInk: p.panel },
    drop: p.text,
  };
}

let last: { key: string; pal: TimelinePalette } | null = null;

/**
 * The palette for a theme and look. The default look gets the palettes above as they are. The timeline asks
 * for this on every frame, so the last derived palette is kept until the theme or look changes.
 */
export function timelinePalette(theme: Theme, look: Look): TimelinePalette {
  if (isDefaultLook(look)) return TIMELINE_PALETTES[theme];
  const key = `${theme}|${look.style}|${look.accent}|${look.corners}`;
  if (last?.key !== key) last = { key, pal: derive(theme, look) };
  return last.pal;
}
