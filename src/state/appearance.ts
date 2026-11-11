import { fromHsl, luminance, nearestLightness, parseHex, ratio, toHsl } from '../lib/color';
import type { Theme } from './theme';

/**
 * The look of the app beyond light or dark: a surface style, an accent color and the corner roundness.
 *
 * Everything here is pure. theme.ts saves the choice, writes lookCss() into a <style id="rf-look"> element and
 * keeps a copy of that CSS in storage so the inline script in index.html can apply it before the first paint.
 * The Timeline canvas can't read CSS, so ui/timelineTheme.ts derives its colors from the same data.
 *
 * styles.css holds the default look. A look only ever adds overrides on top of it, and the default look adds none,
 * so an untouched install is exactly the stylesheet. STYLES.standard repeats the stylesheet's palette and
 * appearance.test.ts checks the two agree.
 */

export type StyleId = 'standard' | 'pure' | 'warm' | 'slate' | 'contrast';
export type CornersId = 'sharp' | 'standard' | 'round';

export interface Look {
  style: StyleId;
  /** The user's pick as #rrggbb. What the app shows is adjusted for readability, see accentSet(). */
  accent: string;
  corners: CornersId;
}

/** The colors of one style in one theme, named for the custom properties they set. */
export interface Surfaces {
  stage: string;
  panel: string;
  raised: string;
  raised2: string;
  line: string;
  text: string;
  dim: string;
  dialog: string;
  toast: string;
  toastLine: string;
  segOn: string;
  /** A switch's off track. It has no border, so in light it must reach 3:1 against the white thumb and `panel`. */
  switchOff: string;
  mark: string;
  /** The Timeline canvas only: ruler ticks, and a clip's background until its thumbnails load. */
  tick: string;
  clip: string;
}

export interface StyleDef {
  id: StyleId;
  name: string;
  blurb: string;
  /** The contrast ratio text, dim text and the accent must reach on the surfaces. AA is 4.5, AAA is 7. */
  minContrast: number;
  dark: Surfaces;
  light: Surfaces;
}

