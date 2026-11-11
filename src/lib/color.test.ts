import { describe, expect, it } from 'vitest';
import { contrast, fromHsl, luminance, nearestLightness, parseHex, ratio, toHex, toHsl, toRgb } from './color';

describe('parseHex', () => {
  it('accepts #rrggbb in either case and returns it lowercase', () => {
    expect(parseHex('#ff3d6e')).toBe('#ff3d6e');
    expect(parseHex('#FF3D6E')).toBe('#ff3d6e');
    expect(parseHex('#00aAfF')).toBe('#00aaff');
  });

  it('rejects anything else', () => {
    for (const raw of ['#fff', 'ff3d6e', '#ff3d6', '#ff3d6ee', '#gg3d6e', ' #ff3d6e', '#ff3d6e ', 'pink', '', null, undefined, 255, {}, []]) {
      expect(parseHex(raw), String(raw)).toBeNull();
    }
  });
});

describe('toRgb and toHex', () => {
  it('reads long and short forms', () => {
    expect(toRgb('#ff3d6e')).toEqual([255, 61, 110]);
    expect(toRgb('#fff')).toEqual([255, 255, 255]);
    expect(toRgb('#0a8')).toEqual([0, 170, 136]);
  });

  it('writes lowercase, rounding and clamping each channel', () => {
    expect(toHex([255, 61, 110])).toBe('#ff3d6e');
    expect(toHex([0.4, 254.6, 300])).toBe('#00ffff');
    expect(toHex([-20, 5, 16])).toBe('#000510');
  });
});

describe('HSL conversion', () => {
  it('round-trips colors', () => {
    for (const hex of ['#ff3d6e', '#00b2ff', '#34d058', '#a67cff', '#8e8e93', '#000000', '#ffffff', '#ca1250', '#0b0b0f', '#ffc400']) {
      expect(fromHsl(toHsl(hex)), hex).toBe(hex);
    }
  });

  it('reports grays as unsaturated', () => {
    expect(toHsl('#808080')[1]).toBe(0);
    expect(toHsl('#000000')).toEqual([0, 0, 0]);
    expect(toHsl('#ffffff')).toEqual([0, 0, 1]);
  });

  it('reads the primaries', () => {
    expect(toHsl('#ff0000')).toEqual([0, 1, 0.5]);
    expect(toHsl('#00ff00')).toEqual([120, 1, 0.5]);
    expect(toHsl('#0000ff')).toEqual([240, 1, 0.5]);
  });

  it('wraps hues outside 0-360', () => {
    expect(fromHsl([360, 1, 0.5])).toBe('#ff0000');
    expect(fromHsl([-120, 1, 0.5])).toBe('#0000ff');
    expect(fromHsl([-90, 0.7, 0.4])).toBe(fromHsl([270, 0.7, 0.4]));
    expect(fromHsl([750, 0.7, 0.4])).toBe(fromHsl([30, 0.7, 0.4]));
  });
});

describe('luminance and contrast', () => {
  it('puts black at 0 and white at 1', () => {
    expect(luminance('#000000')).toBe(0);
    expect(luminance('#ffffff')).toBeCloseTo(1, 10);
  });

  it('gives the WCAG ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#336699', '#336699')).toBe(1);
    // The best-known gray that passes AA on white, and the one just under it.
    expect(contrast('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#777777', '#ffffff')).toBeLessThan(4.5);
  });

  it('does not depend on the order', () => {
    expect(contrast('#ff3d6e', '#0b0b0f')).toBe(contrast('#0b0b0f', '#ff3d6e'));
  });

  it('matches the ratio of the two luminances', () => {
    expect(ratio(luminance('#ff3d6e'), luminance('#0b0b0f'))).toBe(contrast('#ff3d6e', '#0b0b0f'));
  });
});

describe('nearestLightness', () => {
  const onWhite = (c: string) => contrast(c, '#ffffff') >= 4.5;

  it('keeps a color that already qualifies', () => {
    expect(nearestLightness('#336699', onWhite)).toEqual({ color: '#336699', shift: 0 });
  });

  it('darkens a color that is too light, keeping its hue and saturation', () => {
    const r = nearestLightness('#ff3d6e', onWhite);
    expect(r).not.toBeNull();
    expect(onWhite(r!.color)).toBe(true);
    expect(r!.shift).toBeLessThan(0);
    const [h0, s0] = toHsl('#ff3d6e');
    const [h, s] = toHsl(r!.color);
    expect(Math.abs(h - h0)).toBeLessThan(2);
    expect(Math.abs(s - s0)).toBeLessThan(0.05);
  });

  it('lightens a color that is too dark', () => {
    const onBlack = (c: string) => contrast(c, '#000000') >= 7;
    const r = nearestLightness('#1a2b6e', onBlack);
    expect(r).not.toBeNull();
    expect(onBlack(r!.color)).toBe(true);
    expect(r!.shift).toBeGreaterThan(0);
  });

  it('moves no further than it has to', () => {
    const r = nearestLightness('#ff3d6e', onWhite)!;
    const [h, s, l0] = toHsl('#ff3d6e');
    let best = Infinity;
    for (let l = 0; l <= 1; l += 0.0005) if (onWhite(fromHsl([h, s, l]))) best = Math.min(best, Math.abs(l - l0));
    expect(Math.abs(r.shift)).toBeLessThanOrEqual(best + 0.003);
  });

  it('gives up when nothing qualifies', () => {
    expect(nearestLightness('#ff3d6e', () => false)).toBeNull();
    expect(nearestLightness('#808080', (c) => contrast(c, '#ffffff') > 21)).toBeNull();
  });

  it('works on grays and the extremes', () => {
    expect(nearestLightness('#000000', (c) => contrast(c, '#000000') >= 7)?.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(nearestLightness('#ffffff', onWhite)?.color).toMatch(/^#[0-9a-f]{6}$/);
  });
});
