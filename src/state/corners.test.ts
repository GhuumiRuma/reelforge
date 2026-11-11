import { describe, expect, it } from 'vitest';
import { CORNERS, cornerScale } from './appearance';
import { declarations, stylesheet } from '../test/css';

// The Corners option works by multiplying radii by --rs. A radius that is left as a plain number would stay put
// while everything around it changes, so this keeps new CSS honest.

const bare = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');

/** Radii below this stay as they are: they are hairlines and nubs, not corners. */
const SCALED_FROM = 5;

/** A selector that must keep its radius whatever the Corners option says. */
const FIXED = new Set(['.switch']);

const SCALED = /calc\(\s*(\d+(?:\.\d+)?)px\s*\*\s*var\(--rs\)\s*\)/g;

interface Radius {
  selector: string;
  property: string;
  value: string;
}

function radii(): Radius[] {
  const found: Radius[] = [];
  for (const rule of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim().replace(/\s+/g, ' ');
    for (const d of rule[2].matchAll(/([\w-]*radius)\s*:\s*([^;]+)/g)) {
      found.push({ selector, property: d[1], value: d[2].trim() });
    }
  }
  return found;
}

describe('the stylesheet corners', () => {
  const all = radii();

  it('has radii to check, and a scale that starts at 1', () => {
    expect(all.length).toBeGreaterThan(30);
    expect(declarations(':root')['--rs']).toBe('1');
  });

  it('scales every radius from 5px up, except the ones that must stay fixed', () => {
    const unscaled: string[] = [];
    for (const { selector, property, value } of all) {
      if (FIXED.has(selector)) continue;
      // What is left once the scaled radii are taken out must be zero, a percentage or a small fixed px value.
      const rest = value.replace(SCALED, ' ').trim();
      for (const token of rest.split(/\s+/).filter(Boolean)) {
        const px = /^(\d+(?:\.\d+)?)px$/.exec(token);
        const fine = token === '0' || /^\d+(?:\.\d+)?%$/.test(token) || (px !== null && Number(px[1]) < SCALED_FROM);
        if (!fine) unscaled.push(`${selector} { ${property}: ${value} }`);
      }
    }
    expect(unscaled).toEqual([]);
  });

  it('only scales from 5px up, so the small ones stay small', () => {
    const small: string[] = [];
    for (const { selector, property, value } of all) {
      for (const m of value.matchAll(SCALED)) {
        if (Number(m[1]) < SCALED_FROM) small.push(`${selector} { ${property}: ${value} }`);
      }
    }
    expect(small).toEqual([]);
  });

  it('leaves the switch a pill', () => {
    const sw = all.filter((r) => r.selector === '.switch' && r.property === 'border-radius');
    expect(sw).toHaveLength(1);
    expect(sw[0].value).toBe('14px');
    expect(declarations('.switch').height).toBe('28px');
  });

  it('only ever reads --rs through calc, never raw', () => {
    const raw = bare.match(/var\(--rs\)/g) ?? [];
    const inCalc = bare.match(SCALED) ?? [];
    expect(raw.length).toBe(inCalc.length);
  });

  it('keeps the scales the Corners option offers positive and ordered', () => {
    const [sharp, standard, round] = (['sharp', 'standard', 'round'] as const).map(cornerScale);
    expect(standard).toBe(1);
    expect(sharp).toBeGreaterThan(0);
    expect(sharp).toBeLessThan(standard);
    expect(round).toBeGreaterThan(standard);
    expect(CORNERS.map((c) => c.id)).toEqual(['sharp', 'standard', 'round']);
  });
});