export const STYLES: Record<StyleId, StyleDef> = {
  standard: {
    id: 'standard',
    name: 'Standard',
    blurb: 'The ReelForge look.',
    minContrast: 4.5,
    dark: {
      stage: '#0b0b0f',
      panel: '#16161d',
      raised: '#1d1d26',
      raised2: '#262632',
      line: '#262631',
      text: '#f4f4f7',
      dim: '#9a9aa8',
      dialog: '#1d1d26',
      toast: '#262632',
      toastLine: '#33333f',
      segOn: '#34343f',
      switchOff: '#3a3a48',
      mark: '#5a5a6a',
      tick: '#4a4a58',
      clip: '#1d1d26',
    },
    light: {
      stage: '#f4f4f8',
      panel: '#ffffff',
      raised: '#e8e8ee',
      raised2: '#dcdce5',
      line: '#dcdce4',
      text: '#14141a',
      dim: '#5f5f6c',
      dialog: '#ffffff',
      toast: '#ffffff',
      toastLine: '#d4d4de',
      segOn: '#ffffff',
      switchOff: '#8a8a9b',
      mark: '#9090a2',
      tick: '#a0a0b0',
      clip: '#e2e2ea',
    },
  },
  pure: {
    id: 'pure',
    name: 'Pure',
    blurb: 'True black and neutral grays, with no color tint.',
    minContrast: 4.5,
    dark: {
      stage: '#000000',
      panel: '#0a0a0a',
      raised: '#151515',
      raised2: '#202020',
      line: '#1f1f1f',
      text: '#f5f5f5',
      dim: '#a0a0a0',
      dialog: '#151515',
      toast: '#202020',
      toastLine: '#303030',
      segOn: '#2c2c2c',
      switchOff: '#363636',
      mark: '#555555',
      tick: '#444444',
      clip: '#151515',
    },
    light: {
      stage: '#f5f5f5',
      panel: '#ffffff',
      raised: '#ececec',
      raised2: '#dedede',
      line: '#dedede',
      text: '#111111',
      dim: '#5c5c5c',
      dialog: '#ffffff',
      toast: '#ffffff',
      toastLine: '#d6d6d6',
      segOn: '#ffffff',
      switchOff: '#8a8a8a',
      mark: '#919191',
      tick: '#a0a0a0',
      clip: '#e4e4e4',
    },
  },
  warm: {
    id: 'warm',
    name: 'Warm',
    blurb: 'Soft, paper-like tones.',
    minContrast: 4.5,
    dark: {
      stage: '#12100d',
      panel: '#1c1915',
      raised: '#26221c',
      raised2: '#312c24',
      line: '#2e2a23',
      text: '#f5efe6',
      dim: '#aca396',
      dialog: '#26221c',
      toast: '#312c24',
      toastLine: '#443d33',
      segOn: '#3d372d',
      switchOff: '#463f34',
      mark: '#675e50',
      tick: '#575045',
      clip: '#26221c',
    },
    light: {
      stage: '#f6f0e6',
      panel: '#fffaf2',
      raised: '#ebe3d6',
      raised2: '#e0d6c5',
      line: '#e0d6c5',
      text: '#2a2118',
      dim: '#645849',
      dialog: '#fffaf2',
      toast: '#fffaf2',
      toastLine: '#d9cfbe',
      segOn: '#fffaf2',
      switchOff: '#95866a',
      mark: '#9a8f7d',
      tick: '#aa9f8c',
      clip: '#e6dccb',
    },
  },
  slate: {
    id: 'slate',
    name: 'Slate',
    blurb: 'Cool blue-gray tones.',
    minContrast: 4.5,
    dark: {
      stage: '#0a0e15',
      panel: '#121a26',
      raised: '#1a2433',
      raised2: '#243044',
      line: '#222d3f',
      text: '#eef3fa',
      dim: '#a4b1c6',
      dialog: '#1a2433',
      toast: '#243044',
      toastLine: '#33415a',
      segOn: '#31405a',
      switchOff: '#3b4a63',
      mark: '#58677f',
      tick: '#475670',
      clip: '#1a2433',
    },
    light: {
      stage: '#e9eef5',
      panel: '#f9fbfe',
      raised: '#dde5ef',
      raised2: '#cfd9e6',
      line: '#cfd9e6',
      text: '#0f1825',
      dim: '#4a586e',
      dialog: '#f9fbfe',
      toast: '#f9fbfe',
      toastLine: '#c4d0e0',
      segOn: '#f9fbfe',
      switchOff: '#7589a8',
      mark: '#8696ae',
      tick: '#98a8c0',
      clip: '#d6e0ec',
    },
  },
  contrast: {
    id: 'contrast',
    name: 'High contrast',
    blurb: 'The strongest text contrast, with clear borders.',
    minContrast: 7,
    dark: {
      stage: '#000000',
      panel: '#000000',
      raised: '#101010',
      raised2: '#1c1c1c',
      line: '#8a8a8a',
      text: '#ffffff',
      dim: '#d0d0d0',
      dialog: '#101010',
      toast: '#1c1c1c',
      toastLine: '#8a8a8a',
      segOn: '#383838',
      switchOff: '#5c5c5c',
      mark: '#8a8a8a',
      tick: '#8a8a8a',
      clip: '#101010',
    },
    light: {
      stage: '#ffffff',
      panel: '#ffffff',
      raised: '#efefef',
      raised2: '#e0e0e0',
      line: '#595959',
      text: '#000000',
      dim: '#3a3a3a',
      dialog: '#ffffff',
      toast: '#ffffff',
      toastLine: '#595959',
      segOn: '#ffffff',
      switchOff: '#767676',
      mark: '#595959',
      tick: '#767676',
      clip: '#efefef',
    },
  },
};

