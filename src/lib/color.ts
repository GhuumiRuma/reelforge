/** Color math for the appearance options: parsing, WCAG contrast and a lightness search. Pure, so it is unit-tested. */

export type RGB = [number, number, number];
/** hue 0-360, saturation 0-1, lightness 0-1 */
export type HSL = [number, number, number];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A strict `#rrggbb` (any case) as lowercase, or null for anything else: short forms, names, stray spaces. */
export function parseHex(raw: unknown): string | null {
  return typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : null;
}

/** The 0-255 channels of `#rgb` or `#rrggbb`. */
export function toRgb(hex: string): RGB {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.replace(/./g, '$&$&');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(rgb: RGB): string {
  return '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

export function toHsl(hex: string): HSL {
  const [r, g, b] = toRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

export function fromHsl([hue, s, l]: HSL): string {
  const h = ((hue % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][Math.floor(h / 60)];
  return toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

const linear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance: 0 for black, 1 for white. */
export function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio from two relative luminances, from 1 to 21. */
export function ratio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** WCAG 2 contrast ratio between two opaque hex colors, from 1 to 21. */
export function contrast(a: string, b: string): number {
  return ratio(luminance(a), luminance(b));
}

const STEPS = 500;

/**
 * Keeps the hue and saturation of `hex` and moves its lightness the least it takes for `ok` to hold, so a color
 * the user picked stays recognizably theirs. `shift` is how far the lightness moved (positive is lighter).
 * Null when no lightness qualifies.
 */
export function nearestLightness(hex: string, ok: (candidate: string) => boolean): { color: string; shift: number } | null {
  if (ok(hex)) return { color: hex, shift: 0 };
  const [h, s, l0] = toHsl(hex);
  for (let i = 1; i <= STEPS; i++) {
    const d = i / STEPS;
    for (const l of [l0 - d, l0 + d]) {
      if (l < 0 || l > 1) continue;
      const color = fromHsl([h, s, l]);
      if (ok(color)) return { color, shift: l - l0 };
    }
  }
  return null;
}