export const STYLE_IDS: StyleId[] = ['standard', 'pure', 'warm', 'slate', 'contrast'];

/** The custom property each surface color sets. tick and clip are canvas-only and have none. */
export const SURFACE_TOKENS: Record<Exclude<keyof Surfaces, 'tick' | 'clip'>, string> = {
  stage: '--stage',
  panel: '--panel',
  raised: '--raised',
  raised2: '--raised-2',
  line: '--line',
  text: '--text',
  dim: '--dim',
  dialog: '--dialog-bg',
  toast: '--toast-bg',
  toastLine: '--toast-line',
  segOn: '--seg-on',
  switchOff: '--switch-off',
  mark: '--mark',
};

/** Corner roundness multiplies every corner radius from 5px up (styles.css reads it as --rs). */
export const CORNERS: { id: CornersId; name: string; scale: number }[] = [
  { id: 'sharp', name: 'Sharp', scale: 0.25 },
  { id: 'standard', name: 'Standard', scale: 1 },
  { id: 'round', name: 'Round', scale: 1.5 },
];

export const cornerScale = (id: CornersId): number => CORNERS.find((c) => c.id === id)?.scale ?? 1;

export const DEFAULT_ACCENT = '#ff3d6e';

export const ACCENTS: { name: string; value: string }[] = [
  { name: 'Pink', value: DEFAULT_ACCENT },
  { name: 'Red', value: '#ff453a' },
  { name: 'Orange', value: '#ff8a00' },
  { name: 'Amber', value: '#ffc400' },
  { name: 'Lime', value: '#9be000' },
  { name: 'Green', value: '#34d058' },
  { name: 'Mint', value: '#33c98a' },
  { name: 'Teal', value: '#00c7be' },
  { name: 'Sky', value: '#00b2ff' },
  { name: 'Blue', value: '#3f6bff' },
  { name: 'Indigo', value: '#6a5cff' },
  { name: 'Violet', value: '#a67cff' },
  { name: 'Magenta', value: '#f03ed2' },
  { name: 'Copper', value: '#c98350' },
  { name: 'Graphite', value: '#8e8e93' },
];

export const accentName = (hex: string): string => ACCENTS.find((a) => a.value === hex.toLowerCase())?.name ?? 'Custom';

export const DEFAULT_LOOK: Look = { style: 'standard', accent: DEFAULT_ACCENT, corners: 'standard' };

export const isDefaultLook = (l: Look): boolean =>
  l.style === DEFAULT_LOOK.style && l.accent === DEFAULT_LOOK.accent && l.corners === DEFAULT_LOOK.corners;

const isStyleId = (v: unknown): v is StyleId => STYLE_IDS.includes(v as StyleId);
const isCornersId = (v: unknown): v is CornersId => CORNERS.some((c) => c.id === v);

/** The saved look. Anything missing, malformed or unknown falls back to the default, one field at a time. */
export function parseLook(raw: string | null | undefined): Look {
  const base = { ...DEFAULT_LOOK };
  if (!raw) return base;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return base;
  }
  if (typeof data !== 'object' || data === null || (data as { v?: unknown }).v !== 1) return base;
  const o = data as Record<string, unknown>;
  return {
    style: isStyleId(o.style) ? o.style : base.style,
    accent: parseHex(o.accent) ?? base.accent,
    corners: isCornersId(o.corners) ? o.corners : base.corners,
  };
}

/** `patch` laid over `base`, ignoring any value that isn't valid. */
export function mergeLook(base: Look, patch: Partial<Look>): Look {
  return {
    style: isStyleId(patch.style) ? patch.style : base.style,
    accent: parseHex(patch.accent) ?? base.accent,
    corners: isCornersId(patch.corners) ? patch.corners : base.corners,
  };
}

/**
 * What goes in storage: the choice, plus the CSS and page colors it produces. index.html can't run this module
 * before the first paint, so it applies the saved CSS as it is. parseLook ignores the extras and the app
 * rebuilds them from the choice at startup.
 */
export function serializeLook(look: Look): string {
  return JSON.stringify({
    v: 1,
    ...look,
    css: lookCss(look),
    bg: { dark: lookBackground(look, 'dark'), light: lookBackground(look, 'light') },
  });
}

/** The page background (--stage) of a look, which also tints the browser's own chrome. */
export const lookBackground = (look: Look, theme: Theme): string => STYLES[look.style][theme].stage;

// ---------------------------------------------------------------------------
// Accent

/** The stylesheet's pink. The derivation starts from it, so the default accent keeps its hand-tuned shades. */
const PINK = {
  accent: { dark: '#ff3d6e', light: '#ca1250' } satisfies Record<Theme, string>,
  fill: '#e0245e',
  press: '#c81e52',
};

/** --inverse in each theme: the recording button turns into a disc of this color. styles.css has the same values. */
export const INVERSE: Record<Theme, string> = { dark: '#ffffff', light: '#17171d' };

const WHITE = '#ffffff';
const INK = '#0b0b0f';
/** Luminance from which a pick counts as bright: oranges, yellows, greens and cyans, but not reds, blues or violets. */
const BRIGHT = 0.33;

/** The accent as the app uses it in one style and theme. Every color is derived so it can't be unreadable. */
export interface AccentSet {
  /** Text, outlines and bars on the surfaces: at least the style's contrast on stage, panel, raised and dialog. */
  accent: string;
  /** Background of filled buttons, which show up against the surfaces (3:1). */
  fill: string;
  press: string;
  /** Text and icons on the fill, at least the style's contrast. White or near-black. */
  onAccent: string;
  /** The accent where the recording button sits on --inverse (3:1). */
  onInverse: string;
}

/** A test that a color's luminance reaches `min` contrast against every surface. */
const reaches = (min: number, surfaces: string[]) => {
  const ls = surfaces.map(luminance);
  return (l: number) => ls.every((s) => ratio(l, s) >= min);
};

/** Text-sized uses want the style's contrast; shapes like slider fills and dots need 3:1. */
function accentOnSurfaces(def: StyleDef, theme: Theme): (c: string) => boolean {
  const p = def[theme];
  const asText = reaches(def.minContrast, [p.stage, p.panel, p.raised, p.dialog]);
  const asShape = reaches(3, [p.raised2, p.toast, p.segOn]);
  return (c) => {
    const l = luminance(c);
    return asText(l) && asShape(l);
  };
}

/**
 * Keeps the hue and saturation the user picked and moves only the lightness, as little as it takes.
 * The fill is white-texted or ink-texted, whichever needs the smaller change, and always shows against the page.
 */
export function accentSet(style: StyleId, accent: string, theme: Theme): AccentSet {
  const def = STYLES[style];
  const p = def[theme];
  const min = def.minContrast;
  const isPink = accent === DEFAULT_ACCENT;
  const seed = isPink ? PINK.accent[theme] : accent;
  const fillSeed = isPink ? PINK.fill : accent;

  const main = nearestLightness(seed, accentOnSurfaces(def, theme))?.color ?? p.text;

  const visible = reaches(3, [p.stage, p.panel, p.raised, p.dialog]);
  const lInk = luminance(INK);
  const withWhite = nearestLightness(fillSeed, (c) => {
    const l = luminance(c);
    return ratio(l, 1) >= min && visible(l);
  });
  const withInk = nearestLightness(fillSeed, (c) => {
    const l = luminance(c);
    return ratio(l, lInk) >= min && visible(l);
  });
  let fill: string;
  let onAccent: string;
  // White text is how the default looks, so keep it unless the pick is bright enough to carry dark text as it is.
  const darkText = withInk && (!withWhite || (luminance(fillSeed) >= BRIGHT && Math.abs(withInk.shift) <= 0.05));
  if (darkText) {
    fill = withInk.color;
    onAccent = INK;
  } else if (withWhite) {
    fill = withWhite.color;
    onAccent = WHITE;
  } else {
    // No hue of the pick works, so use the text color, which every surface already contrasts with.
    fill = p.text;
    onAccent = p.stage;
  }

  const onInverse = reaches(3, [INVERSE[theme]]);
  return {
    accent: main,
    fill,
    press: pressed(fill, onAccent, min),
    onAccent,
    onInverse: nearestLightness(fillSeed, (c) => onInverse(luminance(c)))?.color ?? fillSeed,
  };
}

/** The pressed fill: a step darker under white text, lighter under ink, unless that costs the text its contrast. */
function pressed(fill: string, on: string, min: number): string {
  if (fill === PINK.fill) return PINK.press;
  const [h, s, l] = toHsl(fill);
  const next = fromHsl([h, s, Math.min(1, Math.max(0, l + (on === WHITE ? -0.06 : 0.06)))]);
  return ratio(luminance(next), luminance(on)) >= min ? next : fill;
}

/** The accent for the selection box over video, which is always on black. Not tied to the theme. */
export function brightAccent(style: StyleId, accent: string): string {
  const onBlack = reaches(STYLES[style].minContrast, ['#000000']);
  return nearestLightness(accent, (c) => onBlack(luminance(c)))?.color ?? WHITE;
}

/**
 * Errors and destructive actions keep a red-pink of their own, so choosing a green accent doesn't turn a
 * delete button green. The default style keeps the stylesheet's pink; the others get that pink adjusted to
 * their surfaces.
 */
export function dangerFor(style: StyleId, theme: Theme): string {
  const def = STYLES[style];
  return nearestLightness(PINK.accent[theme], accentOnSurfaces(def, theme))?.color ?? def[theme].text;
}

// ---------------------------------------------------------------------------
// CSS

type Tokens = Record<string, string>;

/** The custom properties a look sets for one theme. Empty when the stylesheet's own values already apply. */
export function themeTokens(look: Look, theme: Theme): Tokens {
  const out: Tokens = {};
  if (look.style !== 'standard') {
    const p = STYLES[look.style][theme];
    for (const [key, name] of Object.entries(SURFACE_TOKENS)) out[name] = p[key as keyof typeof SURFACE_TOKENS];
    out['--danger'] = dangerFor(look.style, theme);
  }
  if (look.style !== 'standard' || look.accent !== DEFAULT_ACCENT) {
    const a = accentSet(look.style, look.accent, theme);
    out['--accent'] = a.accent;
    out['--accent-fill'] = a.fill;
    out['--accent-press'] = a.press;
    out['--on-accent'] = a.onAccent;
    out['--accent-on-inverse'] = a.onInverse;
  }
  return out;
}

/** Properties that are the same in both themes. */
export function sharedTokens(look: Look): Tokens {
  const out: Tokens = {};
  const scale = cornerScale(look.corners);
  if (scale !== 1) out['--rs'] = String(scale);
  const bright = brightAccent(look.style, look.accent);
  if (bright !== DEFAULT_ACCENT) out['--accent-bright'] = bright;
  return out;
}

const rule = (selector: string, tokens: Tokens): string => {
  const body = Object.entries(tokens)
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
  return body ? `${selector}{${body}}` : '';
};

/**
 * The look as CSS. The selectors out-rank the stylesheet's `:root` and `:root[data-theme='light']`, so this
 * works wherever the element goes. Only letters, digits and `#.,:;{}'[]=-` and spaces are used; index.html
 * checks for that before applying saved CSS it didn't build itself. Empty for the default look.
 */
export function lookCss(look: Look): string {
  if (isDefaultLook(look)) return '';
  return [
    rule('html:root', sharedTokens(look)),
    rule("html:root[data-theme='dark']", themeTokens(look, 'dark')),
    rule("html:root[data-theme='light']", themeTokens(look, 'light')),
  ]
    .filter(Boolean)
    .join('\n');
}
